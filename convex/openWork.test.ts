/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import { addDaysToKey, zonedDateTimeToUtc } from './lib/dates'
import { OPEN_WORK_LIMIT, openWorkDays, openWorkSpan } from './lib/siteWork'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * `jobs.openWork`: what is booked at each site, which a phone keeps for New
 * Job's double-booking check. The window is the business's own twenty weeks
 * around the week asked for, in any time zone; cancelled and binned jobs are
 * left out; a subcontractor gets anyone else's open work as a site and a
 * date only, and nobody else's work done at all (the owner's answer, 27 Oct
 * 2026), and only within the business's own twenty weeks; it answers for
 * the business's own week alone (zoneWeeks.ts; the owner's answer to
 * C5, 1 Nov 2026); and past its limit it says so rather than failing.
 */

const TZ = 'Australia/Perth'
/** The Monday asked about, the business's week in every test's setup: a
 * fixed date, since the query reads no clock. */
const START = '2026-11-02'
const MINUTE = 60 * 1000

const at = (dayKey: string, hh: number, mm = 0, zone = TZ) =>
  zonedDateTimeToUtc(dayKey, hh, mm, zone)

async function setup() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@pestm8.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, {
    email: 'kevin@pestm8.test',
    name: 'Kevin',
  })
  const kevinId = await joinBusiness(
    t,
    owner,
    kevin,
    businessId,
    'subcontractor',
  )
  const [wattle, ocean] = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'Jane Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    return Promise.all(
      ['12 Wattle St', '5/12 Ocean Pde'].map((addressLine) =>
        ctx.db.insert('properties', {
          businessId,
          clientId,
          addressLine,
          suburb: 'Bayswater',
          state: 'WA',
          postcode: '6053',
          createdAt: now,
        }),
      ),
    )
  })
  await setWeek({ t, businessId }, { monday: START, timezone: TZ })
  return {
    t,
    owner,
    kevin,
    businessId,
    ownerMembershipId,
    kevinId,
    wattle,
    ocean,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** Puts the business in `timezone` and that zone's week at `monday`, as
 * a zone change and the cron would (zoneWeeks.ts). */
function setWeek(
  s: Pick<Setup, 't' | 'businessId'>,
  week: { monday?: string; timezone?: string },
) {
  return s.t.run(async (ctx) => {
    const zone = await ctx.db
      .query('businessZones')
      .withIndex('by_business', (q) => q.eq('businessId', s.businessId))
      .unique()
    const timezone = week.timezone ?? zone!.timezone
    await ctx.db.patch(zone!._id, { timezone })
    const row = await ctx.db
      .query('zoneWeeks')
      .withIndex('by_timezone', (q) => q.eq('timezone', timezone))
      .unique()
    const monday = week.monday ?? row?.monday ?? START
    if (row) await ctx.db.patch(row._id, { monday })
    else await ctx.db.insert('zoneWeeks', { timezone, monday })
  })
}

/** A job written as it is stored, so its status and slot are exactly as given. */
function insertJob(
  s: Setup,
  fields: Partial<Doc<'jobs'>> & { scheduledAt: number },
): Promise<Id<'jobs'>> {
  return s.t.run((ctx) =>
    ctx.db.insert('jobs', {
      businessId: s.businessId,
      propertyId: s.wattle,
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      durationMinutes: 60,
      status: 'pending',
      createdAt: Date.now(),
      ...fields,
    }),
  )
}

/** `count` pending jobs at Wattle St, in batches, at `when(i)`. */
async function insertMany(
  s: Setup,
  count: number,
  when: (i: number) => number,
) {
  const BATCH = 1000
  for (let from = 0; from < count; from += BATCH) {
    await s.t.run(async (ctx) => {
      for (let i = from; i < Math.min(count, from + BATCH); i++) {
        await ctx.db.insert('jobs', {
          businessId: s.businessId,
          propertyId: s.wattle,
          assignedMembershipId: s.ownerMembershipId,
          jobType: 'General Pest Control',
          price: 20000,
          scheduledAt: when(i),
          durationMinutes: 60,
          status: 'pending',
          createdAt: Date.now(),
        })
      }
    })
  }
}

/** A Recurring Job written as it is stored, with no visits of its own. */
function insertSeries(
  s: Setup,
  fields: Partial<Doc<'recurrences'>> = {},
): Promise<Id<'recurrences'>> {
  return s.t.run((ctx) =>
    ctx.db.insert('recurrences', {
      businessId: s.businessId,
      propertyId: s.ocean,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 3,
      intervalUnit: 'month',
      jobType: 'General Pest Control',
      price: 24000,
      anchorDate: at(START, 9),
      active: true,
      ...fields,
    }),
  )
}

function ask(actor: TestActor, s: Setup, startKey = START) {
  return actor.as.query(api.jobs.openWork, {
    businessId: s.businessId,
    startKey,
  })
}

type Answer = Awaited<ReturnType<typeof ask>>
type Row = Answer['rows'][number]

/** The row for a job, found by when it is booked. */
function rowAt(answer: Answer, scheduledAt: number): Row | undefined {
  return answer.rows.find((row) => row.scheduledAt === scheduledAt)
}

const idOf = (row: Row | undefined) =>
  row && 'jobId' in row ? row.jobId : undefined

describe('the window', () => {
  test.each([
    TZ,
    'Australia/Sydney',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
  ])(
    'every day of the business’s own twenty weeks in %s, and nothing two days beyond',
    async (zone) => {
      const s = await setup()
      // Where the business is: the query reads it from the business's week.
      await s.t.run((ctx) => ctx.db.patch(s.businessId, { timezone: zone }))
      await setWeek(s, { timezone: zone })
      const { firstKey, endKey } = openWorkDays(START)
      const lastKey = addDaysToKey(endKey, -1)

      const first = await insertJob(s, {
        scheduledAt: at(firstKey, 0, 0, zone),
      })
      const last = await insertJob(s, {
        scheduledAt: at(lastKey, 23, 59, zone),
      })
      const before = await insertJob(s, {
        scheduledAt: at(addDaysToKey(firstKey, -2), 12, 0, zone),
      })
      const after = await insertJob(s, {
        scheduledAt: at(addDaysToKey(endKey, 1), 12, 0, zone),
      })

      const ids = (await ask(s.owner, s)).rows.map(idOf)
      expect(ids).toContain(first)
      expect(ids).toContain(last)
      expect(ids).not.toContain(before)
      expect(ids).not.toContain(after)
    },
    // The first test here loads every Convex module.
    30_000,
  )

  test.each([TZ, 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])(
    'someone else’s work only within the business’s own days in %s, though more is read either side; the owner’s view whole',
    async (zone) => {
      const s = await setup()
      await s.t.run((ctx) => ctx.db.patch(s.businessId, { timezone: zone }))
      await setWeek(s, { timezone: zone })
      const { firstKey, endKey } = openWorkDays(START)
      const lastKey = addDaysToKey(endKey, -1)
      const inside = [
        await insertJob(s, { scheduledAt: at(firstKey, 0, 30, zone) }),
        await insertJob(s, { scheduledAt: at(lastKey, 23, 30, zone) }),
      ]
      // On the days either side, where read: in UTC+14 nothing before the
      // first day is.
      const { from, to } = openWorkSpan(START)
      const outside = []
      for (const scheduledAt of [
        at(addDaysToKey(firstKey, -1), 23, 30, zone),
        at(endKey, 0, 30, zone),
      ]) {
        if (scheduledAt >= from && scheduledAt < to) {
          outside.push(await insertJob(s, { scheduledAt }))
        }
      }
      expect(outside.length).toBeGreaterThan(0)
      const owners = (await ask(s.owner, s)).rows.map(idOf)
      expect(owners).toEqual(expect.arrayContaining([...inside, ...outside]))
      const kevins = (await ask(s.kevin, s)).rows.map((row) => row.scheduledAt)
      const when = (ids: Array<Id<'jobs'>>) =>
        s.t.run(async (ctx) =>
          Promise.all(
            ids.map(async (id) => (await ctx.db.get(id))!.scheduledAt),
          ),
        )
      expect(kevins.sort()).toEqual((await when(inside)).sort())
    },
  )

  test('in date order, by when each is booked', async () => {
    const s = await setup()
    const later = await insertJob(s, { scheduledAt: at(START, 14) })
    const sooner = await insertJob(s, { scheduledAt: at(START, 8) })
    const lastWeek = await insertJob(s, {
      scheduledAt: at(addDaysToKey(START, -5), 10),
    })

    const ids = (await ask(s.owner, s)).rows.map(idOf)
    expect(ids).toEqual([lastWeek, sooner, later])
  })

  test('only this business’s jobs', async () => {
    const s = await setup()
    const ours = await insertJob(s, { scheduledAt: at(START, 9) })
    const other = await createActor(s.t, { email: 'owner@other.test' })
    const { businessId: theirs, ownerMembershipId } = await createBusiness(
      s.t,
      other,
      'Other Pest',
    )
    await s.t.run(async (ctx) => {
      const clientId = await ctx.db.insert('clients', {
        businessId: theirs,
        kind: 'person',
        name: 'Someone Else',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const propertyId = await ctx.db.insert('properties', {
        businessId: theirs,
        clientId,
        addressLine: '1 Other St',
        suburb: 'Perth',
        state: 'WA',
        postcode: '6000',
        createdAt: Date.now(),
      })
      await ctx.db.insert('jobs', {
        businessId: theirs,
        propertyId,
        assignedMembershipId: ownerMembershipId,
        jobType: 'General Pest Control',
        price: 20000,
        scheduledAt: at(START, 9),
        durationMinutes: 60,
        status: 'pending',
        createdAt: Date.now(),
      })
    })

    expect((await ask(s.owner, s)).rows.map(idOf)).toEqual([ours])
  })
})

describe('what is left out', () => {
  test('cancelled jobs and the Recycle bin; work done stays, with its status', async () => {
    const s = await setup()
    const day = (n: number) => at(addDaysToKey(START, n), 9)
    await insertJob(s, { scheduledAt: day(0), status: 'pending' })
    await insertJob(s, { scheduledAt: day(1), status: 'booked' })
    await insertJob(s, { scheduledAt: day(2), status: 'recurring' })
    await insertJob(s, { scheduledAt: day(-3), status: 'completed' })
    await insertJob(s, { scheduledAt: day(-2), status: 'invoiced' })
    await insertJob(s, { scheduledAt: day(3), status: 'cancelled' })
    await insertJob(s, { scheduledAt: day(4), deletedAt: Date.now() })

    const { rows } = await ask(s.owner, s)
    expect(rows.map((row) => ('status' in row ? row.status : null))).toEqual([
      'completed',
      'invoiced',
      'pending',
      'booked',
      'recurring',
    ])
  })
})

describe('slots', () => {
  test('a visit holds the slot it was projected onto, wherever it has moved to', async () => {
    const s = await setup()
    const recurrenceId = await insertSeries(s)
    const projected = at(START, 9)
    const moved = await insertJob(s, {
      propertyId: s.ocean,
      recurrenceId,
      status: 'recurring',
      occurrenceAt: projected,
      scheduledAt: projected + 2 * 60 * MINUTE,
    })
    const oneOff = await insertJob(s, { scheduledAt: at(START, 13) })

    const { rows } = await ask(s.owner, s)
    expect(rows.find((row) => idOf(row) === moved)).toMatchObject({
      at: projected,
      scheduledAt: projected + 2 * 60 * MINUTE,
      recurrenceId,
    })
    expect(rows.find((row) => idOf(row) === oneOff)).toMatchObject({
      at: at(START, 13),
      scheduledAt: at(START, 13),
    })
  })
})

describe('whose rows say what', () => {
  async function seeded() {
    const s = await setup()
    const day = (n: number, hh = 9) => at(addDaysToKey(START, n), hh)
    const ownersSeries = await insertSeries(s)
    const kevinsSeries = await insertSeries(s, {
      propertyId: s.wattle,
      assignedMembershipId: s.kevinId,
      intervalCount: 1,
      intervalUnit: 'week',
      jobType: 'Rodents',
    })
    const ids = {
      ownersSeries,
      kevinsSeries,
      ownersJob: await insertJob(s, { scheduledAt: day(1) }),
      ownersVisit: await insertJob(s, {
        propertyId: s.ocean,
        recurrenceId: ownersSeries,
        status: 'recurring',
        occurrenceAt: day(2),
        scheduledAt: day(2),
      }),
      ownersDone: await insertJob(s, {
        scheduledAt: day(-3),
        status: 'completed',
      }),
      ownersBilled: await insertJob(s, {
        scheduledAt: day(-2),
        status: 'invoiced',
      }),
      kevinsJob: await insertJob(s, {
        scheduledAt: day(3),
        assignedMembershipId: s.kevinId,
      }),
      kevinsDone: await insertJob(s, {
        scheduledAt: day(-1),
        assignedMembershipId: s.kevinId,
        status: 'completed',
      }),
      kevinsVisit: await insertJob(s, {
        recurrenceId: kevinsSeries,
        assignedMembershipId: s.kevinId,
        status: 'recurring',
        occurrenceAt: day(4),
        scheduledAt: day(4),
      }),
      // The owner leads; Kevin is also going.
      shared: await insertJob(s, { scheduledAt: day(5) }),
    }
    await s.t.run((ctx) =>
      ctx.db.insert('jobPeople', {
        businessId: s.businessId,
        jobId: ids.shared,
        membershipId: s.kevinId,
        scheduledAt: day(5),
        addedBy: s.ownerMembershipId,
        addedAt: Date.now(),
      }),
    )
    return { s, ids, day }
  }

  test('a subcontractor gets anyone else’s open work as a site and a date, and nothing more', async () => {
    const { s, ids, day } = await seeded()
    const answer = await ask(s.kevin, s)

    expect(rowAt(answer, day(1))).toEqual({
      propertyId: s.wattle,
      at: day(1),
      scheduledAt: day(1),
    })
    // A visit says which Recurring Job it is of, by an id that says nothing
    // more (a booking names it as seen).
    expect(rowAt(answer, day(2))).toEqual({
      propertyId: s.ocean,
      at: day(2),
      scheduledAt: day(2),
      series: ids.ownersSeries,
    })
  })

  test('and nothing of anyone else’s work done', async () => {
    const { s, day } = await seeded()
    const answer = await ask(s.kevin, s)
    expect(rowAt(answer, day(-3))).toBeUndefined()
    expect(rowAt(answer, day(-2))).toBeUndefined()
  })

  test('their own work, done or not, and what they are also going on, in full', async () => {
    const { s, ids, day } = await seeded()
    const answer = await ask(s.kevin, s)

    expect(rowAt(answer, day(3))).toEqual({
      propertyId: s.wattle,
      at: day(3),
      scheduledAt: day(3),
      status: 'pending',
      jobId: ids.kevinsJob,
      jobType: 'General Pest Control',
      assignedMembershipId: s.kevinId,
    })
    expect(rowAt(answer, day(-1))).toMatchObject({
      jobId: ids.kevinsDone,
      status: 'completed',
    })
    expect(rowAt(answer, day(4))).toMatchObject({
      jobId: ids.kevinsVisit,
      recurrenceId: ids.kevinsSeries,
      status: 'recurring',
    })
    expect(rowAt(answer, day(5))).toMatchObject({
      jobId: ids.shared,
      assignedMembershipId: s.ownerMembershipId,
    })
  })

  test('the owner gets every row in full', async () => {
    const { s, ids } = await seeded()
    const answer = await ask(s.owner, s)
    const jobs = [
      ids.ownersJob,
      ids.ownersVisit,
      ids.ownersDone,
      ids.ownersBilled,
      ids.kevinsJob,
      ids.kevinsDone,
      ids.kevinsVisit,
      ids.shared,
    ]
    expect(new Set(answer.rows.map(idOf))).toEqual(new Set(jobs))
  })

  test('no price, ever', async () => {
    const { s } = await seeded()
    for (const who of [s.owner, s.kevin]) {
      const { rows } = await ask(who, s)
      for (const row of rows) expect(row).not.toHaveProperty('price')
    }
  })

  test('the owner’s “Just my jobs” still names every job: it is about the house, not the list', async () => {
    const { s, ids, day } = await seeded()
    await s.owner.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'mine' },
    })
    expect(rowAt(await ask(s.owner, s), day(3))).toMatchObject({
      jobId: ids.kevinsJob,
    })
  })
})

