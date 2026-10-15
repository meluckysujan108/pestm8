/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, components, internal } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import {
  EXPECTED_SCOPES,
  TEST_REDIRECT_URI,
  TEST_SITE_URL,
  XERO_TEST_CLIENT_ID,
  XERO_TEST_CLIENT_SECRET,
  callbackLocation,
  connectVia,
  fakeXero,
  finishFrom,
  stateFrom,
  xeroCallback,
} from '../test/fakeXero'
import { hashInviteToken } from './lib/inviteTokens'
import { XERO_TERMS_VERSION } from './lib/xeroConfig'
import { DEMO_PLAN } from './demo/shared'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * Release 1 of Xero: connecting one (convex/xero.ts, convex/xeroCallback.ts),
 * with Xero faked (test/fakeXero.ts) and the clock stopped.
 *
 * The business: Terence owns Coastal Pest and connects its Xero. Jo is a
 * contractor and Kevin a subcontractor; each may connect their OWN Xero,
 * which then receives the client book too (decision of 2026-10-06). Nothing
 * here sends a contact — Release 1 only signs in, reads the organisation's
 * name, and lets go again.
 *
 * What matters most is who can attach which Xero to which business, that a
 * sign-in link or finish link works once for the one person who started it,
 * that refused connections are cleaned up at Xero without pulling one out
 * from under another business, and that no token is ever readable.
 */

const XU = {
  terence: 'xu-terence',
  kevin: 'xu-kevin',
  jo: 'xu-jo',
  mia: 'xu-mia',
} as const

const ORG = {
  coastal: 'tenant-coastal',
  north: 'tenant-north',
  kevin: 'tenant-kevin',
  jo: 'tenant-jo',
  harbour: 'tenant-harbour',
} as const

const MINUTE = 60_000
const HOUR = 60 * MINUTE

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(opts: { configured?: boolean } = {}) {
  const t = testApp()
  const xero = fakeXero({ configured: opts.configured ?? true })
  xero.tenant({
    tenantId: ORG.coastal,
    name: 'Coastal Pest Pty Ltd',
    shortCode: '!Kq7Rt',
  })
  xero.tenant({ tenantId: ORG.north, name: 'Coastal Pest North' })
  xero.tenant({ tenantId: ORG.kevin, name: 'Kevin Walsh Pest Services' })
  xero.tenant({ tenantId: ORG.jo, name: 'Bloggs Pest Co' })
  xero.tenant({ tenantId: ORG.harbour, name: 'Harbour Pest Pty Ltd' })

  const terence = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const kevin = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin Walsh',
  })
  const kevinId = await joinBusiness(
    t,
    terence,
    kevin,
    businessId,
    'subcontractor',
  )
  const jo = await createActor(t, {
    email: 'jo@coastal.test',
    name: 'Jo Bloggs',
  })
  const joId = await joinBusiness(t, terence, jo, businessId, 'contractor')

  return {
    t,
    xero,
    businessId,
    terence,
    ownerMembershipId,
    kevin,
    kevinId,
    jo,
    joId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** Runs whatever was scheduled: the organisation read, a release at Xero. */
const settle = (s: Setup) => s.t.finishAllScheduledFunctions(vi.runAllTimers)

/** Where the callback sends the browser back to, on Coastal Pest. */
function back(
  kind: 'business' | 'member',
  query: string,
  slug = 'coastal-pest',
): string {
  return `${TEST_SITE_URL}/${slug}/settings/${kind === 'business' ? 'xero' : 'my-xero'}?${query}`
}

const connectionsIn = (s: Setup, businessId: Id<'businesses'>) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query('xeroConnections').collect()).filter(
      (row) => row.businessId === businessId,
    ),
  )

const allConnections = (s: Setup) =>
  s.t.run((ctx) => ctx.db.query('xeroConnections').collect())

const grants = (s: Setup) =>
  s.t.run((ctx) => ctx.db.query('xeroGrants').collect())

const states = (s: Setup) =>
  s.t.run((ctx) => ctx.db.query('xeroOAuthStates').collect())

const connection = (s: Setup, id: Id<'xeroConnections'>) =>
  s.t.run(async (ctx) => {
    const row = await ctx.db.get(id)
    if (!row) throw new Error('connection gone')
    return row
  })

const audits = (s: Setup, action: string) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query('auditLog').collect()).filter(
      (row) => row.action === action,
    ),
  )

/** Everything the app keeps that a Xero secret could leak into. */
const everythingKept = (s: Setup) =>
  s.t.run(async (ctx) =>
    JSON.stringify({
      grants: await ctx.db.query('xeroGrants').collect(),
      states: await ctx.db.query('xeroOAuthStates').collect(),
      connections: await ctx.db.query('xeroConnections').collect(),
      audit: await ctx.db.query('auditLog').collect(),
      scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
    }),
  )

/** Connect Xero, all the way: sign in at Xero, back, finish, organisation
 * read. Returns the connected row. */
async function connected(
  s: Setup,
  who: TestActor,
  opts: {
    kind: 'business' | 'member'
    xeroUserId: string
    tenantId: string
    businessId?: Id<'businesses'>
  },
): Promise<Doc<'xeroConnections'>> {
  const businessId = opts.businessId ?? s.businessId
  const location = await connectVia(s.t, who.as, {
    businessId,
    kind: opts.kind,
    xeroUserId: opts.xeroUserId,
    tenantId: opts.tenantId,
  })
  await who.as.action(api.xero.finishConnect, {
    businessId,
    token: finishFrom(location),
  })
  await settle(s)
  const row = (await connectionsIn(s, businessId))
    .filter((r) => r.tenantId === opts.tenantId && r.status === 'connected')
    .at(-1)
  if (!row) throw new Error(`${opts.tenantId} did not connect: ${location}`)
  return row
}

/** A second business Terence also owns. */
async function northBusiness(s: Setup) {
  const { businessId } = await createBusiness(
    s.t,
    s.terence,
    'Coastal Pest North',
  )
  return businessId
}

const XERO_VIEW_KEYS = [
  'connectedAt',
  'connectedByName',
  'connectionId',
  'disconnectReason',
  'kind',
  // How matching its contacts stands (Release 2, convex/xeroMatch.test.ts).
  'match',
  'problem',
  'shortCode',
  'status',
  // How sending to it stands (Release 3, convex/xeroSync.test.ts): counts,
  // times and the names of clients with a problem — never a token.
  'sync',
  'syncStartedAt',
  'tenantName',
]

// ─────────────────────────────────────────────────────────────── happy path

