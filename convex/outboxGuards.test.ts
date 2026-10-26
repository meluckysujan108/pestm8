/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import {
  addSession,
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import { SWITCH_TTL_MS } from './lib/capabilities'
import type { FunctionArgs } from 'convex/server'
import type { Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * What the server checks of a booking a phone kept with no signal and sent
 * later by itself (lib/outboxGuards.ts).
 *
 * It names whose it is (`asMembership`), and is refused NOT_OWN_ACCOUNT
 * unless that is who is writing, in their own account: a switch belongs to
 * the sign-in session, so one started in another tab applies to a send this
 * tab already had queued. `OUTBOX_PAUSED=on` stops every such send, and
 * `refuseBackfill` refuses a Recurring Job whose first visit went by before
 * it could be sent. None of the three writes anything when it refuses, and
 * none of them stops a repeat being answered with what its first send made.
 */

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

beforeEach(() => {
  // The business syncs to Xero, so a refused booking that queued its new
  // client would show. Paused, so nothing is sent and what was queued stays.
  vi.stubEnv('XERO_CLIENT_ID', 'test-client-id')
  vi.stubEnv('XERO_CLIENT_SECRET', 'test-client-secret')
  vi.stubEnv('XERO_TOKEN_KEYS', '1:test-key')
  vi.stubEnv('XERO_SYNC_PAUSED', 'on')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function setup() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin',
  })
  const kevinMembershipId = await joinBusiness(
    t,
    owner,
    kevin,
    businessId,
    'subcontractor',
  )
  const propertyId = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'Jane Smith',
      createdAt: now,
      updatedAt: now,
    })
    const grantId = await ctx.db.insert('xeroGrants', {
      xeroUserId: 'xu-terence',
      accessCipher: 'not-a-token',
      accessExpiresAt: now + HOUR,
      refreshCipher: 'not-a-token',
      scopes: [],
      refreshedAt: now,
      status: 'active',
    })
    await ctx.db.insert('xeroConnections', {
      businessId,
      membershipId: ownerMembershipId,
      kind: 'business',
      grantId,
      tenantId: 'tenant-coastal',
      tenantName: 'Coastal Pest Pty Ltd',
      xeroConnectionId: 'connection-coastal',
      status: 'connected',
      createdAt: now,
      connectedAt: now,
      syncStartedAt: now,
      syncStartedByMembershipId: ownerMembershipId,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '14 Rosewood Ave',
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
      createdAt: now,
    })
  })
  return {
    t,
    owner,
    kevin,
    businessId,
    ownerMembershipId,
    kevinMembershipId,
    propertyId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** An id as the phone makes one. */
const newKey = () => crypto.randomUUID()

type Booking = FunctionArgs<typeof api.jobs.create>
type Series = FunctionArgs<typeof api.recurrences.create>

const priya = {
  clientName: 'Priya Shah',
  phone: '0412 345 678',
  email: 'priya@shah.test',
  addressLine: '88 Marine Parade',
  suburb: 'Cottesloe',
  state: 'WA',
  postcode: '6011',
}

/** A job for Kevin, for a new client, so a booking that got through would
 * number a client and queue it for Xero as well as make the job. */
function booking(s: Setup, fields: Partial<Booking> = {}): Booking {
  return {
    businessId: s.businessId,
    newClient: priya,
    assignedMembershipId: s.kevinMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
    notes: 'Side gate code 4411.',
    ...fields,
  }
}

/** A monthly series for Kevin, for the same new client. */
function series(s: Setup, fields: Partial<Series> = {}): Series {
  return {
    businessId: s.businessId,
    newClient: priya,
    assignedMembershipId: s.kevinMembershipId,
    intervalCount: 1,
    intervalUnit: 'month',
    jobType: 'Rodents',
    price: 18000,
    anchorDate: Date.now() + DAY,
    durationMinutes: 45,
    notes: 'Bait stations behind the shed.',
    ...fields,
  }
}

/** Every row a booking can write, and what it schedules. */
function everything(s: Setup) {
  return s.t.run(async (ctx) => ({
    businesses: await ctx.db.query('businesses').collect(),
    clients: await ctx.db.query('clients').collect(),
    properties: await ctx.db.query('properties').collect(),
    jobs: await ctx.db.query('jobs').collect(),
    jobPeople: await ctx.db.query('jobPeople').collect(),
    recurrences: await ctx.db.query('recurrences').collect(),
    notes: await ctx.db.query('notes').collect(),
    xeroOutbox: await ctx.db.query('xeroOutbox').collect(),
    auditLog: await ctx.db.query('auditLog').collect(),
    scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
  }))
}

function row<T extends 'jobs' | 'recurrences'>(s: Setup, id: Id<T>) {
  return s.t.run(async (ctx) => (await ctx.db.get(id))!)
}

function visitsOf(s: Setup, recurrenceId: Id<'recurrences'>) {
  return s.t.run((ctx) =>
    ctx.db
      .query('jobs')
      .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
      .collect(),
  )
}

/** Terence working inside Kevin's account on this session. */
async function switchIntoKevin(s: Setup, owner: TestActor) {
  const now = Date.now()
  return s.t.run((ctx) =>
    ctx.db.insert('accountSwitches', {
      sessionId: owner.sessionId,
      businessId: s.businessId,
      realMembershipId: s.ownerMembershipId,
      targetMembershipId: s.kevinMembershipId,
      startedAt: now,
      expiresAt: now + SWITCH_TTL_MS,
    }),
  )
}

/** The job and the series, each sent by `who`. */
function sendBoth(who: TestActor, job: Booking, arrangement: Series) {
  return [
    () => who.as.mutation(api.jobs.create, job),
    () => who.as.mutation(api.recurrences.create, arrangement),
  ]
}

describe('asMembership: only the person it names, as themselves', () => {
  test('their own membership books, and is kept nowhere', async () => {
    const s = await setup()
    const jobId = await s.owner.as.mutation(
      api.jobs.create,
      booking(s, { asMembership: s.ownerMembershipId }),
    )
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      series(s, { asMembership: s.ownerMembershipId }),
    )
    // Kevin, booking his own work from his own phone.
    const kevinsJobId = await s.kevin.as.mutation(
      api.jobs.create,
      booking(s, { asMembership: s.kevinMembershipId }),
    )

    for (const job of [await row(s, jobId), await row(s, kevinsJobId)]) {
      expect(job.assignedMembershipId).toBe(s.kevinMembershipId)
      expect(job).not.toHaveProperty('asMembership')
    }
    expect(await row(s, recurrenceId)).not.toHaveProperty('asMembership')
    expect(await visitsOf(s, recurrenceId)).not.toHaveLength(0)
  })

  test('switched into someone else’s account: NOT_OWN_ACCOUNT, with nothing written', async () => {
    const s = await setup()
    const switchId = await switchIntoKevin(s, s.owner)
    const before = await everything(s)

    // Named as Terence, who is working as Kevin; or as Kevin, who isn't
    // the one writing. Either way, not the account the phone kept it for.
    for (const asMembership of [s.ownerMembershipId, s.kevinMembershipId]) {
      for (const send of sendBoth(
        s.owner,
        booking(s, { asMembership, clientRequestId: newKey() }),
        series(s, { asMembership, clientRequestId: newKey() }),
      )) {
        await expect(send()).rejects.toThrow(/NOT_OWN_ACCOUNT/)
      }
    }
    // No job, no series, no client numbered, nothing queued for Xero.
    expect(await everything(s)).toEqual(before)

    // Without a name it books in Kevin's account, as every switched booking
    // does today.
    await expect(
      s.owner.as.mutation(api.jobs.create, booking(s)),
    ).resolves.toBeDefined()

    // And a switch that has run out is refused as every write is, before
    // anything is asked of the name.
    await s.t.run((ctx) =>
      ctx.db.patch(switchId, { expiresAt: Date.now() - 1 }),
    )
    const lapsed = await everything(s)
    for (const send of sendBoth(
      s.owner,
      booking(s, { asMembership: s.ownerMembershipId }),
      series(s, { asMembership: s.ownerMembershipId }),
    )) {
      await expect(send()).rejects.toThrow(/SWITCH_EXPIRED/)
    }
    expect(await everything(s)).toEqual(lapsed)
  })

  test('someone else’s membership: NOT_OWN_ACCOUNT', async () => {
    const s = await setup()
    const other = await createActor(s.t, { email: 'rival@other.test' })
    const { ownerMembershipId: theirs } = await createBusiness(
      s.t,
      other,
      'Other Pest',
    )
    const before = await everything(s)

    for (const [who, asMembership] of [
      // Kevin's phone, holding a booking named as the owner.
      [s.kevin, s.ownerMembershipId],
      // The owner's, holding one named as Kevin.
      [s.owner, s.kevinMembershipId],
      // A membership in another business altogether.
      [s.owner, theirs],
    ] as const) {
      for (const send of sendBoth(
        who,
        booking(s, { asMembership }),
        series(s, { asMembership }),
      )) {
        await expect(send()).rejects.toThrow(/NOT_OWN_ACCOUNT/)
      }
    }
    expect(await everything(s)).toEqual(before)
  })

  test('removed and invited back: the same membership, so one kept from before still books', async () => {
    // A rejoin makes the old membership active again (invitations.redeem),
    // so the name a phone saved before the removal is the name after it.
    // This check can't tell the two stints apart; only the phone can, from
    // what it saw of the removal. What it books is held to what Kevin may
    // do now, as any booking of his is.
    const s = await setup()
    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })
    // His last business, so his sessions went with it: signed in afresh.
    const kevin = await addSession(s.t, s.kevin)
    expect(
      await joinBusiness(s.t, s.owner, kevin, s.businessId, 'subcontractor'),
    ).toBe(s.kevinMembershipId)

    const kept = booking(s, { asMembership: s.kevinMembershipId })
    const jobId = await kevin.as.mutation(api.jobs.create, kept)
    expect((await row(s, jobId)).assignedMembershipId).toBe(s.kevinMembershipId)
  })

  test('access:me says when they were last removed, which is all that tells the two stints apart', async () => {
    // The phone (src/lib/outbox/sender.ts) lets a booking it kept before
    // then go, as the removal would have taken it had it heard of it.
    const s = await setup()
    const me = (who: TestActor) =>
      who.as.query(api.access.me, { businessId: s.businessId })
    expect((await me(s.kevin)).lastRemovedAt).toBeNull()
    expect((await me(s.owner)).lastRemovedAt).toBeNull()

    const before = Date.now()
    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })
    const after = Date.now()
    const kevin = await addSession(s.t, s.kevin)
    await joinBusiness(s.t, s.owner, kevin, s.businessId, 'subcontractor')

    const back = await me(kevin)
    expect(back.membershipId).toBe(s.kevinMembershipId)
    expect(back.lastRemovedAt).toBeGreaterThanOrEqual(before)
    expect(back.lastRemovedAt).toBeLessThanOrEqual(after)
    // Nobody else's changes.
    expect((await me(s.owner)).lastRemovedAt).toBeNull()
  })

  test('a repeat gets its record back, whatever the name would now say', async () => {
    const s = await setup()
    const job = booking(s, {
      asMembership: s.ownerMembershipId,
      clientRequestId: newKey(),
    })
    const arrangement = series(s, {
      asMembership: s.ownerMembershipId,
      clientRequestId: newKey(),
    })
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      arrangement,
    )
    const after = await everything(s)

    // Its answer was lost, and the owner has since switched into Kevin's
    // account on that session: a new send would be NOT_OWN_ACCOUNT.
    await switchIntoKevin(s, s.owner)
    expect(await s.owner.as.mutation(api.jobs.create, job)).toBe(jobId)
    expect(await s.owner.as.mutation(api.recurrences.create, arrangement)).toBe(
      recurrenceId,
    )

    // And with every send from a phone paused.
    vi.stubEnv('OUTBOX_PAUSED', 'on')
    expect(await s.owner.as.mutation(api.jobs.create, job)).toBe(jobId)
    expect(await s.owner.as.mutation(api.recurrences.create, arrangement)).toBe(
      recurrenceId,
    )
    expect(await everything(s)).toEqual(after)
  })
})