describe('Recurring Jobs', () => {
  test('the viewer’s own with its interval and services; anyone else’s with its next visit only', async () => {
    const s = await setup()
    // An old row, from before custom intervals: read as every 3 months.
    const ownersSeries = await insertSeries(s, {
      intervalCount: undefined,
      intervalUnit: undefined,
      frequency: 'quarterly',
    })
    const kevinsSeries = await insertSeries(s, {
      propertyId: s.wattle,
      assignedMembershipId: s.kevinId,
      intervalCount: 2,
      intervalUnit: 'week',
      jobType: 'Rodents',
    })
    const next = at(addDaysToKey(START, 1), 9)
    for (const [recurrenceId, assignedMembershipId] of [
      [ownersSeries, s.ownerMembershipId],
      [kevinsSeries, s.kevinId],
    ] as const) {
      await insertJob(s, {
        recurrenceId,
        assignedMembershipId,
        status: 'recurring',
        occurrenceAt: next,
        scheduledAt: next,
      })
    }

    const forKevin = await ask(s.kevin, s)
    expect(forKevin.series).toEqual([
      { _id: ownersSeries, propertyId: s.ocean, nextAt: next },
      {
        _id: kevinsSeries,
        propertyId: s.wattle,
        nextAt: next,
        intervalCount: 2,
        intervalUnit: 'week',
        jobType: 'Rodents',
      },
    ])

    const forOwner = await ask(s.owner, s)
    expect(forOwner.series[0]).toEqual({
      _id: ownersSeries,
      propertyId: s.ocean,
      nextAt: next,
      intervalCount: 3,
      intervalUnit: 'month',
      jobType: 'General Pest Control',
    })
    expect(forOwner.series[1]).toHaveProperty('jobType', 'Rodents')
  })

  test('only running ones, and none in the Recycle bin', async () => {
    const s = await setup()
    const running = await insertSeries(s)
    await insertSeries(s, { active: false })
    await insertSeries(s, { deletedAt: Date.now() })

    const { series } = await ask(s.owner, s)
    expect(series.map((r) => r._id)).toEqual([running])
  })

  test('the next visit is the first still open from the start of the week', async () => {
    const s = await setup()
    const recurrenceId = await insertSeries(s)
    const visit = (n: number, status: Doc<'jobs'>['status']) => {
      const scheduledAt = at(addDaysToKey(START, n), 9)
      return insertJob(s, {
        propertyId: s.ocean,
        recurrenceId,
        status,
        occurrenceAt: scheduledAt,
        scheduledAt,
      })
    }
    // Due last week and never actioned: still a row, but behind the week.
    await visit(-6, 'recurring')
    await visit(1, 'completed')
    await visit(2, 'cancelled')
    await visit(9, 'booked')
    await visit(16, 'recurring')
    const idle = await insertSeries(s, { propertyId: s.wattle })

    const { series } = await ask(s.owner, s)
    expect(series.find((r) => r._id === recurrenceId)?.nextAt).toBe(
      at(addDaysToKey(START, 9), 9),
    )
    // Nothing open in the window: no next visit is claimed.
    expect(series.find((r) => r._id === idle)).not.toHaveProperty('nextAt')
  })
})

