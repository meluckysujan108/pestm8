/// <reference types="vite/client" />
import { beforeAll, describe, expect, test } from 'vitest'
import { api, internal } from '../_generated/api'
import { addDaysToKey, dayKeyOf, timeKeyOf } from '../lib/dates'
import { NOT_STARTED_STATUSES, isCountedJob } from '../lib/jobStatus'
import { HORIZON_DAYS, intervalOf, occurrencesFrom } from '../lib/recurrence'
import { runDemoSteps } from '../../test/demoFixture'
import { NAMED_JOBS, NAMED_VISITS, at } from './shared'
import type { DemoRun } from '../../test/demoFixture'
import type { TestApp } from '../../test/harness'
import type { Doc, Id } from '../_generated/dataModel'
import type { ManifestJob, MemberKey } from './shared'

/**
 * The demo's jobs step: the one-offs, the Recurring Jobs and their visits.
 *
 * Two kinds of check. The data is what the brief asks for (today has every
 * status for everyone, one month is light, the named jobs are where the
 * later steps look for them). And it is data the app could have written
 * itself: statuses only the app's paths produce, job numbers in booking
 * order, nobody's work outside their time on the team, and series the
 * nightly cron finds complete — which is checked by running the cron.
 */

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const PEOPLE: Array<Exclude<MemberKey, 'former'>> = [
  'owner',
  'contractor',
  'sub',
  'dana',
]

async function rowsOf(t: TestApp, businessId: Id<'businesses'>) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db
      .query('jobs')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    const photos = []
    for (const job of jobs) {
      photos.push(
        ...(await ctx.db
          .query('jobPhotos')
          .withIndex('by_job', (q) => q.eq('jobId', job._id))
          .collect()),
      )
    }
    return {
      business: await ctx.db.get(businessId),
      jobs,
      series: await ctx.db
        .query('recurrences')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .collect(),
      members: await ctx.db
        .query('memberships')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .collect(),
      properties: await ctx.db
        .query('properties')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .collect(),
      photos,
    }
  })
}

type Rows = Awaited<ReturnType<typeof rowsOf>>

