/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { addDaysToKey, dayKeyOf } from './lib/dates'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Phase 3, Recurring Jobs. Two rules, and they pull in opposite directions,
 * which is why they are tested together:
 *
 *  - a projected `recurring` visit is never folded into a job total. Not the
 *    day agenda, not the week strip, not the month grid, not the team legend,
 *    not the Job tab's list, not the dashboard.
 *  - the Recurring Job view is where they ARE read — and it counts the
 *    arrangements, not the visits, because the engine only projects visits
 *    inside a 180-day horizon and the two numbers have no fixed relationship.
 */

const DAY = 24 * 60 * 60 * 1000
const TZ = 'Australia/Perth'

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const propertyId = await seedProperty(t, businessId)
  return { t, owner, businessId, ownerMembershipId, propertyId }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function seedProperty(t: TestApp, businessId: Id<'businesses'>) {
  return t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
  })
}

async function join(
  t: TestApp,
  owner: TestActor,
  invitee: TestActor,
  businessId: Id<'businesses'>,
) {
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email: invitee.email,
    role: 'subcontractor',
  })
  await invitee.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
  const membership = await t.run(async (ctx) =>
    ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', invitee.userId).eq('businessId', businessId),
      )
      .unique(),
  )
  return membership!._id
}

function series(
  s: Setup,
  interval: { count: number; unit: 'day' | 'week' | 'month' | 'year' },
  anchorDate = Date.now() + DAY,
  assignedMembershipId = s.ownerMembershipId,
) {
  return s.owner.as.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId,
    intervalCount: interval.count,
    intervalUnit: interval.unit,
    jobType: 'Rodents',
    price: 18000,
    anchorDate,
    durationMinutes: 45,
  })
}

function recurringView(s: Setup, as = s.owner.as) {
  return as.query(api.jobs.listRecurring, { businessId: s.businessId })
}

describe('the Recurring Job view counts arrangements, not visits', () => {
  test('a fortnightly series is one Recurring Job, whatever it has projected', async () => {
    const s = await setup()
    await series(s, { count: 2, unit: 'week' })

    const view = await recurringView(s)
    // A fortnight apart across a 180-day horizon, anchored tomorrow: 13
    // occurrences, the first of which is the hand-booked `pending` one — so
    // 12 projected. Pinned exactly; ">5" would have passed just as happily if
    // the engine had stopped after six.
    expect(view.jobs).toHaveLength(12)
    expect(view.jobs.every((j) => j.status === 'recurring')).toBe(true)
    // And exactly one arrangement. Counting the cards would have said 12.
    expect(view.seriesCount).toBe(1)
  })

  test('a 15-year series is one Recurring Job with nothing projected at all', async () => {
    const s = await setup()
    await series(s, { count: 15, unit: 'year' })

    const view = await recurringView(s)
    // The next visit is 15 years out, far past the horizon — so there is no
    // `recurring` record anywhere. The arrangement is still real.
    expect(view.jobs).toHaveLength(0)
    expect(view.seriesCount).toBe(1)
  })

  test('two series are two, however differently they project', async () => {
    const s = await setup()
    await series(s, { count: 1, unit: 'week' })
    await series(s, { count: 15, unit: 'year' })

    expect((await recurringView(s)).seriesCount).toBe(2)
  })

  test('ending a series stops it being counted', async () => {
    const s = await setup()
    const recurrenceId = await series(s, { count: 1, unit: 'month' })
    expect((await recurringView(s)).seriesCount).toBe(1)

    await s.owner.as.mutation(api.recurrences.setActive, {
      businessId: s.businessId,
      recurrenceId,
      active: false,
    })

    const view = await recurringView(s)
    expect(view.seriesCount).toBe(0)
    // And its projected visits went with it — they were cancelled, so they
    // are no longer `recurring` either.
    expect(view.jobs).toHaveLength(0)
  })

  test('a subcontractor is not told the size of the owner’s book', async () => {
    const s = await setup()
    const kevin = await createActor(s.t, { email: 'kevin@coastal.test' })
    const kevinMembershipId = await join(s.t, s.owner, kevin, s.businessId)

    await series(s, { count: 1, unit: 'month' })
    await series(
      s,
      { count: 1, unit: 'month' },
      Date.now() + 2 * DAY,
      kevinMembershipId,
    )

    expect((await recurringView(s)).seriesCount).toBe(2)
    // Kevin sees his own arrangement and no sign of Terence's.
    const his = await recurringView(s, kevin.as)
    expect(his.seriesCount).toBe(1)
    expect(
      his.jobs.every((j) => j.assignedMembershipId === kevinMembershipId),
    ).toBe(true)
  })
})