describe('limits', () => {
  test('past the limit it says capped, drops the furthest weeks first, and doesn’t throw', async () => {
    const s = await setup()
    const { firstKey } = openWorkDays(START)
    const start = at(firstKey, 6)
    // One more than the limit, ten minutes apart, then one far off.
    await insertMany(s, OPEN_WORK_LIMIT + 1, (i) => start + i * 10 * MINUTE)
    const far = await insertJob(s, {
      scheduledAt: at(addDaysToKey(START, 100), 9),
    })

    const answer = await ask(s.owner, s)
    expect(answer.capped).toBe(true)
    expect(answer.rows).toHaveLength(OPEN_WORK_LIMIT)
    expect(answer.rows[0].scheduledAt).toBe(start)
    expect(answer.rows.at(-1)?.scheduledAt).toBe(
      start + (OPEN_WORK_LIMIT - 1) * 10 * MINUTE,
    )
    expect(answer.rows.map(idOf)).not.toContain(far)
  }, 60_000)

  test('never sends half of the jobs booked for one time when the limit falls between them', async () => {
    const s = await setup()
    const start = at(openWorkDays(START).firstKey, 6)
    // The last two share a time, and the second is past the limit: what
    // was read is whole only before that time, so neither is sent.
    await insertMany(
      s,
      OPEN_WORK_LIMIT + 1,
      (i) => start + Math.min(i, OPEN_WORK_LIMIT - 1) * 10 * MINUTE,
    )

    const answer = await ask(s.owner, s)
    expect(answer.capped).toBe(true)
    expect(answer.rows).toHaveLength(OPEN_WORK_LIMIT - 1)
    expect(answer.rows.at(-1)?.scheduledAt).toBe(
      start + (OPEN_WORK_LIMIT - 2) * 10 * MINUTE,
    )
  }, 60_000)

  test('past the limit of running Recurring Jobs it says capped too', async () => {
    const s = await setup()
    const BATCH = 1000
    for (let from = 0; from <= OPEN_WORK_LIMIT; from += BATCH) {
      await s.t.run(async (ctx) => {
        for (
          let i = from;
          i < Math.min(OPEN_WORK_LIMIT + 1, from + BATCH);
          i++
        ) {
          await ctx.db.insert('recurrences', {
            businessId: s.businessId,
            propertyId: s.ocean,
            assignedMembershipId: s.ownerMembershipId,
            intervalCount: 3,
            intervalUnit: 'month',
            jobType: 'General Pest Control',
            price: 24000,
            anchorDate: at(START, 9),
            active: true,
          })
        }
      })
    }

    const answer = await ask(s.owner, s)
    expect(answer.capped).toBe(true)
    expect(answer.series).toHaveLength(OPEN_WORK_LIMIT)
  }, 60_000)

  test('says nothing of a limit when under it', async () => {
    const s = await setup()
    await insertJob(s, { scheduledAt: at(START, 9) })
    expect(await ask(s.owner, s)).not.toHaveProperty('capped')
  })
})

