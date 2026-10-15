/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import { connectAndFinish, fakeXero } from '../test/fakeXero'
import type { Doc, Id } from './_generated/dataModel'

/**
 * Keeping a Xero sign-in usable (convex/xeroTokens.ts), with Xero faked
 * (test/fakeXero.ts).
 *
 * Xero's refresh token rotates on every use, so the one thing that must never
 * happen is two refreshes of one sign-in at once: the loser stores a token
 * Xero has already replaced, and every organisation on it needs reconnecting
 * half an hour later. Everything here is about that lease, about what a dead
 * sign-in does to the connections on it, and about the nightly keep-alive
 * that stops an idle one dying at 60 days.
 */

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup() {
  const t = testApp()
  const xero = fakeXero()
  xero.tenant({ tenantId: 'tenant-coastal', name: 'Coastal Pest Pty Ltd' })
  xero.tenant({ tenantId: 'tenant-north', name: 'Coastal Pest North' })
  xero.tenant({ tenantId: 'tenant-kevin', name: 'Kevin Walsh Pest Services' })
  xero.tenant({ tenantId: 'tenant-jo', name: 'Bloggs Pest Co' })

  const terence = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId } = await createBusiness(t, terence)
  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  await joinBusiness(t, terence, kevin, businessId, 'subcontractor')
  const jo = await createActor(t, { email: 'jo@coastal.test' })
  await joinBusiness(t, terence, jo, businessId, 'contractor')
  return { t, xero, businessId, terence, kevin, jo }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** Terence's business Xero, connected and finished. */
async function terencesXero(s: Setup) {
  await connectAndFinish(s.t, s.terence.as, {
    businessId: s.businessId,
    kind: 'business',
    xeroUserId: 'xu-terence',
    tenantId: 'tenant-coastal',
  })
  return only(s, 'tenant-coastal')
}

async function only(s: Setup, tenantId: string) {
  const rows = (
    await s.t.run((ctx) => ctx.db.query('xeroConnections').collect())
  ).filter((row) => row.tenantId === tenantId)
  expect(rows).toHaveLength(1)
  return rows[0]
}

const grantOf = (s: Setup, id: Id<'xeroGrants'>) =>
  s.t.run(async (ctx) => {
    const grant = await ctx.db.get(id)
    if (!grant) throw new Error('grant gone')
    return grant
  })

/** The access token has this long left (negative: lapsed). */
const leaveAccess = (s: Setup, id: Id<'xeroGrants'>, ms: number) =>
  s.t.run((ctx) => ctx.db.patch(id, { accessExpiresAt: Date.now() + ms }))

/** A grant row with placeholder ciphertexts, for the lease mutations, which
 * move ciphertexts and never open them. */
const bareGrant = (
  s: Setup,
  extra: Partial<Doc<'xeroGrants'>> = {},
): Promise<Id<'xeroGrants'>> =>
  s.t.run((ctx) =>
    ctx.db.insert('xeroGrants', {
      xeroUserId: 'xu-bare',
      accessCipher: 'x1.1.access.cipher',
      accessExpiresAt: Date.now() + 30 * MINUTE,
      refreshCipher: 'x1.1.refresh.cipher',
      scopes: ['offline_access'],
      refreshedAt: Date.now(),
      status: 'active',
      ...extra,
    }),
  )

const fetchOrganisation = (s: Setup, connectionId: Id<'xeroConnections'>) =>
  s.t.action(internal.xero.fetchOrganisation, { connectionId })

const bearers = (s: Setup) =>
  s.xero.organisationReads().map((r) => r.headers.authorization)