describe('connecting the business’s Xero', () => {
  test('asks Xero for exactly what it needs, keeps only a hash of the link, and finishes connected', async () => {
    const s = await setup()

    const { url } = await s.terence.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'business',
    })
    const authorise = new URL(url)
    expect(`${authorise.origin}${authorise.pathname}`).toBe(
      'https://login.xero.com/identity/connect/authorize',
    )
    expect(authorise.searchParams.get('response_type')).toBe('code')
    expect(authorise.searchParams.get('client_id')).toBe(XERO_TEST_CLIENT_ID)
    expect(authorise.searchParams.get('redirect_uri')).toBe(TEST_REDIRECT_URI)
    expect(authorise.searchParams.get('scope')).toBe(EXPECTED_SCOPES)
    const state = stateFrom(url)
    expect(state.length).toBeGreaterThanOrEqual(40)

    // Only the state's hash is kept, bound to who pressed Connect.
    const [started] = await states(s)
    expect(started).toMatchObject({
      stateHash: await hashInviteToken(state),
      userId: s.terence.userId,
      membershipId: s.ownerMembershipId,
      businessId: s.businessId,
      kind: 'business',
      termsVersion: XERO_TERMS_VERSION,
    })
    expect(started.expiresAt - Date.now()).toBe(10 * MINUTE)
    expect(started.reconnectConnectionId).toBeUndefined()
    expect(await everythingKept(s)).not.toContain(state)
    // Nothing has gone to Xero yet: the browser goes there, not the server.
    expect(s.xero.requests).toEqual([])

    // Terence signs in to Xero and ticks Coastal Pest's organisation.
    const code = s.xero.consent({
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const res = await xeroCallback(s.t, { code, state })
    expect(res.status).toBe(302)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    const location = res.headers.get('Location') ?? ''
    expect(location.startsWith(back('business', 'finish='))).toBe(true)
    const token = finishFrom(location)

    // The code went back once, with the app's credentials and the identical
    // redirect URI — and the secret only ever in the Authorization header.
    const [exchange] = s.xero.exchanges()
    expect(s.xero.exchanges()).toHaveLength(1)
    expect(exchange.headers.authorization).toBe(
      `Basic ${btoa(`${XERO_TEST_CLIENT_ID}:${XERO_TEST_CLIENT_SECRET}`)}`,
    )
    expect(exchange.form).toMatchObject({
      grant_type: 'authorization_code',
      code,
      redirect_uri: TEST_REDIRECT_URI,
    })
    expect(exchange.body).not.toContain(XERO_TEST_CLIENT_SECRET)
    // Asked which organisations THIS sign-in connected.
    const [listed] = s.xero.connectionLists()
    expect(listed.query.get('authEventId')).toBeTruthy()
    expect(listed.headers.authorization).toMatch(/^Bearer /)

    // Pending until the app finishes it; the state is spent.
    const [pending] = await allConnections(s)
    expect(pending).toMatchObject({
      businessId: s.businessId,
      membershipId: s.ownerMembershipId,
      kind: 'business',
      tenantId: ORG.coastal,
      tenantName: 'Coastal Pest Pty Ltd',
      xeroConnectionId: s.xero.connectionIdOf(XU.terence, ORG.coastal),
      status: 'pending',
    })
    const [spent] = await states(s)
    expect(spent.usedAt).toBeTypeOf('number')
    expect(spent.finishHash).toBe(await hashInviteToken(token))
    expect(spent.finishExpiresAt! - Date.now()).toBe(15 * MINUTE)
    expect(spent.connectionId).toBe(pending._id)

    expect(
      await s.terence.as.action(api.xero.finishConnect, {
        businessId: s.businessId,
        token,
      }),
    ).toEqual({ tenantName: 'Coastal Pest Pty Ltd' })
    await settle(s)

    const row = await connection(s, pending._id)
    expect(row).toMatchObject({
      status: 'connected',
      termsVersion: XERO_TERMS_VERSION,
      shortCode: '!Kq7Rt',
      tenantName: 'Coastal Pest Pty Ltd',
    })
    expect(row.connectedAt).toBeTypeOf('number')
    expect(row.problem).toBeUndefined()

    // The organisation was read for its short code, as Xero requires.
    const [org] = s.xero.organisationReads()
    expect(s.xero.organisationReads()).toHaveLength(1)
    expect(org.headers['xero-tenant-id']).toBe(ORG.coastal)
    expect(org.headers.accept).toBe('application/json')
    expect(org.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)

    // One token set, for Terence's Xero login, encrypted.
    const [grant] = await grants(s)
    expect(await grants(s)).toHaveLength(1)
    expect(grant).toMatchObject({
      xeroUserId: XU.terence,
      status: 'active',
      scopes: EXPECTED_SCOPES.split(' '),
    })
    expect(grant.accessCipher).toMatch(/^x1\.1\./)
    expect(grant.refreshCipher).toMatch(/^x1\.1\./)
    expect(grant.refreshLease).toBeUndefined()

    // Settings sees it — and never a field of the grant.
    const status = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(status).toMatchObject({
      configured: true,
      paused: false,
      demo: false,
      switched: false,
      isOwner: true,
      timezone: 'Australia/Perth',
      mine: null,
      business: {
        connectionId: pending._id,
        kind: 'business',
        tenantName: 'Coastal Pest Pty Ltd',
        status: 'connected',
        connectedAt: row.connectedAt,
        connectedByName: 'Terence',
        problem: null,
        shortCode: '!Kq7Rt',
        disconnectReason: null,
      },
    })
    expect(Object.keys(status.business!).sort()).toEqual(XERO_VIEW_KEYS)

    // The record of what Terence agreed to, and that every client goes.
    const [line] = await audits(s, 'xero.connect')
    expect(line).toMatchObject({
      businessId: s.businessId,
      actorMembershipId: s.ownerMembershipId,
      entityType: 'xeroConnections',
      entityId: pending._id,
      meta: {
        tenantName: 'Coastal Pest Pty Ltd',
        kind: 'business',
        termsVersion: XERO_TERMS_VERSION,
        disclosure: 'whole_book_v1',
      },
    })

    // Sign-in and the organisation, nothing else: no contact goes in R1.
    expect(s.xero.unmodelled()).toEqual([])
  })

  test('takes the organisation’s current name from Xero once finished', async () => {
    const s = await setup()
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // Renamed in Xero between the callback and the organisation read.
    s.xero.tenant({ tenantId: ORG.coastal, name: 'Coastal Pest Control' })
    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
    await settle(s)

    const [row] = await allConnections(s)
    expect(row.tenantName).toBe('Coastal Pest Control')
  })
})