describe('projected visits stay out of every job total', () => {
  test('the day agenda shows the hand-booked visit and not the projected ones', async () => {
    const s = await setup()
    const anchor = Date.now() + DAY
    await series(s, { count: 1, unit: 'day' }, anchor)

    // Tomorrow holds the first visit, which the person booked: `pending`.
    const day = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(anchor, TZ),
    })
    expect(day).toHaveLength(1)
    expect(day[0].status).toBe('pending')

    // The day after holds only a projection, so it holds nothing.
    const next = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(anchor + DAY, TZ),
    })
    expect(next).toHaveLength(0)
  })

  test('a projection whose day has ARRIVED is shown — hiding it is a missed service', async () => {
    const s = await setup()
    const recurrenceId = await series(s, { count: 1, unit: 'week' })

    // Take a projected visit and move it to today, the way time passing would.
    const projected = (
      await s.t.run(async (ctx) =>
        ctx.db
          .query('jobs')
          .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
          .collect(),
      )
    )
      .filter((j) => j.status === 'recurring')
      .sort((a, b) => a.scheduledAt - b.scheduledAt)[0]

    const today = dayKeyOf(Date.now(), TZ)
    await s.t.run(async (ctx) =>
      ctx.db.patch(projected._id, { scheduledAt: Date.now() + 60 * 60 * 1000 }),
    )

    const day = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: today,
    })
    const shown = day.find((j) => j._id === projected._id)
    expect(shown).toBeDefined()
    expect(shown?.status).toBe('recurring')
  })

  test('an OVERDUE projection is still shown on the day it was due', async () => {
    const s = await setup()
    const recurrenceId = await series(s, { count: 1, unit: 'week' })
    const projected = (
      await s.t.run(async (ctx) =>
        ctx.db
          .query('jobs')
          .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
          .collect(),
      )
    ).filter((j) => j.status === 'recurring')[0]

    const threeDaysAgo = Date.now() - 3 * DAY
    await s.t.run(async (ctx) =>
      ctx.db.patch(projected._id, { scheduledAt: threeDaysAgo }),
    )

    const day = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(threeDaysAgo, TZ),
    })
    expect(day.map((j) => j._id)).toContain(projected._id)
  })

  test('but a projection still in the future stays off the day', async () => {
    const s = await setup()
    const anchor = Date.now() + DAY
    await series(s, { count: 1, unit: 'day' }, anchor)

    // The day after tomorrow holds only a projection, and its day has not
    // arrived — this is the noise the hiding exists to remove.
    const future = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(anchor + DAY, TZ),
    })
    expect(future).toHaveLength(0)
  })

  test('a due projection is shown but still counted nowhere', async () => {
    const s = await setup()
    const recurrenceId = await series(s, { count: 1, unit: 'week' })
    const projected = (
      await s.t.run(async (ctx) =>
        ctx.db
          .query('jobs')
          .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
          .collect(),
      )
    ).filter((j) => j.status === 'recurring')[0]

    const today = dayKeyOf(Date.now(), TZ)
    await s.t.run(async (ctx) =>
      ctx.db.patch(projected._id, { scheduledAt: Date.now() + 60 * 60 * 1000 }),
    )

    // Shown on the day...
    const day = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: today,
    })
    expect(day.map((j) => j._id)).toContain(projected._id)

    // ...and absent from every count. Shown, not counted.
    const week = await s.owner.as.query(api.jobs.listWeek, {
      businessId: s.businessId,
      startKey: today,
    })
    const todayCell = week.find((d) => d.dayKey === today)
    expect(todayCell?.count ?? 0).toBe(0)

    const month = await s.owner.as.query(api.jobs.listMonth, {
      businessId: s.businessId,
      monthKey: today.slice(0, 7),
    })
    expect(month.find((d) => d.dayKey === today)?.count ?? 0).toBe(0)

    const summary = await s.owner.as.query(api.dashboard.summary, {
      businessId: s.businessId,
    })
    expect(summary?.todayCount).toBe(0)
  })

  test('the week strip counts only the hand-booked visit', async () => {
    const s = await setup()
    const anchor = Date.now() + DAY
    await series(s, { count: 1, unit: 'day' }, anchor)

    const week = await s.owner.as.query(api.jobs.listWeek, {
      businessId: s.businessId,
      startKey: dayKeyOf(Date.now(), TZ),
    })
    // A daily series projects a visit on every one of the next seven days.
    // Exactly one of them is work anybody has actually booked.
    expect(week.reduce((n, d) => n + d.count, 0)).toBe(1)
  })

  test('the month grid and the team legend agree with it', async () => {
    const s = await setup()
    const anchor = Date.now() + DAY
    await series(s, { count: 1, unit: 'day' }, anchor)
    const monthKey = dayKeyOf(anchor, TZ).slice(0, 7)

    const month = await s.owner.as.query(api.jobs.listMonth, {
      businessId: s.businessId,
      monthKey,
    })
    const load = await s.owner.as.query(api.jobs.monthTeamLoad, {
      businessId: s.businessId,
      monthKey,
    })

    const monthTotal = month.reduce((n, d) => n + d.count, 0)
    const loadTotal = load.reduce((n, r) => n + r.count, 0)
    expect(monthTotal).toBe(1)
    expect(loadTotal).toBe(1)
  })

  test('the Job tab is the one list that still holds them, and says so', async () => {
    const s = await setup()
    await series(s, { count: 1, unit: 'week' })

    const list = await s.owner.as.query(api.jobs.list, {
      businessId: s.businessId,
    })
    // Pinned deliberately: `jobs.list` reads the newest rows by creation, and
    // projections ARE the newest rows, so filtering them after the read would
    // empty the page rather than clean it up (see the comment on `list`). The
    // reader has the status filter; the Recurring Job view is where they are
    // read on purpose. If this ever starts failing because a status-aware
    // index landed, the exclusion is what to assert instead.
    expect(list.jobs.some((j) => j.status === 'recurring')).toBe(true)
    expect(list.jobs.some((j) => j.status === 'pending')).toBe(true)
  })

  test('a cancelled series leaves no trace in either place', async () => {
    const s = await setup()
    const recurrenceId = await series(s, { count: 1, unit: 'week' })
    await s.owner.as.mutation(api.recurrences.setActive, {
      businessId: s.businessId,
      recurrenceId,
      active: false,
    })

    const week = await s.owner.as.query(api.jobs.listWeek, {
      businessId: s.businessId,
      startKey: dayKeyOf(Date.now(), TZ),
    })
    expect(week.reduce((n, d) => n + d.count, 0)).toBe(0)
    expect((await recurringView(s)).jobs).toHaveLength(0)
  })
})