describe('using an access token', () => {
  test('a fresh one is used as it is: no refresh', async () => {
    const s = await setup()
    const connection = await terencesXero(s)
    expect(s.xero.refreshRequests()).toEqual([])

    await fetchOrganisation(s, connection._id)
    expect(s.xero.refreshRequests()).toEqual([])
    const [first, second] = bearers(s)
    expect(second).toBe(first)
  })

  test('one about to lapse is refreshed first; both new tokens are sealed and the rotated one is the one kept', async () => {
    const s = await setup()
    const connection = await terencesXero(s)
    const before = await grantOf(s, connection.grantId)

    // Under five minutes left counts as lapsed: it could die mid-call.
    await leaveAccess(s, connection.grantId, 4 * MINUTE)
    await fetchOrganisation(s, connection._id)
    expect(s.xero.refreshed).toEqual([{ xeroUserId: 'xu-terence' }])
    const [, afterRefresh] = bearers(s)
    expect(afterRefresh).not.toBe(bearers(s)[0])

    const after = await grantOf(s, connection.grantId)
    expect(after.accessCipher).not.toBe(before.accessCipher)
    expect(after.refreshCipher).not.toBe(before.refreshCipher)
    expect(after.accessCipher).toMatch(/^x1\.1\./)
    expect(after.refreshLease).toBeUndefined()
    expect(after.accessExpiresAt).toBe(Date.now() + 30 * MINUTE)

    // Past Xero's 30-minute grace for the replaced refresh token, only the
    // rotated one works — so a second refresh succeeding proves it was kept.
    vi.advanceTimersByTime(31 * MINUTE)
    await fetchOrganisation(s, connection._id)
    expect(s.xero.refreshed).toHaveLength(2)
    expect((await grantOf(s, connection.grantId)).status).toBe('active')
    expect(bearers(s)).toHaveLength(3)
  })

  test('two callers needing a fresh token at once refresh it once', async () => {
    const s = await setup()
    const connection = await terencesXero(s)
    // The wait for someone else's refresh is a real 2 s timer.
    vi.useRealTimers()
    await leaveAccess(s, connection.grantId, -1000)
    const readsBefore = bearers(s).length

    const held = s.xero.holdRefreshes()
    const first = fetchOrganisation(s, connection._id)
    // The first holds the lease and is at Xero now…
    await held.arrived
    const second = fetchOrganisation(s, connection._id)
    // …and the second finds it taken and waits on it.
    await new Promise((resolve) => setTimeout(resolve, 300))
    held.release()
    await Promise.all([first, second])

    expect(s.xero.refreshRequests()).toHaveLength(1)
    // Both read the organisation, with the one new token.
    const reads = bearers(s).slice(readsBefore)
    expect(reads).toHaveLength(2)
    expect(reads[1]).toBe(reads[0])
    expect(reads[0]).not.toBe(bearers(s)[0])
    const grant = await grantOf(s, connection.grantId)
    expect(grant.refreshLease).toBeUndefined()
  }, 30_000)
})

describe('a sign-in Xero no longer accepts', () => {
  test('is marked dead, and every live connection on it needs reconnecting', async () => {
    const s = await setup()
    const coastal = await terencesXero(s)
    // The same Xero login connected to a second business of Terence's.
    const north = await createBusiness(s.t, s.terence, 'Coastal Pest North')
    await connectAndFinish(s.t, s.terence.as, {
      businessId: north.businessId,
      kind: 'business',
      xeroUserId: 'xu-terence',
      tenantId: 'tenant-north',
    })
    const northern = await only(s, 'tenant-north')
    expect(northern.grantId).toBe(coastal.grantId)
    // An old, already disconnected row on the same sign-in.
    const oldId = await s.t.run((ctx) =>
      ctx.db.insert('xeroConnections', {
        ...withoutSystemFields(coastal),
        tenantId: 'tenant-old',
        xeroConnectionId: 'old-connection',
        status: 'disconnected',
        disconnectReason: 'by_hand',
      }),
    )

    s.xero.knobs.failRefresh = 'invalid_grant'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await s.t.action(internal.xeroTokens.refreshGrant, {
      grantId: coastal.grantId,
    })

    const grant = await grantOf(s, coastal.grantId)
    expect(grant.status).toBe('dead')
    expect(grant.deadAt).toBeTypeOf('number')
    expect(grant.refreshLease).toBeUndefined()
    for (const tenantId of ['tenant-coastal', 'tenant-north']) {
      expect(await only(s, tenantId)).toMatchObject({
        status: 'needs_reconnect',
        problem: { code: 'reconnect', at: Date.now() },
      })
    }
    const old = await s.t.run((ctx) => ctx.db.get(oldId))
    expect(old?.status).toBe('disconnected')

    // The page says so.
    const status = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(status.business).toMatchObject({
      status: 'needs_reconnect',
      problem: { code: 'reconnect' },
    })

    // And nothing asks Xero again with a token it has refused.
    const asked = s.xero.refreshRequests().length
    await fetchOrganisation(s, coastal._id)
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(s.xero.refreshRequests()).toHaveLength(asked)
  })

  test('Xero being down is not that: the lease is handed back and the sign-in kept', async () => {
    const s = await setup()
    const connection = await terencesXero(s)
    const before = await grantOf(s, connection.grantId)

    s.xero.knobs.failRefresh = 'server'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await s.t.action(internal.xeroTokens.refreshGrant, {
      grantId: connection.grantId,
    })

    const after = await grantOf(s, connection.grantId)
    expect(after.status).toBe('active')
    expect(after.refreshLease).toBeUndefined()
    expect(after.refreshCipher).toBe(before.refreshCipher)
    expect(after.refreshedAt).toBe(before.refreshedAt)
    expect((await only(s, 'tenant-coastal')).status).toBe('connected')
  })
})