describe('connecting your own Xero', () => {
  test('a subcontractor connects theirs; the owner sees it read-only, and nobody else sees it', async () => {
    const s = await setup()
    const location = await connectVia(s.t, s.kevin.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })
    expect(location.startsWith(back('member', 'finish='))).toBe(true)
    await s.kevin.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
    await settle(s)

    const [row] = await allConnections(s)
    expect(row).toMatchObject({
      kind: 'member',
      membershipId: s.kevinId,
      tenantId: ORG.kevin,
      status: 'connected',
    })

    const kevins = await s.kevin.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(kevins).toMatchObject({
      configured: true,
      isOwner: false,
      business: null,
      mine: {
        connectionId: row._id,
        kind: 'member',
        status: 'connected',
        tenantName: 'Kevin Walsh Pest Services',
        connectedByName: 'Kevin Walsh',
      },
    })

    // The owner: not in his own status (he has no "My Xero")…
    const terences = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(terences.business).toBeNull()
    expect(terences.mine).toBeNull()
    // …but on Kevin's line in Team, read-only.
    expect(
      await s.terence.as.query(api.xero.memberStatus, {
        businessId: s.businessId,
        membershipId: s.kevinId,
      }),
    ).toMatchObject({
      status: 'connected',
      tenantName: 'Kevin Walsh Pest Services',
      connectedAt: row.connectedAt,
    })
    // Nobody else reads someone's Xero: not Kevin's own contractor, not Kevin.
    for (const who of [s.kevin, s.jo]) {
      await expect(
        who.as.query(api.xero.memberStatus, {
          businessId: s.businessId,
          membershipId: s.kevinId,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }
    const jos = await s.jo.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(jos.mine).toBeNull()
    expect(jos.business).toBeNull()

    const [line] = await audits(s, 'xero.connect')
    expect(line).toMatchObject({
      actorMembershipId: s.kevinId,
      meta: { kind: 'member', disclosure: 'whole_book_v1' },
    })
  })
})

// ───────────────────────────────────────────────────────────── secrets

describe('secrets', () => {
  test('no token, code or link is ever readable in the database, a scheduled job or a log line', async () => {
    const logged: Array<string> = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: Array<unknown>) => {
        logged.push(
          args
            .map((a) =>
              a instanceof Error
                ? `${a.message} ${a.stack}`
                : JSON.stringify(a),
            )
            .join(' '),
        )
      })
    }
    const s = await setup()
    const links: Array<string> = []

    // A connect, start to finish.
    const { url } = await s.terence.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'business',
    })
    links.push(stateFrom(url))
    const location = await callbackLocation(s.t, {
      code: s.xero.consent({ xeroUserId: XU.terence, tenantId: ORG.coastal }),
      state: stateFrom(url),
    })
    links.push(finishFrom(location))
    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
    await settle(s)
    const [before] = await grants(s)

    // A refresh, which rotates both tokens.
    await s.t.action(internal.xeroTokens.refreshGrant, { grantId: before._id })
    const [after] = await grants(s)
    expect(after.accessCipher).not.toBe(before.accessCipher)
    expect(after.refreshCipher).not.toBe(before.refreshCipher)

    // A sign-in that Xero refuses, which logs Xero's words.
    const { url: second } = await s.kevin.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'member',
    })
    links.push(stateFrom(second))
    const refused = await callbackLocation(s.t, {
      code: 'code-that-xero-never-issued',
      state: stateFrom(second),
    })
    expect(refused).toBe(back('member', 'xero=failed'))

    // And letting go of it all.
    const [row] = await allConnections(s)
    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: row._id,
    })
    await settle(s)

    const kept = await everythingKept(s)
    const secrets = [...s.xero.secrets(), ...links]
    expect(secrets.length).toBeGreaterThan(6)
    for (const secret of secrets) {
      expect(kept).not.toContain(secret)
      for (const line of logged) expect(line).not.toContain(secret)
    }
    // Ciphertexts stay on the grant: never a scheduler argument, never logged.
    const scheduled = await s.t.run(async (ctx) =>
      JSON.stringify(
        await ctx.db.system.query('_scheduled_functions').collect(),
      ),
    )
    for (const cipher of [
      before.accessCipher,
      before.refreshCipher,
      after.accessCipher,
      after.refreshCipher,
    ]) {
      expect(scheduled).not.toContain(cipher)
      for (const line of logged) expect(line).not.toContain(cipher)
    }
    for (const line of logged) {
      expect(line).not.toContain(XERO_TEST_CLIENT_SECRET)
      expect(line).not.toMatch(/Basic [A-Za-z0-9+/=]{20,}/)
      expect(line).not.toMatch(/Bearer [\w-]+\./)
    }
  })
})

// ─────────────────────────────────────────────────────── who may do what