describe('the demo jobs', () => {
  let run: DemoRun
  let rows: Rows
  let seededBy: number
  beforeAll(async () => {
    run = await runDemoSteps('jobs')
    seededBy = Date.now()
    rows = await rowsOf(run.t, run.base.businessId)
  })

  const when = (day: number, hh: number, mm = 0) => at(run.base, day, hh, mm)
  const tz = () => run.base.timezone
  const job = (id: Id<'jobs'>): Doc<'jobs'> => {
    const found = rows.jobs.find((j) => j._id === id)
    if (!found) throw new Error(`no job ${id}`)
    return found
  }
  const named = (key: string): ManifestJob => {
    const found = [...run.oneOff, ...run.series].filter((m) => m.key === key)
    expect(found, key).toHaveLength(1)
    return found[0]
  }
  const oneOffs = () => run.oneOff.map((m) => job(m.id))
  const seriesByKey = (key: string): Doc<'recurrences'> => {
    const visit = run.series.find((m) => m.recurrenceKey === key)
    const recurrenceId = visit && job(visit.id).recurrenceId
    const found = rows.series.find((s) => s._id === recurrenceId)
    if (!found) throw new Error(`no series ${key}`)
    return found
  }
  const visitsOf = (recurrenceId: Id<'recurrences'>) =>
    rows.jobs
      .filter((j) => j.recurrenceId === recurrenceId)
      .sort((a, b) => (a.occurrenceAt ?? 0) - (b.occurrenceAt ?? 0))
  const dayOf = (ts: number) => dayKeyOf(ts, tz())
  const offsetOf = (ts: number) => {
    for (let d = -800; d < 800; d++) {
      if (ts >= when(d, 0) && ts < when(d + 1, 0)) return d
    }
    throw new Error('out of range')
  }
  const member = (key: MemberKey) => run.base.members[key]
  const keyOfMember = (id: Id<'memberships'>) =>
    (Object.keys(run.base.members) as Array<MemberKey>).find(
      (k) => run.base.members[k] === id,
    )

  // ───────────────────────────────────────────────────── the named jobs

  test('every named job is there once, exactly as specified', () => {
    for (const spec of NAMED_JOBS) {
      const entry = named(spec.key)
      const row = job(entry.id)
      const scheduledAt = when(spec.day, spec.hh, spec.mm)
      expect(row, spec.key).toMatchObject({
        businessId: run.base.businessId,
        propertyId: run.properties[spec.propertyKey],
        assignedMembershipId: member(spec.assignee),
        scheduledAt,
        durationMinutes: spec.durationMinutes,
        jobType: spec.jobType,
        price: spec.priceCents,
        status: spec.status,
      })
      expect(entry).toMatchObject({
        propertyKey: spec.propertyKey,
        assignee: spec.assignee,
        status: spec.status,
        scheduledAt,
        durationMinutes: spec.durationMinutes,
        jobType: spec.jobType,
      })
      expect(entry.recurrenceKey).toBeUndefined()

      // Completed through jobs.complete, which alone stamps completedAt;
      // invoiced after it.
      if (spec.status === 'completed' || spec.status === 'invoiced') {
        expect(row.completedAt, spec.key).toBeGreaterThanOrEqual(
          scheduledAt + spec.durationMinutes * MINUTE,
        )
      } else {
        expect(row, spec.key).not.toHaveProperty('completedAt')
      }
      if (spec.startedMinutesAfter !== undefined) {
        expect(row.startedAt).toBe(
          scheduledAt + spec.startedMinutesAfter * MINUTE,
        )
      } else {
        expect(row, spec.key).not.toHaveProperty('startedAt')
      }
    }
  })

  // ───────────────────────────────────────── what the app could have written

  test('job numbers run in the order the jobs went in, and the counter is next', () => {
    const inOrder = [...rows.jobs].sort(
      (a, b) => a._creationTime - b._creationTime,
    )
    expect(inOrder.map((j) => j.jobNumber)).toEqual(
      inOrder.map((_, i) => i + 1),
    )
    expect(rows.business?.nextJobNumber).toBe(rows.jobs.length + 1)

    // One-offs went in in the order they were booked, so the Job tab's
    // newest-first reads as a booking history.
    const booked = oneOffs().sort(
      (a, b) => (a.jobNumber ?? 0) - (b.jobNumber ?? 0),
    )
    for (let i = 1; i < booked.length; i++) {
      expect(booked[i].createdAt).toBeGreaterThanOrEqual(
        booked[i - 1].createdAt,
      )
    }
  })

  test('only states the app can reach', () => {
    const memberIds = new Set(rows.members.map((m) => m._id))
    const propertyIds = new Set(rows.properties.map((p) => p._id))
    for (const row of rows.jobs) {
      expect([
        'recurring',
        'pending',
        'booked',
        'completed',
        'invoiced',
        'cancelled',
      ]).toContain(row.status)
      expect(memberIds.has(row.assignedMembershipId)).toBe(true)
      expect(propertyIds.has(row.propertyId)).toBe(true)
      expect(Number.isInteger(row.price) && row.price >= 0).toBe(true)
      expect(row.createdAt).toBeLessThanOrEqual(seededBy)
      // Only the engine makes `recurring`, and every visit it makes says
      // which occurrence it is.
      if (row.status === 'recurring') {
        expect(row.recurrenceId).toBeDefined()
      }
      if (row.recurrenceId) expect(row.occurrenceAt).toBeDefined()
      // Only jobs.complete stamps it, and nothing can complete in future.
      if (row.completedAt !== undefined) {
        expect(['completed', 'invoiced']).toContain(row.status)
        expect(row.completedAt).toBeLessThanOrEqual(seededBy)
      }
      if (row.status === 'completed') expect(row.completedAt).toBeDefined()
    }
    for (const row of oneOffs()) {
      expect(row.createdAt).toBeLessThan(row.scheduledAt)
    }
    for (const series of rows.series) {
      expect(series).not.toHaveProperty('frequency')
      expect(Number.isInteger(series.intervalCount)).toBe(true)
      expect(series.intervalUnit).toBeDefined()
      expect(propertyIds.has(series.propertyId)).toBe(true)
    }
  })

  test('nobody has work from before they joined, or after they left', () => {
    const formerRow = rows.members.find((m) => m._id === member('former'))
    const removedAt = formerRow?.removedAt
    if (removedAt === undefined) throw new Error('former was never removed')

    const theirs = rows.jobs.filter(
      (j) => j.assignedMembershipId === member('former'),
    )
    expect(theirs.length).toBeGreaterThan(10)
    // team.ts recorded a removal that reassigned nothing: so nothing of
    // theirs was still ahead of them then.
    for (const row of theirs) {
      expect(
        row.scheduledAt + row.durationMinutes * MINUTE,
      ).toBeLessThanOrEqual(removedAt)
      expect(row.recurrenceId).toBeUndefined()
    }
    expect(
      rows.series.filter((s) => s.assignedMembershipId === member('former')),
    ).toEqual([])

    for (const row of oneOffs()) {
      const joined = rows.members.find(
        (m) => m._id === row.assignedMembershipId,
      )?.createdAt
      expect(row.createdAt).toBeGreaterThan(joined ?? Infinity)
    }
  })

  // ─────────────────────────────────────────────────────────── history

  test('six months of history: one light month, billed once it is old', () => {
    expect(run.oneOff.length).toBeGreaterThanOrEqual(180)
    expect(run.oneOff.length).toBeLessThanOrEqual(240)

    const history = oneOffs().filter((j) => j.scheduledAt < when(0, 0))
    const revenue = new Map<string, number>()
    for (const row of history) {
      if (row.status !== 'completed' && row.status !== 'invoiced') continue
      const month = dayOf(row.scheduledAt).slice(0, 7)
      revenue.set(month, (revenue.get(month) ?? 0) + row.price)
    }
    const months = [5, 4, 3, 2, 1].map((back) => {
      const [y, m] = run.base.todayKey.split('-').map(Number)
      const total = y * 12 + (m - 1) - back
      return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
    })
    const totals = months.map((m) => revenue.get(m) ?? 0)
    const light = totals[2]
    for (const [i, total] of totals.entries()) {
      if (i !== 2) expect(light * 2).toBeLessThan(total)
    }

    const old = history.filter((j) => j.scheduledAt < when(-21, 0))
    const recent = history.filter((j) => j.scheduledAt >= when(-21, 0))
    const share = (list: Array<Doc<'jobs'>>, status: string) =>
      list.filter((j) => j.status === status).length / list.length
    expect(share(old, 'invoiced')).toBeGreaterThan(0.7)
    // Done and waiting on an invoice is what the last three weeks mostly are.
    expect(share(recent, 'completed')).toBeGreaterThan(0.4)
    expect(share(recent, 'completed')).toBeGreaterThan(
      share(recent, 'invoiced'),
    )
    expect(history.some((j) => j.status === 'cancelled')).toBe(true)

    // Last week's loose ends, beyond the named ones.
    const stale = run.oneOff.filter(
      (m) =>
        m.key === undefined &&
        (m.status === 'pending' || m.status === 'booked') &&
        m.scheduledAt >= when(-10, 0) &&
        m.scheduledAt < when(0, 0),
    )
    expect(stale.length).toBeGreaterThanOrEqual(2)

    const commercial = run.oneOff.find((m) => job(m.id).price === 1250000)
    expect(commercial?.propertyKey).toMatch(/^ridge/)
    expect(history.some((j) => j.price === 0 && j.status === 'completed')).toBe(
      true,
    )
    expect(history.some((j) => j.price === 9)).toBe(true)
    expect(new Set(history.map((j) => j.propertyId)).size).toBeGreaterThan(25)
  })

  // ───────────────────────────────────────────────────────────── today

  test('today: every status for everyone, and the awkward hours', () => {
    const today = oneOffs().filter(
      (j) => j.scheduledAt >= when(0, 0) && j.scheduledAt < when(1, 0),
    )
    // Nothing today is done before it ends, whatever hour it was seeded.
    for (const j of today) {
      if (j.status === 'completed' || j.status === 'invoiced') {
        expect(j.scheduledAt + j.durationMinutes * MINUTE).toBeLessThanOrEqual(
          seededBy,
        )
      }
    }
    // Once the morning's finished work is over (it all ends by 9:30), every
    // person has every status.
    const morningOver = seededBy >= when(0, 9, 30)
    for (const who of PEOPLE) {
      const statuses = new Set(
        today
          .filter((j) => j.assignedMembershipId === member(who))
          .map((j) => j.status),
      )
      for (const status of [
        'pending',
        'booked',
        'completed',
        'invoiced',
        'cancelled',
      ] as const) {
        if (!morningOver && (status === 'completed' || status === 'invoiced')) {
          continue
        }
        expect(statuses.has(status), `${who} ${status}`).toBe(true)
      }
    }
    const at7 = today.filter((j) => j.scheduledAt === when(0, 7))
    expect(at7.length).toBeGreaterThan(0)
    if (seededBy >= when(0, 7, 45)) {
      expect(at7.some((j) => j.status === 'completed')).toBe(true)
    }

    const at10 = today.filter((j) => j.scheduledAt === when(0, 10))
    const doubled = PEOPLE.filter(
      (who) =>
        at10.filter((j) => j.assignedMembershipId === member(who)).length >= 2,
    )
    expect(doubled.length).toBeGreaterThanOrEqual(1)

    expect(
      today.some(
        (j) => j.scheduledAt === when(0, 22, 30) && j.durationMinutes === 120,
      ),
    ).toBe(true)
    const endsAtMidnight = today.find((j) => j.scheduledAt === when(0, 23))
    expect(
      (endsAtMidnight?.scheduledAt ?? 0) +
        (endsAtMidnight?.durationMinutes ?? 0) * MINUTE,
    ).toBe(when(1, 0))
  })

  // ───────────────────────────────────────────────────────────── ahead

  test('ahead: a busy day, quiet days, the month boundary, next year', () => {
    const counted = rows.jobs.filter(isCountedJob)
    const onDay = (d: number) =>
      counted.filter(
        (j) => j.scheduledAt >= when(d, 0) && j.scheduledAt < when(d + 1, 0),
      )

    const busiest = Math.max(
      ...[...Array(13).keys()].map((i) => onDay(i + 1).length),
    )
    expect(busiest).toBeGreaterThanOrEqual(12)
    const busyDay = [...Array(13).keys()]
      .map((i) => i + 1)
      .find((d) => onDay(d).length === busiest)
    expect(
      new Set(onDay(busyDay ?? 0).map((j) => j.assignedMembershipId)).size,
    ).toBe(4)

    const weekdays = [...Array(20).keys()]
      .map((i) => i + 1)
      .filter((d) => {
        const key = addDaysToKey(run.base.todayKey, d)
        const weekday = new Date(`${key}T00:00:00Z`).getUTCDay()
        return weekday >= 1 && weekday <= 5
      })
    expect(
      weekdays.filter((d) => onDay(d).length === 0).length,
    ).toBeGreaterThanOrEqual(2)

    // Either side of the month boundary.
    const thisMonth = run.base.todayKey.slice(0, 7)
    let lastOffset = 0
    while (dayOf(when(lastOffset + 1, 12)).startsWith(thisMonth)) lastOffset++
    expect(
      counted.some((j) => j.scheduledAt === when(lastOffset, 23, 30)),
    ).toBe(true)
    expect(
      counted.some((j) => j.scheduledAt === when(lastOffset + 1, 0, 15)),
    ).toBe(true)

    // Billed ahead, never completed.
    const ahead = oneOffs().filter((j) => j.scheduledAt >= when(1, 0))
    expect(
      ahead.some((j) => j.status === 'invoiced' && j.completedAt === undefined),
    ).toBe(true)

    const months = new Set(ahead.map((j) => dayOf(j.scheduledAt).slice(5, 7)))
    expect(months.has('12')).toBe(true)
    expect(months.has('01')).toBe(true)

    const all = oneOffs()
    for (const minutes of [15, 30, 45, 75, 90, 120, 240, 480]) {
      expect(
        all.some((j) => j.durationMinutes === minutes),
        `${minutes}`,
      ).toBe(true)
    }
    for (const price of [19995, 485000]) {
      expect(
        ahead.some((j) => j.price === price),
        `${price}`,
      ).toBe(true)
    }
    const types = new Set(all.map((j) => j.jobType))
    expect(types.size).toBeGreaterThan(5)
    for (const type of [
      'Bed Bugs',
      'Possum Removal',
      'Bird Proofing',
      'Pre-Purchase Inspection',
    ]) {
      expect(types.has(type), type).toBe(true)
    }
    expect([...types].some((t) => t.length >= 60)).toBe(true)

    const aheadKeys = new Set(
      run.oneOff
        .filter((m) => m.scheduledAt >= when(1, 0))
        .map((m) => m.propertyKey),
    )
    for (const key of [
      'fannieBay',
      'nightcliff',
      'barooga',
      'braddon',
      'bayswaterVic',
      'joondalopTypo',
      'oddPostcode',
    ]) {
      expect(aheadKeys.has(key), key).toBe(true)
    }
  })

  test('photos: three on the bird-proofing job, as addPhoto adds them', async () => {
    const photoJob = named('photoJob')
    const photos = rows.photos
      .filter((p) => p.jobId === photoJob.id)
      .sort((a, b) => a.order - b.order)
    expect(photos.map((p) => p.order)).toEqual([0, 1, 2])
    expect(photos.filter((p) => p.caption !== undefined)).toHaveLength(2)
    expect(photos.filter((p) => !('caption' in p))).toHaveLength(1)
    const stored = new Set(run.base.images.photos.map((p) => p.storageId))
    for (const photo of photos) expect(stored.has(photo.storageId)).toBe(true)
    expect(rows.photos).toHaveLength(3)

    const shown = await run.contractor.as.query(api.jobs.photos, {
      businessId: run.base.businessId,
      jobId: photoJob.id,
    })
    expect(shown).toHaveLength(3)
    for (const photo of shown) expect(photo.url).toBeTruthy()
  })

  // ──────────────────────────────────────────────────────────── series

  test("every visit sits on one of its series' occurrences, once", () => {
    for (const series of rows.series) {
      const occurrences = new Set(
        occurrencesFrom(series.anchorDate, intervalOf(series), {
          timezone: tz(),
          from: series.anchorDate,
          until: seededBy + (HORIZON_DAYS + 1) * DAY,
        }),
      )
      const visits = visitsOf(series._id)
      const taken = visits.map((j) => j.occurrenceAt)
      expect(new Set(taken).size).toBe(taken.length)
      for (const visit of visits) {
        expect(occurrences.has(visit.occurrenceAt ?? -1)).toBe(true)
      }
    }
    // Moved: one in the past (done two hours late), one ahead (still a
    // projection, which is the one the cron could have double-booked).
    const moved = rows.jobs.filter(
      (j) => j.occurrenceAt !== undefined && j.scheduledAt !== j.occurrenceAt,
    )
    expect(moved.map((j) => j.scheduledAt - (j.occurrenceAt ?? 0))).toEqual([
      2 * 60 * MINUTE,
      2 * 60 * MINUTE,
    ])
    expect(moved.map((j) => j.status).sort()).toEqual(['invoiced', 'recurring'])
  })

  test('the long weekly series: history, a cancellation, two visits missed', () => {
    const series = seriesByKey('weeklySub')
    expect(series).toMatchObject({
      assignedMembershipId: member('sub'),
      propertyId: run.properties.ppm2,
      intervalCount: 1,
      intervalUnit: 'week',
      jobType: 'General Pest Control',
      active: true,
    })
    const anchorDay = offsetOf(series.anchorDate)
    expect(anchorDay).toBeLessThanOrEqual(-80)
    expect(anchorDay).toBeGreaterThanOrEqual(-90)
    expect(timeKeyOf(series.anchorDate, tz())).toBe('09:00')
    const weekday = new Date(
      `${dayOf(series.anchorDate)}T00:00:00Z`,
    ).getUTCDay()
    expect(weekday >= 1 && weekday <= 5).toBe(true)

    const past = visitsOf(series._id).filter(
      (j) => (j.occurrenceAt ?? 0) < when(0, 0),
    )
    expect(past[0].occurrenceAt).toBe(series.anchorDate)
    expect(past.filter((j) => j.status === 'cancelled')).toHaveLength(1)
    const missed = past.filter((j) => j.status === 'recurring')
    expect(missed).toHaveLength(2)
    const overdue = job(named(NAMED_VISITS.overdueWeek).id)
    expect(missed.map((j) => j._id)).toContain(overdue._id)
    expect(offsetOf(overdue.scheduledAt)).toBeLessThanOrEqual(-7)
    expect(offsetOf(overdue.scheduledAt)).toBeGreaterThanOrEqual(-13)
  })

  test('the fortnightly series is what recurrences.create leaves', () => {
    const series = seriesByKey('fortnightlyContractor')
    expect(series).toMatchObject({
      assignedMembershipId: member('contractor'),
      intervalCount: 2,
      intervalUnit: 'week',
      anchorDate: when(1, 9),
      active: true,
    })
    const visits = visitsOf(series._id)
    expect(visits[0]).toMatchObject({
      status: 'pending',
      scheduledAt: when(1, 9),
      occurrenceAt: when(1, 9),
      durationMinutes: 30,
    })
    expect(visits.slice(1).every((j) => j.status === 'recurring')).toBe(true)
    expect(visits.every((j) => j.durationMinutes === 30)).toBe(true)
    expect(visits.length).toBeGreaterThanOrEqual(12)
  })

  test('month ends clamp, a leap day becomes 28 February, and one visit was handed on', () => {
    const monthly = seriesByKey('monthlyClamp')
    expect(dayOf(monthly.anchorDate).slice(8)).toBe('31')
    expect(timeKeyOf(monthly.anchorDate, tz())).toBe('10:00')
    const visits = visitsOf(monthly._id)
    expect(visits[0].status).toBe('completed')
    for (const visit of visits) {
      const [y, m, d] = dayOf(visit.scheduledAt).split('-').map(Number)
      expect(d).toBe(Math.min(31, new Date(Date.UTC(y, m, 0)).getUTCDate()))
    }
    const handedOn = visits.filter(
      (j) => j.assignedMembershipId === member('sub'),
    )
    expect(handedOn).toHaveLength(1)
    expect(handedOn[0].scheduledAt).toBeGreaterThan(seededBy)
    expect(handedOn[0].status).toBe('recurring')

    const yearly = seriesByKey('yearlyLeap')
    expect(dayOf(yearly.anchorDate)).toBe('2024-02-29')
    const leapVisits = visitsOf(yearly._id)
    expect(leapVisits.length).toBeGreaterThanOrEqual(1)
    // 28 February, and the 29th in a leap year.
    for (const visit of leapVisits) {
      const [y, m, d] = dayOf(visit.scheduledAt).split('-').map(Number)
      expect([m, d]).toEqual([2, new Date(Date.UTC(y, 2, 0)).getUTCDate()])
    }
  })

  test('fifteen years, every two days, quarterly, and one due today', () => {
    const warranty = visitsOf(seriesByKey('fifteenYears')._id)
    expect(warranty).toHaveLength(1)
    expect(warranty[0]).toMatchObject({
      status: 'pending',
      scheduledAt: when(0, 15),
    })

    const everyTwo = visitsOf(seriesByKey('everyTwoDays')._id)
    expect(everyTwo).toHaveLength(61)
    expect(everyTwo[0]).toMatchObject({
      status: 'pending',
      scheduledAt: when(0, 8),
    })
    expect(everyTwo.slice(1).every((j) => j.status === 'recurring')).toBe(true)

    const quarterly = seriesByKey('quarterlyCommercial')
    expect(quarterly).toMatchObject({
      assignedMembershipId: member('contractor'),
      propertyId: run.properties.ridgeMalaga,
      price: 89000,
      intervalCount: 3,
      intervalUnit: 'month',
    })
    const quarterlyPast = visitsOf(quarterly._id).filter(
      (j) => j.scheduledAt < when(0, 0),
    )
    expect(quarterlyPast.map((j) => j.status).sort()).toEqual([
      'completed',
      'invoiced',
    ])

    const due = job(named(NAMED_VISITS.dueToday).id)
    expect(due).toMatchObject({
      status: 'recurring',
      scheduledAt: when(0, 14),
      occurrenceAt: when(0, 14),
      assignedMembershipId: member('owner'),
    })
  })

  test('the stopped series leaves what stopFromJob leaves', () => {
    const series = seriesByKey('stopped')
    expect(series.active).toBe(false)
    const visits = visitsOf(series._id)
    expect(
      visits.filter(
        (j) => NOT_STARTED_STATUSES.has(j.status) && j.scheduledAt > seededBy,
      ),
    ).toEqual([])
    expect(visits.some((j) => j.status === 'cancelled')).toBe(true)
    const missed = visits.filter((j) => j.status === 'recurring')
    expect(missed).toHaveLength(1)
    expect(missed[0].scheduledAt).toBeLessThan(when(0, 0))

    // The visit it was stopped from: a one-off now, still marking its
    // occurrence.
    const kept = run.series.filter(
      (m) =>
        m.recurrenceKey === 'stopped' && job(m.id).recurrenceId === undefined,
    )
    expect(kept).toHaveLength(1)
    const keptRow = job(kept[0].id)
    expect(keptRow.status).toBe('pending')
    expect(keptRow.occurrenceAt).toBe(keptRow.scheduledAt)
    expect(keptRow.scheduledAt).toBeGreaterThan(seededBy)
  })

  test('commercial work carries the client’s work order; a standing one reaches every visit', () => {
    const keyOfProperty = new Map(
      Object.entries(run.properties).map(([key, id]) => [id, key]),
    )
    const commercial = (j: Doc<'jobs'>) =>
      /^(ridge|ppm|coast|kewdale)/.test(keyOfProperty.get(j.propertyId) ?? '')
    const oneOffIds = new Set(run.oneOff.map((m) => m.id))
    const oneOffRows = rows.jobs.filter((j) => oneOffIds.has(j._id))
    const withOrder = oneOffRows.filter((j) => j.workOrder !== undefined)
    // Only commercial sites, and not all of them: some are still being chased.
    expect(withOrder.length).toBeGreaterThan(10)
    expect(withOrder.every(commercial)).toBe(true)
    expect(
      oneOffRows.some((j) => commercial(j) && j.workOrder === undefined),
    ).toBe(true)
    for (const j of withOrder) {
      // lib/workOrder.ts: trimmed, at most 64 characters.
      expect(j.workOrder).toBe(j.workOrder?.trim())
      expect(j.workOrder?.length).toBeLessThanOrEqual(64)
    }
    // A standing order on the series, copied onto each visit as projected.
    for (const [key, order] of [
      ['quarterlyCommercial', 'WO-448000 (standing)'],
      ['fortnightlyContractor', 'SC#20931-01'],
    ] as const) {
      const series = seriesByKey(key)
      expect(series.workOrder).toBe(order)
      const visits = visitsOf(series._id)
      expect(visits.length).toBeGreaterThan(0)
      for (const visit of visits) expect(visit.workOrder).toBe(order)
    }
  })

  test('the converted job became the first visit of a quarterly series', () => {
    const series = seriesByKey('converted')
    const original = oneOffs().find((j) => j.recurrenceId === series._id)
    if (!original) throw new Error('no converted job')
    expect(original.status).toBe('completed')
    expect(original.occurrenceAt).toBe(original.scheduledAt)
    expect(original.jobType).toBe('General Pest Control')
    expect(offsetOf(original.scheduledAt)).toBeGreaterThanOrEqual(-10)
    expect(offsetOf(original.scheduledAt)).toBeLessThanOrEqual(-5)
    expect(series).toMatchObject({
      anchorDate: original.scheduledAt,
      propertyId: original.propertyId,
      assignedMembershipId: original.assignedMembershipId,
      price: original.price,
      intervalCount: 3,
      intervalUnit: 'month',
      active: true,
    })
    const projected = visitsOf(series._id).filter((j) => j._id !== original._id)
    expect(projected.length).toBeGreaterThanOrEqual(1)
    for (const visit of projected) {
      expect(visit.status).toBe('recurring')
      expect(visit.durationMinutes).toBe(original.durationMinutes)
    }
  })

  test('the manifest has every visit the step made, as it ended up', () => {
    const made = rows.jobs.filter(
      (j) =>
        j.recurrenceId !== undefined && !run.oneOff.some((m) => m.id === j._id),
    )
    const listed = new Set(run.series.map((m) => m.id))
    for (const visit of made) expect(listed.has(visit._id)).toBe(true)
    for (const entry of run.series) {
      const row = job(entry.id)
      expect(entry).toMatchObject({
        status: row.status,
        scheduledAt: row.scheduledAt,
        durationMinutes: row.durationMinutes,
        jobType: row.jobType,
        assignee: keyOfMember(row.assignedMembershipId),
      })
      expect(run.properties[entry.propertyKey]).toBe(row.propertyId)
      expect(entry.recurrenceKey).toBeDefined()
    }
  })

  // ─────────────────────────────────────────────── as the app reads them

  test("today on the owner's schedule carries the overdue visits", async () => {
    const { businessId, todayKey } = run.base
    const day = await run.owner.as.query(api.jobs.listDay, {
      businessId,
      dayKey: todayKey,
    })
    const ids = new Set(day.map((j) => j._id))
    const overdue = rows.jobs.filter(
      (j) => j.status === 'recurring' && j.scheduledAt < when(0, 0),
    )
    expect(overdue).toHaveLength(3)
    for (const visit of overdue) expect(ids.has(visit._id)).toBe(true)
    expect(ids.has(named(NAMED_VISITS.dueToday).id)).toBe(true)
    expect(ids.has(named('todayUnstarted1730').id)).toBe(true)
    expect(ids.has(named('cancelledToday').id)).toBe(false)

    expect(
      await run.owner.as.query(api.jobs.overdueRecurringCount, { businessId }),
    ).toBe(3)
    // The sub sees only their own two.
    expect(
      await run.sub.as.query(api.jobs.overdueRecurringCount, { businessId }),
    ).toBe(2)

    const list = await run.owner.as.query(api.jobs.list, { businessId })
    expect(list.capped).toBe(true)
    expect(list.jobs).toHaveLength(list.limit)
  })

  // Last: it adds the rest of the every-two-days series.
  test('the nightly cron finds nothing to add inside the horizon', async () => {
    const before = new Map(
      rows.series.map((s) => [s._id, visitsOf(s._id)] as const),
    )
    await run.t.mutation(internal.recurrences.materialiseAll, {})
    const after = await rowsOf(run.t, run.base.businessId)
    const everyTwoDays = seriesByKey('everyTwoDays')._id

    for (const series of after.series) {
      const had = before.get(series._id) ?? []
      const now = after.jobs.filter((j) => j.recurrenceId === series._id)
      const taken = now.map((j) => j.occurrenceAt)
      expect(new Set(taken).size).toBe(taken.length)

      const lastBefore = Math.max(...had.map((j) => j.occurrenceAt ?? 0))
      const added = now.filter((j) => !had.some((h) => h._id === j._id))
      // Anything new is past the end of what was there: the cron fills the
      // far end of the horizon, never a gap inside it.
      for (const visit of added) {
        expect(visit.occurrenceAt ?? 0).toBeGreaterThan(lastBefore)
      }
      if (series._id === everyTwoDays) {
        expect(added.length).toBeGreaterThan(0)
        expect(added.every((j) => j.durationMinutes === 60)).toBe(true)
        expect(Math.min(...added.map((j) => j.occurrenceAt ?? 0))).toBe(
          lastBefore + 2 * DAY,
        )
      } else {
        expect(added.length, keyOfSeries(series._id)).toBe(0)
      }
    }

    function keyOfSeries(id: Id<'recurrences'>) {
      return run.series.find((m) => job(m.id).recurrenceId === id)
        ?.recurrenceKey
    }
  })
})