describe('the refresh lease', () => {
  test('one holder at a time; a lease past its minute is taken over', async () => {
    const s = await setup()
    const grantId = await bareGrant(s)

    const first = await s.t.mutation(internal.xeroTokens.claimRefresh, {
      grantId,
      holder: 'first',
    })
    expect(first).toEqual({
      claimed: true,
      refreshCipher: 'x1.1.refresh.cipher',
      xeroUserId: 'xu-bare',
    })
    expect(
      await s.t.mutation(internal.xeroTokens.claimRefresh, {
        grantId,
        holder: 'second',
      }),
    ).toEqual({ claimed: false, reason: 'busy' })

    // The first died mid-refresh; a minute on, its lease is anyone's.
    vi.advanceTimersByTime(61_000)
    expect(
      await s.t.mutation(internal.xeroTokens.claimRefresh, {
        grantId,
        holder: 'second',
      }),
    ).toMatchObject({ claimed: true })

    // What the first brings back late is not kept, and it cannot let go of
    // a lease it no longer has.
    expect(
      await s.t.mutation(internal.xeroTokens.storeRefreshed, {
        grantId,
        holder: 'first',
        accessCipher: 'x1.1.stale.access',
        accessExpiresAt: Date.now() + 30 * MINUTE,
        refreshCipher: 'x1.1.stale.refresh',
        scopes: [],
      }),
    ).toEqual({ stored: false })
    await s.t.mutation(internal.xeroTokens.releaseRefresh, {
      grantId,
      holder: 'first',
    })
    const grant = await grantOf(s, grantId)
    expect(grant.refreshCipher).toBe('x1.1.refresh.cipher')
    expect(grant.refreshLease?.holder).toBe('second')

    // The holder's is kept, and the lease ends with it.
    expect(
      await s.t.mutation(internal.xeroTokens.storeRefreshed, {
        grantId,
        holder: 'second',
        accessCipher: 'x1.1.new.access',
        accessExpiresAt: Date.now() + 30 * MINUTE,
        refreshCipher: 'x1.1.new.refresh',
        scopes: ['offline_access'],
      }),
    ).toEqual({ stored: true })
    expect(await grantOf(s, grantId)).toMatchObject({
      refreshCipher: 'x1.1.new.refresh',
      refreshedAt: Date.now(),
    })
    expect((await grantOf(s, grantId)).refreshLease).toBeUndefined()
  })

  test('a dead or missing sign-in is not refreshed', async () => {
    const s = await setup()
    const dead = await bareGrant(s, { status: 'dead', deadAt: Date.now() })
    expect(
      await s.t.mutation(internal.xeroTokens.claimRefresh, {
        grantId: dead,
        holder: 'h',
      }),
    ).toEqual({ claimed: false, reason: 'dead' })

    const gone = await bareGrant(s)
    await s.t.run((ctx) => ctx.db.delete(gone))
    expect(
      await s.t.mutation(internal.xeroTokens.claimRefresh, {
        grantId: gone,
        holder: 'h',
      }),
    ).toEqual({ claimed: false, reason: 'gone' })
  })

  test('a new consent landing mid-refresh wins over the refresh', async () => {
    const s = await setup()
    const grantId = await bareGrant(s)
    await s.t.mutation(internal.xeroTokens.claimRefresh, {
      grantId,
      holder: 'refresher',
    })

    // The callback's tokens for the same Xero login.
    await s.t.mutation(internal.xero.keepGrant, {
      xeroUserId: 'xu-bare',
      accessCipher: 'x1.1.consent.access',
      accessExpiresAt: Date.now() + 30 * MINUTE,
      refreshCipher: 'x1.1.consent.refresh',
      scopes: ['offline_access'],
    })
    expect(
      await s.t.mutation(internal.xeroTokens.storeRefreshed, {
        grantId,
        holder: 'refresher',
        accessCipher: 'x1.1.late.access',
        accessExpiresAt: Date.now() + 30 * MINUTE,
        refreshCipher: 'x1.1.late.refresh',
        scopes: [],
      }),
    ).toEqual({ stored: false })
    expect((await grantOf(s, grantId)).refreshCipher).toBe(
      'x1.1.consent.refresh',
    )
  })
})