describe('who may connect, finish and disconnect', () => {
  test('only the owner connects the business’s Xero', async () => {
    const s = await setup()
    for (const who of [s.kevin, s.jo]) {
      await expect(
        who.as.action(api.xero.startConnect, {
          businessId: s.businessId,
          kind: 'business',
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }
    expect(await states(s)).toEqual([])
  })

  test('the owner has no “My Xero”: his own Xero is the business’s', async () => {
    const s = await setup()
    await expect(
      s.terence.as.action(api.xero.startConnect, {
        businessId: s.businessId,
        kind: 'member',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    expect(await states(s)).toEqual([])
  })

  test('someone outside the business cannot start one there', async () => {
    const s = await setup()
    const mia = await createActor(s.t, { email: 'mia@harbour.test' })
    await createBusiness(s.t, mia, 'Harbour Pest')
    for (const kind of ['business', 'member'] as const) {
      await expect(
        mia.as.action(api.xero.startConnect, {
          businessId: s.businessId,
          kind,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }
  })

  test('not while the owner is working in someone else’s account: start, finish or disconnect', async () => {
    const s = await setup()
    const live = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // A finish link from before the switch.
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    await s.terence.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.kevinId,
    })

    // Not his business's Xero, and not Kevin's own as Kevin either.
    for (const kind of ['business', 'member'] as const) {
      await expect(
        s.terence.as.action(api.xero.startConnect, {
          businessId: s.businessId,
          kind,
        }),
      ).rejects.toThrow(/SWITCHED/)
    }
    await expect(
      s.terence.as.action(api.xero.finishConnect, {
        businessId: s.businessId,
        token: finishFrom(location),
      }),
    ).rejects.toThrow(/SWITCHED/)
    // Disconnect too, named as the switch rather than as a lack of access.
    await expect(
      s.terence.as.mutation(api.xero.disconnect, {
        businessId: s.businessId,
        connectionId: live._id,
      }),
    ).rejects.toThrow(/SWITCHED/)
    expect((await connection(s, live._id)).status).toBe('connected')

    // Back as himself, the same finish link still works.
    await s.terence.as.mutation(api.accountSwitches.stop, {
      businessId: s.businessId,
    })
    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
  })

  test('connecting needs two-step sign-in on: refused at the start, and at finish if it was turned off meanwhile', async () => {
    const s = await setup()
    const twoStep = async (actor: TestActor, on: boolean) => {
      await s.t.run(async (ctx) => {
        await ctx.runMutation(components.betterAuth.adapter.updateOne, {
          input: {
            model: 'user',
            where: [{ field: '_id', value: actor.userId }],
            update: { twoFactorEnabled: on },
          },
        })
      })
    }

    // Kevin has only a password: the page knows, and Connect is refused for
    // his own Xero — nothing reaches Xero, and no sign-in link is kept.
    await twoStep(s.kevin, false)
    const kevins = await s.kevin.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(kevins.twoStepOn).toBe(false)
    await expect(
      s.kevin.as.action(api.xero.startConnect, {
        businessId: s.businessId,
        kind: 'member',
      }),
    ).rejects.toThrow(/XERO_TWO_STEP_REQUIRED/)
    expect(
      await s.t.run((ctx) => ctx.db.query('xeroOAuthStates').collect()),
    ).toHaveLength(0)

    // Terence starts with it on, then turns it off while he is at Xero:
    // finishing is refused and nothing is connected.
    expect(
      (await s.terence.as.query(api.xero.status, { businessId: s.businessId }))
        .twoStepOn,
    ).toBe(true)
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await twoStep(s.terence, false)
    await expect(
      s.terence.as.action(api.xero.finishConnect, {
        businessId: s.businessId,
        token: finishFrom(location),
      }),
    ).rejects.toThrow(/XERO_TWO_STEP_REQUIRED/)
    const rows = await s.t.run((ctx) =>
      ctx.db.query('xeroConnections').collect(),
    )
    expect(rows.filter((row) => row.status === 'connected')).toHaveLength(0)

    // On again, the same finish link still works.
    await twoStep(s.terence, true)
    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
  })

  test('a finish link works only for whoever pressed Connect', async () => {
    const s = await setup()
    const owners = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // Sent to Kevin, it would attach Terence's Xero sign-in to Kevin.
    await expect(
      s.kevin.as.action(api.xero.finishConnect, {
        businessId: s.businessId,
        token: finishFrom(owners),
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    const kevins = await connectVia(s.t, s.kevin.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })
    for (const who of [s.jo, s.terence]) {
      await expect(
        who.as.action(api.xero.finishConnect, {
          businessId: s.businessId,
          token: finishFrom(kevins),
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }

    // Nothing was spent by the attempts.
    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(owners),
    })
    await s.kevin.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(kevins),
    })
    expect((await allConnections(s)).map((r) => r.status)).toEqual([
      'connected',
      'connected',
    ])
  })

  test('a finish link is for the business it was started in', async () => {
    const s = await setup()
    const north = await northBusiness(s)
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await expect(
      s.terence.as.action(api.xero.finishConnect, {
        businessId: north,
        token: finishFrom(location),
      }),
    ).rejects.toThrow(/FINISH_EXPIRED/)
  })

  test('finishing checks again that nobody here took the organisation meanwhile (TAKEN)', async () => {
    const s = await setup()
    const location = await connectVia(s.t, s.kevin.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })
    const [pending] = await allConnections(s)
    // The callback refuses a second holder while Kevin's is pending, so this
    // is the check behind that one: a live row on the same organisation,
    // however it got there, between Kevin's callback and his finish.
    await s.t.run((ctx) =>
      ctx.db.insert('xeroConnections', {
        businessId: s.businessId,
        membershipId: s.joId,
        kind: 'member',
        grantId: pending.grantId,
        tenantId: ORG.kevin,
        tenantName: 'Kevin Walsh Pest Services',
        xeroConnectionId: 'jo-on-kevins-organisation',
        status: 'connected',
        createdAt: Date.now(),
        connectedAt: Date.now(),
      }),
    )

    await expect(
      s.kevin.as.action(api.xero.finishConnect, {
        businessId: s.businessId,
        token: finishFrom(location),
      }),
    ).rejects.toThrow(/TAKEN/)
    expect((await connection(s, pending._id)).status).toBe('pending')
    expect(await audits(s, 'xero.connect')).toEqual([])
  })

  test('only the holder disconnects, and only in its own business', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const kevins = await connected(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })

    for (const who of [s.kevin, s.jo]) {
      await expect(
        who.as.mutation(api.xero.disconnect, {
          businessId: s.businessId,
          connectionId: business._id,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }
    // Kevin's own Xero is his to let go of, not the owner's.
    for (const who of [s.terence, s.jo]) {
      await expect(
        who.as.mutation(api.xero.disconnect, {
          businessId: s.businessId,
          connectionId: kevins._id,
        }),
      ).rejects.toThrow(/NO_ACCESS/)
    }

    // Another business's owner, naming this connection from their own.
    const mia = await createActor(s.t, { email: 'mia@harbour.test' })
    const harbour = await createBusiness(s.t, mia, 'Harbour Pest')
    await expect(
      mia.as.mutation(api.xero.disconnect, {
        businessId: harbour.businessId,
        connectionId: business._id,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
    // And Terence, naming Harbour's from his.
    const theirs = await connected(s, mia, {
      kind: 'business',
      xeroUserId: XU.mia,
      tenantId: ORG.harbour,
      businessId: harbour.businessId,
    })
    await expect(
      s.terence.as.mutation(api.xero.disconnect, {
        businessId: s.businessId,
        connectionId: theirs._id,
      }),
    ).rejects.toThrow(/NOT_FOUND/)

    for (const row of await allConnections(s)) {
      expect(row.status).toBe('connected')
    }
    expect(s.xero.deleteRequests()).toEqual([])
  })

  test('the business’s Xero is the owner’s to see', async () => {
    const s = await setup()
    await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    for (const who of [s.kevin, s.jo]) {
      const status = await who.as.query(api.xero.status, {
        businessId: s.businessId,
      })
      expect(status.configured).toBe(true)
      expect(status.business).toBeNull()
      expect(status.mine).toBeNull()
    }
  })
})

// ──────────────────────────────────────────────────────────────── replays

describe('replays', () => {
  test('a sign-in link works once', async () => {
    const s = await setup()
    const { url } = await s.terence.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'business',
    })
    const state = stateFrom(url)
    const first = await callbackLocation(s.t, {
      code: s.xero.consent({ xeroUserId: XU.terence, tenantId: ORG.coastal }),
      state,
    })
    expect(first.startsWith(back('business', 'finish='))).toBe(true)

    const again = await callbackLocation(s.t, {
      code: s.xero.consent({ xeroUserId: XU.terence, tenantId: ORG.coastal }),
      state,
    })
    expect(again).toBe(`${TEST_SITE_URL}/`)
    // The second code was never exchanged.
    expect(s.xero.exchanges()).toHaveLength(1)
    expect(await allConnections(s)).toHaveLength(1)
  })

  test('a sign-in link expires after ten minutes at Xero', async () => {
    const s = await setup()
    const { url } = await s.terence.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'business',
    })
    vi.advanceTimersByTime(10 * MINUTE + 1000)

    const location = await callbackLocation(s.t, {
      code: s.xero.consent({ xeroUserId: XU.terence, tenantId: ORG.coastal }),
      state: stateFrom(url),
    })
    expect(location).toBe(back('business', 'xero=expired'))
    expect(s.xero.exchanges()).toEqual([])
    expect(await allConnections(s)).toEqual([])
    // And it is spent: the next try does not even say "expired".
    expect(
      await callbackLocation(s.t, {
        code: s.xero.consent({ xeroUserId: XU.terence, tenantId: ORG.coastal }),
        state: stateFrom(url),
      }),
    ).toBe(`${TEST_SITE_URL}/`)
  })

  test('pressing Connect again retires the earlier unused link', async () => {
    const s = await setup()
    const { url: first } = await s.terence.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'business',
    })
    await s.terence.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'business',
    })
    expect(await states(s)).toHaveLength(1)
    expect(
      await callbackLocation(s.t, {
        code: s.xero.consent({ xeroUserId: XU.terence, tenantId: ORG.coastal }),
        state: stateFrom(first),
      }),
    ).toBe(`${TEST_SITE_URL}/`)
  })

  test('a finish link works once', async () => {
    const s = await setup()
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
    await expect(
      s.terence.as.action(api.xero.finishConnect, {
        businessId: s.businessId,
        token: finishFrom(location),
      }),
    ).rejects.toThrow(/FINISH_EXPIRED/)
    expect(await audits(s, 'xero.connect')).toHaveLength(1)
  })

  test('a finish link expires fifteen minutes after Xero sent the browser back', async () => {
    const s = await setup()
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    vi.advanceTimersByTime(15 * MINUTE + 1000)
    await expect(
      s.terence.as.action(api.xero.finishConnect, {
        businessId: s.businessId,
        token: finishFrom(location),
      }),
    ).rejects.toThrow(/FINISH_EXPIRED/)
    const [row] = await allConnections(s)
    expect(row.status).toBe('pending')
  })

  test('a made-up finish link is expired, not an error', async () => {
    const s = await setup()
    await expect(
      s.terence.as.action(api.xero.finishConnect, {
        businessId: s.businessId,
        token: 'not-a-real-finish-token',
      }),
    ).rejects.toThrow(/FINISH_EXPIRED/)
  })
})

// ────────────────────────────────────────────────── what Xero sends back

describe('the callback', () => {
  async function started(s: Setup, kind: 'business' | 'member' = 'business') {
    const who = kind === 'business' ? s.terence : s.kevin
    const { url } = await who.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind,
    })
    return stateFrom(url)
  }

  test('“Cancel” at Xero comes back as cancelled; any other error as failed', async () => {
    const s = await setup()
    expect(
      await callbackLocation(s.t, {
        error: 'access_denied',
        state: await started(s),
      }),
    ).toBe(back('business', 'xero=cancelled'))
    expect(
      await callbackLocation(s.t, {
        error: 'unauthorized_client',
        state: await started(s, 'member'),
      }),
    ).toBe(back('member', 'xero=failed'))
    expect(s.xero.requests).toEqual([])
    expect(await allConnections(s)).toEqual([])
  })

  test('no state, or one PestM8 never made, goes home', async () => {
    const s = await setup()
    expect(await callbackLocation(s.t, { code: 'anything' })).toBe(
      `${TEST_SITE_URL}/`,
    )
    expect(
      await callbackLocation(s.t, {
        code: s.xero.consent({ xeroUserId: XU.terence, tenantId: ORG.coastal }),
        state: 'a-state-pestm8-never-made',
      }),
    ).toBe(`${TEST_SITE_URL}/`)
    expect(s.xero.requests).toEqual([])
  })

  test('a code Xero will not exchange comes back as failed, with nothing kept', async () => {
    const s = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      await callbackLocation(s.t, {
        code: 'code-that-xero-never-issued',
        state: await started(s),
      }),
    ).toBe(back('business', 'xero=failed'))
    expect(await allConnections(s)).toEqual([])
    expect(await grants(s)).toEqual([])
  })

  test('an accounting practice is not an organisation: no_org, and the connection is removed at Xero', async () => {
    const s = await setup()
    s.xero.knobs.practiceOnly = true
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: 'practice-ledger',
    })
    expect(location).toBe(back('business', 'xero=no_org'))
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({
        xeroUserId: XU.terence,
        tenantId: 'practice-ledger',
      }),
    ])
    expect(s.xero.connectedAtXero(XU.terence)).toEqual([])
    expect(await allConnections(s)).toEqual([])
  })

  test('when Xero cannot yet say what this sign-in connected, the organisation just ticked is the one', async () => {
    const s = await setup()
    // An older connection of the same Xero login, to another organisation.
    s.xero.consent({ xeroUserId: XU.terence, tenantId: ORG.north })
    s.xero.knobs.emptyAuthEvent = true

    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    expect(location.startsWith(back('business', 'finish='))).toBe(true)

    const lists = s.xero.connectionLists()
    expect(lists).toHaveLength(2)
    expect(lists[0].query.get('authEventId')).toBeTruthy()
    expect(lists[1].query.get('authEventId')).toBeNull()
    const [row] = await allConnections(s)
    expect(row.tenantId).toBe(ORG.coastal)
  })

  test('when Xero cannot say which organisation was chosen, and the login has two, it does not guess (ambiguous_org)', async () => {
    const s = await setup()
    // Terence's one Xero login already sends Coastal Pest's organisation to
    // Coastal Pest, and North's to his second business.
    const north = await northBusiness(s)
    const coastal = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const northern = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.north,
      businessId: north,
    })
    // North's is the one Xero touched last.
    expect(s.xero.connectedAtXero(XU.terence)).toEqual([ORG.coastal, ORG.north])
    const { businessId: harbour } = await createBusiness(
      s.t,
      s.terence,
      'Harbour Pest',
    )

    // At a third business he ticks Coastal Pest's again, and Xero leaves an
    // organisation that was already connected as it was: nothing names this
    // sign-in, so "the newest" would be North — not what he chose.
    s.xero.knobs.reconsentKeepsEvent = true
    const location = await connectVia(s.t, s.terence.as, {
      businessId: harbour,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    expect(location).toBe(
      back('business', 'xero=ambiguous_org', 'harbour-pest'),
    )
    expect(await connectionsIn(s, harbour)).toEqual([])
    // His other businesses keep theirs, at Xero too: nothing deleted, and
    // the sign-in they run on not revoked.
    expect(s.xero.deleteRequests()).toEqual([])
    expect(s.xero.revocations()).toEqual([])
    expect(s.xero.connectedAtXero(XU.terence)).toEqual([ORG.coastal, ORG.north])
    for (const row of [coastal, northern]) {
      expect((await connection(s, row._id)).status).toBe('connected')
    }
  })

  test('…but a login with only the one organisation leaves no doubt', async () => {
    const s = await setup()
    const north = await northBusiness(s)
    await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
      businessId: north,
    })
    s.xero.knobs.reconsentKeepsEvent = true

    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    expect(location.startsWith(back('business', 'finish='))).toBe(true)
    const [row] = await connectionsIn(s, s.businessId)
    expect(row).toMatchObject({ tenantId: ORG.coastal, status: 'pending' })
  })
})