describe('OUTBOX_PAUSED', () => {
  test('on: a phone’s own send is refused with nothing written, and the sheet’s books', async () => {
    const s = await setup()
    vi.stubEnv('OUTBOX_PAUSED', 'on')
    const job = booking(s, { clientRequestId: newKey() })
    const arrangement = series(s, { clientRequestId: newKey() })
    const before = await everything(s)

    for (const send of sendBoth(
      s.owner,
      { ...job, asMembership: s.ownerMembershipId },
      { ...arrangement, asMembership: s.ownerMembershipId },
    )) {
      await expect(send()).rejects.toThrow(/OUTBOX_PAUSED/)
    }
    expect(await everything(s)).toEqual(before)

    // The sheet, still open, sends it again without the name and under the
    // same id: it books, and the outbox's own send is then answered with it.
    const jobId = await s.owner.as.mutation(api.jobs.create, job)
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      arrangement,
    )
    expect(
      await s.owner.as.mutation(api.jobs.create, {
        ...job,
        asMembership: s.ownerMembershipId,
      }),
    ).toBe(jobId)
    expect(
      await s.owner.as.mutation(api.recurrences.create, {
        ...arrangement,
        asMembership: s.ownerMembershipId,
      }),
    ).toBe(recurrenceId)
    const made = await everything(s)
    expect(made.jobs.filter((j) => j.recurrenceId === undefined)).toHaveLength(
      1,
    )
    expect(made.recurrences).toHaveLength(1)
  })

  test('switched as well: NOT_OWN_ACCOUNT first', async () => {
    // A paused send is sent again without the name, so it must never be
    // told "paused" while the session is working in someone else's account:
    // sent again, it would book there.
    const s = await setup()
    vi.stubEnv('OUTBOX_PAUSED', 'on')
    await switchIntoKevin(s, s.owner)
    const before = await everything(s)
    for (const send of sendBoth(
      s.owner,
      booking(s, { asMembership: s.ownerMembershipId }),
      series(s, { asMembership: s.ownerMembershipId }),
    )) {
      await expect(send()).rejects.toThrow(/NOT_OWN_ACCOUNT/)
    }
    expect(await everything(s)).toEqual(before)
  })

  test('anything but on is off', async () => {
    const s = await setup()
    for (const value of ['', 'off', 'true', 'ON']) {
      vi.stubEnv('OUTBOX_PAUSED', value)
      await expect(
        s.owner.as.mutation(
          api.jobs.create,
          booking(s, { asMembership: s.ownerMembershipId }),
        ),
        value,
      ).resolves.toBeDefined()
    }
  })
})