describe('size', () => {
  /**
   * What each row and Recurring Job costs as it is sent, which the plan's
   * sizes are to be worked from: nearly all of an answer is its rows, and
   * every job written in the window sends the whole answer again. Ids are
   * their real length here (convex-test pads them to 32 characters, as
   * Convex's own are), times are the 13 digits they are, a job number has
   * four and the service is "General Pest Control". Measured 27 Oct 2026 at
   * 266 B and 318 B for a job and a visit in full, 96 B and 140 B for
   * someone else's, and 187 B and 113 B for a Recurring Job of the viewer's
   * and of someone else's: so, a third of the jobs being visits, about
   * 1.7 MB for the owner at OPEN_WORK_LIMIT rows, and 53 KB at 172 jobs. A
   * field added to any of them shows here.
   */
  test('a job in full is under 270 B, a visit under 320 B, and someone else’s under 100 B and 145 B', async () => {
    const s = await setup()
    const day = (n: number) => at(addDaysToKey(START, n), 9)
    const ownersSeries = await insertSeries(s)
    const kevinsSeries = await insertSeries(s, {
      propertyId: s.wattle,
      assignedMembershipId: s.kevinId,
    })
    const visit = (
      recurrenceId: Id<'recurrences'>,
      assignedMembershipId: Id<'memberships'>,
      n: number,
    ) =>
      insertJob(s, {
        recurrenceId,
        assignedMembershipId,
        status: 'recurring',
        occurrenceAt: day(n),
        scheduledAt: day(n),
        jobNumber: 1000 + n,
      })
    await insertJob(s, { scheduledAt: day(1), jobNumber: 1001 })
    await visit(ownersSeries, s.ownerMembershipId, 2)
    await insertJob(s, {
      scheduledAt: day(3),
      assignedMembershipId: s.kevinId,
      jobNumber: 1003,
    })
    await visit(kevinsSeries, s.kevinId, 4)

    const { rows, series } = await ask(s.kevin, s)
    const bytes = (value: unknown) => JSON.stringify(value).length
    const sizeAt = (n: number) => bytes(rowAt({ rows, series }, day(n)))
    const seriesSize = (id: Id<'recurrences'>) =>
      bytes(series.find((r) => r._id === id))

    // The owner's, as Kevin sees them: a site and a date.
    expect(sizeAt(1)).toBeLessThanOrEqual(100)
    expect(sizeAt(2)).toBeLessThanOrEqual(145)
    // Kevin's own, in full.
    expect(sizeAt(3)).toBeLessThanOrEqual(270)
    expect(sizeAt(4)).toBeLessThanOrEqual(320)
    expect(seriesSize(ownersSeries)).toBeLessThanOrEqual(120)
    expect(seriesSize(kevinsSeries)).toBeLessThanOrEqual(190)
  })
})