// ──────────────────────────────────────────────────────────────── refusals

describe('refused connections', () => {
  test('a member cannot connect the business’s own organisation (business_org), and it is removed at Xero', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // Kevin has his own login to Coastal Pest's Xero.
    const location = await connectVia(s.t, s.kevin.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.coastal,
    })
    expect(location).toBe(back('member', 'xero=business_org'))

    expect(s.xero.deleted).toEqual([
      {
        id: expect.any(String),
        xeroUserId: XU.kevin,
        tenantId: ORG.coastal,
      },
    ])
    // Terence's own connection to the same organisation is untouched.
    expect(s.xero.connectedAtXero(XU.terence)).toEqual([ORG.coastal])
    expect((await connection(s, business._id)).status).toBe('connected')
    // Kevin's sign-in has nothing left to do here: revoked, and not kept.
    expect(s.xero.revoked).toEqual([{ xeroUserId: XU.kevin }])
    expect((await grants(s)).map((g) => g.xeroUserId)).toEqual([XU.terence])
    const live = (await allConnections(s)).filter(
      (r) => r.membershipId === s.kevinId && r.status !== 'disconnected',
    )
    expect(live).toEqual([])
    const kevins = await s.kevin.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(kevins.mine?.status ?? 'none').not.toBe('connected')
  })

  test('the owner cannot take an organisation a member already sends to (member_org)', async () => {
    const s = await setup()
    await connected(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.kevin,
    })
    expect(location).toBe(back('business', 'xero=member_org'))
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({ xeroUserId: XU.terence, tenantId: ORG.kevin }),
    ])
    expect(s.xero.connectedAtXero(XU.kevin)).toEqual([ORG.kevin])
  })

  test('two members cannot send to one organisation (taken)', async () => {
    const s = await setup()
    await connected(s, s.jo, {
      kind: 'member',
      xeroUserId: XU.jo,
      tenantId: ORG.jo,
    })
    // Kevin keeps Jo's books, so he has his own login to her organisation.
    const location = await connectVia(s.t, s.kevin.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.jo,
    })
    expect(location).toBe(back('member', 'xero=taken'))
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({ xeroUserId: XU.kevin, tenantId: ORG.jo }),
    ])
    expect(s.xero.connectedAtXero(XU.jo)).toEqual([ORG.jo])
  })

  test('a refused connection that another business still uses is left alone at Xero', async () => {
    const s = await setup()
    // Jo runs her own business on PestM8 too, with her Xero as its own.
    const bloggs = await createBusiness(s.t, s.jo, 'Bloggs Pest')
    const hers = await connected(s, s.jo, {
      kind: 'business',
      xeroUserId: XU.jo,
      tenantId: ORG.jo,
      businessId: bloggs.businessId,
    })
    // At Coastal, Kevin already sends to Jo's organisation.
    await connected(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.jo,
    })

    // So Jo connecting it at Coastal is refused…
    const location = await connectVia(s.t, s.jo.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: XU.jo,
      tenantId: ORG.jo,
    })
    expect(location).toBe(back('member', 'xero=taken'))
    // …but her Xero connection is the one Bloggs Pest runs on: not deleted,
    // and her sign-in, which Bloggs Pest uses, not revoked.
    expect(s.xero.deleteRequests()).toEqual([])
    expect(s.xero.revocations()).toEqual([])
    expect(s.xero.connectedAtXero(XU.jo)).toEqual([ORG.jo])
    expect((await connection(s, hers._id)).status).toBe('connected')
  })

  test('a reconnect must come back to the same organisation (different_org)', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await s.t.run((ctx) =>
      ctx.db.patch(business._id, {
        status: 'needs_reconnect',
        problem: { code: 'reconnect', at: Date.now() },
      }),
    )

    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.north,
    })
    expect(location).toBe(back('business', 'xero=different_org'))
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({ xeroUserId: XU.terence, tenantId: ORG.north }),
    ])
    // Terence's sign-in is still the one Coastal Pest's connection waits on:
    // revoking it would take Coastal Pest's organisation out with it.
    expect(s.xero.revocations()).toEqual([])
    expect(await grants(s)).toEqual([
      expect.objectContaining({ xeroUserId: XU.terence, status: 'active' }),
    ])
    // The connection still names Coastal Pest, and still needs reconnecting.
    const rows = await allConnections(s)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tenantId: ORG.coastal,
      status: 'needs_reconnect',
    })
  })

  test('past the app’s organisation cap a new organisation is refused (org_cap); one already connected elsewhere is not', async () => {
    const s = await setup()
    vi.stubEnv('XERO_MAX_ORGS', '1')
    await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    const location = await connectVia(s.t, s.kevin.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })
    expect(location).toBe(back('member', 'xero=org_cap'))
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({ xeroUserId: XU.kevin, tenantId: ORG.kevin }),
    ])

    // Coastal Pest's organisation counts once, however many businesses use it.
    const north = await northBusiness(s)
    const again = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
      businessId: north,
    })
    expect(again.status).toBe('connected')
  })
})