describe('the nightly keep-alive', () => {
  test('refreshes only live sign-ins idle for more than thirty days', async () => {
    const s = await setup()
    const terences = await terencesXero(s)
    await connectAndFinish(s.t, s.kevin.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: 'xu-kevin',
      tenantId: 'tenant-kevin',
    })
    const kevins = await only(s, 'tenant-kevin')
    await connectAndFinish(s.t, s.jo.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: 'xu-jo',
      tenantId: 'tenant-jo',
    })
    const jos = await only(s, 'tenant-jo')

    const now = Date.now()
    await s.t.run(async (ctx) => {
      await ctx.db.patch(terences.grantId, { refreshedAt: now - 31 * DAY })
      await ctx.db.patch(kevins.grantId, { refreshedAt: now - 29 * DAY })
      await ctx.db.patch(jos.grantId, {
        refreshedAt: now - 40 * DAY,
        status: 'dead',
        deadAt: now - 10 * DAY,
      })
    })

    await s.t.mutation(internal.xeroTokens.keepAlive, {})
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(s.xero.refreshed).toEqual([{ xeroUserId: 'xu-terence' }])
    expect(
      (await grantOf(s, terences.grantId)).refreshedAt,
    ).toBeGreaterThanOrEqual(now)
    expect((await grantOf(s, kevins.grantId)).refreshedAt).toBe(now - 29 * DAY)
  })

  test('a sign-in no live connection uses is retired, not kept alive', async () => {
    const s = await setup()
    const terences = await terencesXero(s)
    await connectAndFinish(s.t, s.kevin.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: 'xu-kevin',
      tenantId: 'tenant-kevin',
    })
    const kevins = await only(s, 'tenant-kevin')

    // Kevin's connection was disconnected, and the release at Xero never
    // got as far as his sign-in (it gave up, or died between its calls).
    const now = Date.now()
    await s.t.run(async (ctx) => {
      await ctx.db.patch(kevins._id, {
        status: 'disconnected',
        disconnectReason: 'offboarded',
        disconnectedAt: now - 31 * DAY,
      })
      await ctx.db.patch(kevins.grantId, { refreshedAt: now - 31 * DAY })
      await ctx.db.patch(terences.grantId, { refreshedAt: now - 31 * DAY })
    })

    await s.t.mutation(internal.xeroTokens.keepAlive, {})
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)

    // Terence's, in use, refreshed; Kevin's revoked at Xero and forgotten.
    expect(s.xero.refreshed).toEqual([{ xeroUserId: 'xu-terence' }])
    expect(s.xero.revoked).toEqual([{ xeroUserId: 'xu-kevin' }])
    expect(s.xero.connectedAtXero('xu-kevin')).toEqual([])
    expect(await s.t.run((ctx) => ctx.db.get(kevins.grantId))).toBeNull()
    expect((await grantOf(s, terences.grantId)).status).toBe('active')
  })
})

describe('waiting on someone else’s refresh', () => {
  test('gives up with XERO_BUSY after three looks, without refreshing itself', async () => {
    const s = await setup()
    const connection = await terencesXero(s)
    // Lapsed, and someone else has held the lease for a while yet.
    await s.t.run((ctx) =>
      ctx.db.patch(connection.grantId, {
        accessExpiresAt: Date.now() - 1000,
        refreshLease: { holder: 'someone-else', until: Date.now() + 50_000 },
      }),
    )
    const logged: Array<string> = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line))
    })

    const refreshing = s.t.action(internal.xeroTokens.refreshGrant, {
      grantId: connection.grantId,
    })
    // Three waits of two seconds between four looks.
    for (let wait = 0; wait < 6; wait++) {
      await vi.advanceTimersByTimeAsync(2000)
    }
    await refreshing

    expect(logged).toEqual([
      `[xero] keep-alive for grant ${connection.grantId}: XERO_BUSY`,
    ])
    expect(s.xero.refreshRequests()).toEqual([])
    expect((await grantOf(s, connection.grantId)).refreshLease?.holder).toBe(
      'someone-else',
    )
  })
})

function withoutSystemFields(
  row: Doc<'xeroConnections'>,
): Omit<Doc<'xeroConnections'>, '_id' | '_creationTime'> {
  const { _id, _creationTime, ...rest } = row
  void _id
  void _creationTime
  return rest
}