describe('what it reads', () => {
  test('answers without the business’s row, which every booking patches', async () => {
    const s = await setup()
    const job = await insertJob(s, { scheduledAt: at(START, 9) })
    await s.t.run((ctx) => ctx.db.delete(s.businessId))
    expect((await ask(s.owner, s)).rows.map(idOf)).toEqual([job])
  })

  test('refuses a day that isn’t one', async () => {
    const s = await setup()
    for (const startKey of ['2026-11-31', '20261102', 'next week']) {
      await expect(ask(s.owner, s, startKey)).rejects.toThrow('INVALID_DAY')
    }
  })

  test('answers only for the business’s own week, whoever asks (C5, 1 Nov 2026)', async () => {
    const s = await setup()
    const job = await insertJob(s, { scheduledAt: at(START, 9) })
    expect((await ask(s.owner, s)).rows.map(idOf)).toEqual([job])
    expect((await ask(s.kevin, s)).rows).toHaveLength(1)
    // Any other week, near or a year away, or a day that isn't its Monday:
    // no one may ask for anyone's work at whatever date they like.
    for (const startKey of [
      addDaysToKey(START, -7),
      addDaysToKey(START, 7),
      addDaysToKey(START, 364),
      addDaysToKey(START, -364),
      addDaysToKey(START, 1),
    ]) {
      for (const actor of [s.kevin, s.owner]) {
        await expect(ask(actor, s, startKey)).rejects.toThrow('INVALID_WEEK')
      }
    }
  })

  test('the week moved on answers for the new one, and no longer for the old', async () => {
    const s = await setup()
    const next = addDaysToKey(START, 7)
    await setWeek(s, { monday: next })
    expect((await ask(s.owner, s, next)).rows).toEqual([])
    await expect(ask(s.owner, s)).rejects.toThrow('INVALID_WEEK')
  })

  test('a business with no zone kept yet answers for no week', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      for (const row of await ctx.db.query('businessZones').collect()) {
        await ctx.db.delete(row._id)
      }
    })
    await expect(ask(s.owner, s)).rejects.toThrow('INVALID_WEEK')
  })

  test('refuses someone who isn’t in the business', async () => {
    const s = await setup()
    const stranger = await createActor(s.t, { email: 'stranger@else.test' })
    await expect(ask(stranger, s)).rejects.toThrow('NO_ACCESS')
  })
})