// ───────────────────────────────────────────────────────────── reconnect

describe('reconnecting', () => {
  test('Xero refusing the sign-in asks for a reconnect; reconnecting the same organisation mends the same connection', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    s.xero.knobs.failRefresh = 'invalid_grant'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Logged, not thrown: the keep-alive's refresh never fails its caller.
    await s.t.action(internal.xeroTokens.refreshGrant, {
      grantId: business.grantId,
    })

    const broken = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(broken.business).toMatchObject({
      connectionId: business._id,
      status: 'needs_reconnect',
      problem: { code: 'reconnect', at: expect.any(Number) },
    })

    s.xero.knobs.failRefresh = null
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // Still waiting on finish: the callback alone does not mend it.
    expect((await connection(s, business._id)).status).toBe('needs_reconnect')
    const reconnecting = (await states(s)).at(-1)
    expect(reconnecting?.reconnectConnectionId).toBe(business._id)

    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
    await settle(s)

    const rows = await allConnections(s)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      _id: business._id,
      tenantId: ORG.coastal,
      status: 'connected',
    })
    expect(rows[0].problem).toBeUndefined()
    const [grant] = await grants(s)
    expect(grant.status).toBe('active')
    expect(grant.deadAt).toBeUndefined()
    expect(await audits(s, 'xero.reconnect')).toEqual([
      expect.objectContaining({
        entityId: business._id,
        meta: expect.objectContaining({ disclosure: 'whole_book_v1' }),
      }),
    ])
    // Its own connection at Xero, kept.
    expect(s.xero.deleteRequests()).toEqual([])
  })

  test('reconnecting through another Xero login lets go of the old one at Xero', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const oldGrant = business.grantId

    // He reconnects, signing in to Xero as the bookkeeper this time.
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: 'xu-bookkeeper',
      tenantId: ORG.coastal,
    })
    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
    await settle(s)

    const row = await connection(s, business._id)
    expect(row).toMatchObject({ status: 'connected', tenantId: ORG.coastal })
    expect(row.grantId).not.toBe(oldGrant)
    expect(row.xeroConnectionId).toBe(
      s.xero.connectionIdOf('xu-bookkeeper', ORG.coastal),
    )
    // Terence's own login no longer reaches the organisation through
    // PestM8: its connection deleted, its sign-in revoked and forgotten.
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({
        xeroUserId: XU.terence,
        tenantId: ORG.coastal,
      }),
    ])
    expect(s.xero.revoked).toEqual([{ xeroUserId: XU.terence }])
    expect((await grants(s)).map((g) => g.xeroUserId)).toEqual([
      'xu-bookkeeper',
    ])
    expect(s.xero.connectedAtXero('xu-bookkeeper')).toEqual([ORG.coastal])
  })

  test('connecting again over an unfinished one waits to let go of it, so choosing the same organisation keeps working', async () => {
    const s = await setup()
    // Kevin's first try came back from Xero but was never finished.
    await connectVia(s.t, s.kevin.as, {
      businessId: s.businessId,
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })
    const [first] = await allConnections(s)
    const xeroConnectionId = s.xero.connectionIdOf(XU.kevin, ORG.kevin)

    // He presses Connect again: the unfinished one is retired, and its
    // release waits until this connect is over (10 + 15 minutes).
    const { url } = await s.kevin.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'member',
    })
    expect((await connection(s, first._id)).status).toBe('disconnected')
    const releases = await s.t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) =>
          job.name.includes('releaseAtXero') && job.state.kind === 'pending',
      ),
    )
    expect(releases).toEqual([
      expect.objectContaining({
        args: [{ connectionId: first._id }],
        scheduledTime: Date.now() + 25 * MINUTE,
      }),
    ])

    // He ticks the same organisation, quickly: Xero keeps its connection id.
    const location = await callbackLocation(s.t, {
      code: s.xero.consent({ xeroUserId: XU.kevin, tenantId: ORG.kevin }),
      state: stateFrom(url),
    })
    await s.kevin.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
    await settle(s)

    // The late release found the new connection on it, and left it alone.
    const second = (await allConnections(s)).find((r) => r._id !== first._id)
    expect(second).toMatchObject({
      status: 'connected',
      xeroConnectionId,
      shortCode: expect.any(String),
    })
    expect(second?.problem).toBeUndefined()
    expect(s.xero.deleteRequests()).toEqual([])
    expect(s.xero.revocations()).toEqual([])
    expect(s.xero.connectedAtXero(XU.kevin)).toEqual([ORG.kevin])
  })

  test('Xero refusing the organisation to a sign-in it still accepts asks for a reconnect (org_gone)', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // PestM8 removed from Coastal Pest's organisation in Xero.
    s.xero.removeInXero(XU.terence, ORG.coastal)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reads = s.xero.organisationReads().length

    await s.t.action(internal.xero.fetchOrganisation, {
      connectionId: business._id,
    })
    await settle(s)

    // Asked once: a 403 is not tried again.
    expect(s.xero.organisationReads()).toHaveLength(reads + 1)
    const status = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(status.business).toMatchObject({
      connectionId: business._id,
      status: 'needs_reconnect',
      problem: { code: 'org_gone' },
    })
    // The sign-in itself still works: not dead.
    expect((await grants(s))[0].status).toBe('active')
  })
})

// ─────────────────────────────────────────────────────── demo, unconfigured