describe('refuseBackfill', () => {
  /** A series sent the way the outbox sends one it meant to book from its
   * first visit. */
  function meant(s: Setup, anchorDate: number, fields: Partial<Series> = {}) {
    return series(s, {
      anchorDate,
      asMembership: s.ownerMembershipId,
      refuseBackfill: true,
      clientRequestId: newKey(),
      ...fields,
    })
  }

  test('a first visit 25 hours gone: FIRST_VISIT_PAST, with nothing written', async () => {
    const s = await setup()
    const before = await everything(s)
    await expect(
      s.owner.as.mutation(
        api.recurrences.create,
        meant(s, Date.now() - 25 * HOUR),
      ),
    ).rejects.toThrow(/FIRST_VISIT_PAST/)
    // Sent without the name too: the rule is the series', not the outbox's.
    await expect(
      s.owner.as.mutation(
        api.recurrences.create,
        meant(s, Date.now() - 25 * HOUR, { asMembership: undefined }),
      ),
    ).rejects.toThrow(/FIRST_VISIT_PAST/)
    expect(await everything(s)).toEqual(before)
  })

  test('one 23 hours gone books that first visit', async () => {
    const s = await setup()
    const anchorDate = Date.now() - 23 * HOUR
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      meant(s, anchorDate),
    )
    const first = (await visitsOf(s, recurrenceId)).find(
      (visit) => visit.scheduledAt === anchorDate,
    )
    expect(first).toMatchObject({ status: 'pending' })
    expect(await row(s, recurrenceId)).not.toHaveProperty('refuseBackfill')
  })

  test('without it, 25 hours gone books the series as today, from its next visit', async () => {
    const s = await setup()
    const anchorDate = Date.now() - 25 * HOUR
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      series(s, { anchorDate, clientRequestId: newKey() }),
    )
    const visits = await visitsOf(s, recurrenceId)
    expect(visits).not.toHaveLength(0)
    expect(visits.some((visit) => visit.scheduledAt === anchorDate)).toBe(false)
  })

  test('a repeat is answered before it is asked', async () => {
    // The first send landed with its first visit 23½ hours gone. Its answer
    // was lost, and the phone could only send it again 45 minutes later,
    // with the visit then over a day gone. (Within the hour a test session
    // lasts.)
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    const arrangement = meant(s, Date.now() - 23.5 * HOUR)
    const recurrenceId = await s.owner.as.mutation(
      api.recurrences.create,
      arrangement,
    )
    const after = await everything(s)

    vi.setSystemTime(Date.now() + 45 * MINUTE)
    expect(await s.owner.as.mutation(api.recurrences.create, arrangement)).toBe(
      recurrenceId,
    )
    expect(await everything(s)).toEqual(after)
    // Which is what the same booking gets as a new one.
    await expect(
      s.owner.as.mutation(api.recurrences.create, {
        ...arrangement,
        clientRequestId: newKey(),
      }),
    ).rejects.toThrow(/FIRST_VISIT_PAST/)
  })
})