describe('an interval the fixed list could not express', () => {
  test('every 2 days projects on the right dates', async () => {
    const s = await setup()
    const anchor = Date.now() + DAY
    const recurrenceId = await series(s, { count: 2, unit: 'day' }, anchor)

    const visits = await s.t.run(async (ctx) =>
      ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect(),
    )
    // Compared as tenant DAYS, not milliseconds. A series steps the tenant's
    // calendar, so across a DST transition two visits two days apart are 47 or
    // 49 hours apart — and the anchor keeps its own exact instant while later
    // occurrences are minute-aligned. An exact-ms delta asserts neither of
    // those truths and fails on both.
    const keys = visits
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map((v) => dayKeyOf(v.scheduledAt, TZ))
    expect(keys[1]).toBe(addDaysToKey(keys[0], 2))
    expect(keys[2]).toBe(addDaysToKey(keys[1], 2))
  })

  test('a daily series is capped per run, and the next run resumes without a hole', async () => {
    const s = await setup()
    const recurrenceId = await series(s, { count: 1, unit: 'day' })

    const visitsNow = async () => {
      const rows = await s.t.run(async (ctx) =>
        ctx.db
          .query('jobs')
          .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
          .collect(),
      )
      return rows.sort((a, b) => a.scheduledAt - b.scheduledAt)
    }

    // 180 days of daily visits would be ~181 inserts in one transaction. The
    // first run stops at MAX_VISITS_PER_RUN, plus the hand-booked anchor.
    expect(await visitsNow()).toHaveLength(61)

    // THE HALF THAT MATTERS: the cron must actually finish. A cap that stops
    // and never resumes passes the assertion above just as well, and that is
    // precisely what a stalled series looks like.
    await s.t.mutation(internal.recurrences.materialiseAll, {})
    expect(await visitsNow()).toHaveLength(121)

    await s.t.mutation(internal.recurrences.materialiseAll, {})
    // 180, not 181: the anchor is tomorrow, so the last occurrence inside a
    // 180-day horizon is the 180th day from it.
    const full = await visitsNow()
    expect(full).toHaveLength(180)

    // No gap anywhere: consecutive visits are one tenant-day apart, all the
    // way out to the horizon.
    for (let i = 1; i < full.length; i++) {
      expect(dayKeyOf(full[i].scheduledAt, TZ), `gap before visit ${i}`).toBe(
        addDaysToKey(dayKeyOf(full[i - 1].scheduledAt, TZ), 1),
      )
    }

    // A fourth run adds nothing — the horizon is full and it stays idempotent.
    await s.t.mutation(internal.recurrences.materialiseAll, {})
    expect(await visitsNow()).toHaveLength(180)
  })

  test('moving a projected visit does not free its slot for a duplicate', async () => {
    const s = await setup()
    const recurrenceId = await series(s, { count: 1, unit: 'week' })
    const load = async () =>
      s.t.run(async (ctx) =>
        ctx.db
          .query('jobs')
          .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
          .collect(),
      )

    const before = await load()
    const projected = before
      .filter((j) => j.status === 'recurring')
      .sort((a, b) => a.scheduledAt - b.scheduledAt)[0]

    // An ordinary edit — the job detail sheet offers exactly this on a
    // projected visit.
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId: projected._id,
      scheduledAt: projected.scheduledAt + 2 * 60 * 60 * 1000,
    })
    await s.t.mutation(internal.recurrences.materialiseAll, {})

    // The engine identifies an occurrence by `occurrenceAt`, not by where the
    // visit currently sits, so the instant the moved one vacated is NOT
    // re-booked. Matching on `scheduledAt` grew the series one phantom visit
    // per reschedule and double-booked the property that day.
    const after = await load()
    expect(after).toHaveLength(before.length)
    expect(
      after.filter((j) => j.scheduledAt === projected.scheduledAt),
    ).toHaveLength(0)
  })

  test('the interval is refused before anything is written', async () => {
    const s = await setup()
    await expect(series(s, { count: 0, unit: 'day' })).rejects.toThrow()
    await expect(series(s, { count: -1, unit: 'week' })).rejects.toThrow()
    await expect(series(s, { count: 2.5, unit: 'month' })).rejects.toThrow()

    const left = await s.t.run(async (ctx) =>
      ctx.db.query('recurrences').collect(),
    )
    expect(left).toHaveLength(0)
  })
})