describe('guards', () => {
  test('the demo business cannot connect Xero', async () => {
    const s = await setup()
    await s.t.run((ctx) => ctx.db.patch(s.businessId, { plan: DEMO_PLAN }))
    await expect(
      s.terence.as.action(api.xero.startConnect, {
        businessId: s.businessId,
        kind: 'business',
      }),
    ).rejects.toThrow(/XERO_DEMO/)
    expect(
      (await s.terence.as.query(api.xero.status, { businessId: s.businessId }))
        .demo,
    ).toBe(true)
    expect(s.xero.requests).toEqual([])
  })

  test('a business that became the demo mid-sign-in is refused at the callback, and cleaned up at Xero', async () => {
    const s = await setup()
    const { url } = await s.terence.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'business',
    })
    await s.t.run((ctx) => ctx.db.patch(s.businessId, { plan: DEMO_PLAN }))
    const location = await callbackLocation(s.t, {
      code: s.xero.consent({ xeroUserId: XU.terence, tenantId: ORG.coastal }),
      state: stateFrom(url),
    })
    expect(location).toBe(back('business', 'xero=demo'))
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({
        xeroUserId: XU.terence,
        tenantId: ORG.coastal,
      }),
    ])
    expect(
      (await allConnections(s)).filter((r) => r.status !== 'disconnected'),
    ).toEqual([])
  })

  test('the kill switch says so, and does not stop anyone connecting', async () => {
    const s = await setup()
    vi.stubEnv('XERO_SYNC_PAUSED', 'on')
    expect(
      (await s.terence.as.query(api.xero.status, { businessId: s.businessId }))
        .paused,
    ).toBe(true)
    const row = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    expect(row.status).toBe('connected')
  })

  test('a deployment not set up for Xero says so, and never calls it', async () => {
    const s = await setup({ configured: false })
    await expect(
      s.terence.as.action(api.xero.startConnect, {
        businessId: s.businessId,
        kind: 'business',
      }),
    ).rejects.toThrow(/XERO_NOT_CONFIGURED/)
    const status = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(status).toMatchObject({ configured: false, business: null })
    const res = await xeroCallback(s.t, { code: 'x', state: 'y' })
    expect(res.status).toBe(404)
    expect(s.xero.requests).toEqual([])
    expect(await states(s)).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────── disconnect

describe('disconnecting', () => {
  test('removes the one connection at Xero and revokes a sign-in nobody else uses', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const xeroConnectionId = s.xero.connectionIdOf(XU.terence, ORG.coastal)

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: business._id,
    })
    const row = await connection(s, business._id)
    expect(row).toMatchObject({
      status: 'disconnected',
      disconnectReason: 'by_hand',
      disconnectedByMembershipId: s.ownerMembershipId,
    })
    expect(row.disconnectedAt).toBeTypeOf('number')
    expect(await audits(s, 'xero.disconnect')).toEqual([
      expect.objectContaining({
        actorMembershipId: s.ownerMembershipId,
        entityType: 'xeroConnections',
        entityId: business._id,
      }),
    ])

    await settle(s)
    const [deleted] = s.xero.deleteRequests()
    expect(s.xero.deleteRequests()).toHaveLength(1)
    expect(deleted.path).toBe(`/connections/${xeroConnectionId}`)
    expect(deleted.headers.authorization).toMatch(/^Bearer /)
    expect(s.xero.revoked).toEqual([{ xeroUserId: XU.terence }])
    expect(await grants(s)).toEqual([])

    // Settings shows it disconnected, by hand.
    const status = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(status.business).toMatchObject({
      status: 'disconnected',
      disconnectReason: 'by_hand',
    })

    // A second press does nothing more.
    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: business._id,
    })
    await settle(s)
    expect(s.xero.deleteRequests()).toHaveLength(1)
    expect(s.xero.revocations()).toHaveLength(1)
  })

  test('a Xero login two businesses share is revoked only when the last one lets go', async () => {
    const s = await setup()
    const north = await northBusiness(s)
    const coastal = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const northern = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.north,
      businessId: north,
    })
    // One Xero login, one token set.
    expect(await grants(s)).toHaveLength(1)
    expect(coastal.grantId).toBe(northern.grantId)

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: coastal._id,
    })
    await settle(s)
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({ tenantId: ORG.coastal }),
    ])
    expect(s.xero.revocations()).toEqual([])
    expect((await grants(s))[0].status).toBe('active')
    expect(s.xero.connectedAtXero(XU.terence)).toEqual([ORG.north])

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: north,
      connectionId: northern._id,
    })
    await settle(s)
    expect(s.xero.deleted.map((d) => d.tenantId)).toEqual([
      ORG.coastal,
      ORG.north,
    ])
    expect(s.xero.revoked).toEqual([{ xeroUserId: XU.terence }])
    expect(await grants(s)).toEqual([])
  })

  test('when PestM8 can no longer reach Xero for it, the page is told to remove PestM8 in Xero', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // Xero stopped accepting the sign-in (removed in Xero, or 60 days idle).
    s.xero.knobs.failRefresh = 'invalid_grant'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await s.t.action(internal.xeroTokens.refreshGrant, {
      grantId: business.grantId,
    })

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: business._id,
    })
    await settle(s)

    // Nothing could be sent with a dead sign-in.
    expect(s.xero.deleteRequests()).toEqual([])
    expect(s.xero.revocations()).toEqual([])
    const status = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(status.business).toMatchObject({
      status: 'disconnected',
      disconnectReason: 'by_hand',
      problem: { code: 'xero_side' },
    })
    expect(await grants(s)).toEqual([])
  })

  test('one organisation used by two businesses stays connected at Xero until both let go', async () => {
    const s = await setup()
    const north = await northBusiness(s)
    const coastal = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const northern = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
      businessId: north,
    })
    expect(coastal.xeroConnectionId).toBe(northern.xeroConnectionId)

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: coastal._id,
    })
    await settle(s)
    expect(s.xero.deleteRequests()).toEqual([])
    expect(s.xero.revocations()).toEqual([])
    expect(s.xero.connectedAtXero(XU.terence)).toEqual([ORG.coastal])

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: north,
      connectionId: northern._id,
    })
    await settle(s)
    expect(s.xero.deleteRequests()).toHaveLength(1)
    expect(s.xero.revocations()).toHaveLength(1)
  })
})

// ──────────────────────────────────────────────── when Xero won't let go

describe('a release at Xero that fails', () => {
  test('Xero down throughout: tried five times, each wait longer, then the sign-in is revoked anyway', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    s.xero.knobs.failDelete = 'server'
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: business._id,
    })
    await settle(s)

    const tries = s.xero.deleteRequests()
    expect(tries).toHaveLength(5)
    const waits = tries.slice(1).map((r, i) => r.at - tries[i].at)
    expect(waits).toEqual([1, 2, 4, 8].map((n) => n * MINUTE))
    // Giving up on the DELETE does not leave a sign-in nothing uses: revoked
    // (which takes the connection out of Xero with it) and forgotten, so no
    // keep-alive ever refreshes it again.
    expect(s.xero.revoked).toEqual([{ xeroUserId: XU.terence }])
    expect(s.xero.connectedAtXero(XU.terence)).toEqual([])
    expect(await grants(s)).toEqual([])
    const row = await connection(s, business._id)
    expect(row.status).toBe('disconnected')
    expect(row.problem).toBeUndefined()
  })

  test('…and when another business still runs on that sign-in, the page is told to remove PestM8 in Xero', async () => {
    const s = await setup()
    const north = await northBusiness(s)
    const coastal = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.north,
      businessId: north,
    })
    s.xero.knobs.failDelete = 'server'
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: coastal._id,
    })
    await settle(s)

    expect(s.xero.deleteRequests()).toHaveLength(5)
    expect(s.xero.revocations()).toEqual([])
    expect(await grants(s)).toEqual([
      expect.objectContaining({ xeroUserId: XU.terence, status: 'active' }),
    ])
    const status = await s.terence.as.query(api.xero.status, {
      businessId: s.businessId,
    })
    expect(status.business).toMatchObject({
      status: 'disconnected',
      problem: { code: 'xero_side' },
    })
  })

  test('Xero refusing the DELETE gives up at once; a revoke that fails too still forgets the sign-in', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    s.xero.knobs.failDelete = 'forbidden'
    s.xero.knobs.failRevoke = true
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: business._id,
    })
    await settle(s)

    expect(s.xero.deleteRequests()).toHaveLength(1)
    expect(s.xero.revocations()).toHaveLength(1)
    // Still listed in Xero, so the page says how to remove it there…
    expect((await connection(s, business._id)).problem).toMatchObject({
      code: 'xero_side',
    })
    // …and PestM8 holds nothing that could reach it again.
    expect(await grants(s)).toEqual([])
  })

  test('a refresh holding the sign-in: the release waits its turn, then finishes', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    // Someone else's refresh holds the lease for the next 90 seconds.
    await s.t.run((ctx) =>
      ctx.db.patch(business.grantId, {
        refreshLease: { holder: 'someone-else', until: Date.now() + 90_000 },
      }),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: business._id,
    })
    await settle(s)

    // Removed at the first try; the revoke waited for the lease to pass.
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({ tenantId: ORG.coastal }),
    ])
    const [revoke] = s.xero.revocations()
    expect(s.xero.revocations()).toHaveLength(1)
    const [firstDelete] = s.xero.deleteRequests()
    expect(revoke.at - firstDelete.at).toBeGreaterThanOrEqual(90_000)
    expect(await grants(s)).toEqual([])
    expect((await connection(s, business._id)).problem).toBeUndefined()
  })

  test('a consent to the same organisation landing while the release fetches its token keeps its connection', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const xeroConnectionId = business.xeroConnectionId
    await s.terence.as.mutation(api.xero.disconnect, {
      businessId: s.businessId,
      connectionId: business._id,
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The release needs a fresh token, and Xero's answer is slow to come
    // back…
    await s.t.run((ctx) =>
      ctx.db.patch(business.grantId, { accessExpiresAt: Date.now() - 1000 }),
    )
    const held = s.xero.holdRefreshes({ at: 'answer' })
    const releasing = s.t.action(internal.xero.releaseAtXero, {
      connectionId: business._id,
    })
    await held.arrived

    // …and meanwhile Terence connects Coastal Pest's organisation again,
    // which Xero gives the same connection id.
    const location = await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    held.release()
    await releasing

    expect(s.xero.deleteRequests()).toEqual([])
    await s.terence.as.action(api.xero.finishConnect, {
      businessId: s.businessId,
      token: finishFrom(location),
    })
    await settle(s)

    const again = (await allConnections(s)).find((r) => r._id !== business._id)
    expect(again).toMatchObject({ status: 'connected', xeroConnectionId })
    expect(again?.problem).toBeUndefined()
    expect(s.xero.deleteRequests()).toEqual([])
    expect(s.xero.revocations()).toEqual([])
    expect(s.xero.connectedAtXero(XU.terence)).toEqual([ORG.coastal])
  })
})

// ───────────────────────────────────────────────────────────── offboarding

describe('someone leaving the business', () => {
  test('removed: their Xero is disconnected and let go at Xero; the owner’s is untouched', async () => {
    const s = await setup()
    const business = await connected(s, s.terence, {
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })
    const kevins = await connected(s, s.kevin, {
      kind: 'member',
      xeroUserId: XU.kevin,
      tenantId: ORG.kevin,
    })

    await s.terence.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinId,
    })
    expect(await connection(s, kevins._id)).toMatchObject({
      status: 'disconnected',
      disconnectReason: 'offboarded',
      disconnectedByMembershipId: s.ownerMembershipId,
    })
    expect(await audits(s, 'xero.disconnect')).toEqual([
      expect.objectContaining({
        actorMembershipId: s.ownerMembershipId,
        entityId: kevins._id,
        meta: expect.objectContaining({ reason: 'offboarded' }),
      }),
    ])

    await settle(s)
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({ xeroUserId: XU.kevin, tenantId: ORG.kevin }),
    ])
    expect(s.xero.revoked).toEqual([{ xeroUserId: XU.kevin }])
    expect((await connection(s, business._id)).status).toBe('connected')
    expect(s.xero.connectedAtXero(XU.terence)).toEqual([ORG.coastal])
    expect(await grants(s)).toEqual([
      expect.objectContaining({ xeroUserId: XU.terence, status: 'active' }),
    ])
    // Team no longer shows Kevin's Xero.
    expect(
      await s.terence.as.query(api.xero.memberStatus, {
        businessId: s.businessId,
        membershipId: s.kevinId,
      }),
    ).toBeNull()
  })

  test('leaving: the same, recorded as their own doing', async () => {
    const s = await setup()
    const jos = await connected(s, s.jo, {
      kind: 'member',
      xeroUserId: XU.jo,
      tenantId: ORG.jo,
    })

    await s.jo.as.mutation(api.team.leave, { businessId: s.businessId })
    expect(await connection(s, jos._id)).toMatchObject({
      status: 'disconnected',
      disconnectReason: 'offboarded',
      disconnectedByMembershipId: s.joId,
    })
    await settle(s)
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({ xeroUserId: XU.jo, tenantId: ORG.jo }),
    ])
    expect(s.xero.revoked).toEqual([{ xeroUserId: XU.jo }])
  })
})

// ─────────────────────────────────────────────────────────────────── sweep

describe('the sweep', () => {
  test('a connection nobody finished within fifteen minutes is let go', async () => {
    const s = await setup()
    await connectVia(s.t, s.terence.as, {
      businessId: s.businessId,
      kind: 'business',
      xeroUserId: XU.terence,
      tenantId: ORG.coastal,
    })

    // Not yet.
    vi.advanceTimersByTime(14 * MINUTE)
    await s.t.mutation(internal.xero.sweep, {})
    await settle(s)
    expect((await allConnections(s))[0].status).toBe('pending')
    expect(s.xero.deleteRequests()).toEqual([])

    vi.advanceTimersByTime(2 * MINUTE)
    await s.t.mutation(internal.xero.sweep, {})
    expect((await allConnections(s))[0]).toMatchObject({
      status: 'disconnected',
      disconnectReason: 'unfinished',
    })
    await settle(s)
    expect(s.xero.deleted).toEqual([
      expect.objectContaining({
        xeroUserId: XU.terence,
        tenantId: ORG.coastal,
      }),
    ])
    expect(s.xero.revoked).toEqual([{ xeroUserId: XU.terence }])
  })

  test('sign-in links are deleted an hour after they expire', async () => {
    const s = await setup()
    await s.terence.as.action(api.xero.startConnect, {
      businessId: s.businessId,
      kind: 'business',
    })
    vi.advanceTimersByTime(10 * MINUTE + HOUR - 1000)
    await s.t.mutation(internal.xero.sweep, {})
    expect(await states(s)).toHaveLength(1)

    vi.advanceTimersByTime(2000)
    await s.t.mutation(internal.xero.sweep, {})
    expect(await states(s)).toEqual([])
  })
})
