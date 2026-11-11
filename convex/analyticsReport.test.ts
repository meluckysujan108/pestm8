/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import { startOfDayInZone } from './lib/dates'
import type { Doc, Id } from './_generated/dataModel'

/**
 * `analytics.report` and `analytics.uninvoiced` — what the Analytics page
 * reads. Every date is given, never today's, so these answer the same at any
 * hour (CI runs at all of them).
 */

const PERTH = 'Australia/Perth'
const TODAY = '2026-11-11'
/** Thirty days ending today, and the thirty before them. */
const RANGE = { from: '2026-10-13', to: TODAY }

/** Noon on a day in Perth: clear of both ends of the day. */
function noon(dayKey: string): number {
  return startOfDayInZone(dayKey, PERTH) + 12 * 60 * 60 * 1000
}

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const propertyId = await t.run(async (ctx) => {
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: 0,
      updatedAt: 0,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: 0,
    })
  })
  return { t, owner, businessId, ownerMembershipId, propertyId }
}

type Setup = Awaited<ReturnType<typeof setup>>

function job(
  s: Setup,
  dayKey: string,
  status: Doc<'jobs'>['status'],
  price: number,
  more: Partial<Doc<'jobs'>> = {},
): Promise<Id<'jobs'>> {
  return s.t.run((ctx) =>
    ctx.db.insert('jobs', {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest Control',
      price,
      scheduledAt: noon(dayKey),
      durationMinutes: 60,
      status,
      createdAt: 0,
      ...more,
    }),
  )
}

function report(s: Setup, more: Record<string, unknown> = {}) {
  return s.owner.as.query(api.analytics.report, {
    businessId: s.businessId,
    ...RANGE,
    today: TODAY,
    ...more,
  })
}

describe('the overview’s figures', () => {
  test('count earned money only, cancelled jobs apart, and nothing outside the range', async () => {
    const s = await setup()
    await job(s, '2026-10-13', 'completed', 20000)
    await job(s, '2026-11-11', 'invoiced', 30000)
    await job(s, '2026-11-02', 'booked', 99000)
    await job(s, '2026-11-03', 'cancelled', 50000)
    await job(s, '2026-11-04', 'recurring', 70000)
    // The day before the range, and the day after it.
    await job(s, '2026-10-12', 'completed', 11000)
    await job(s, '2026-11-12', 'completed', 12000)

    const r = await report(s)
    expect(r?.totals).toEqual({
      revenue: 50000,
      completed: 2,
      booked: 3,
      cancelled: 1,
      averageJob: 25000,
    })
    expect(r?.comparison).toEqual({ from: '2026-09-13', to: '2026-10-12' })
    expect(r?.before?.revenue).toBe(11000)
    expect(r?.grain).toBe('day')
    expect(r?.series).toHaveLength(30)
    expect(r?.series[0]).toMatchObject({ start: '2026-10-13', revenue: 20000 })
    expect(r?.series[29]).toMatchObject({
      start: '2026-11-11',
      revenue: 30000,
      // The last day of the range before: 12 October.
      beforeRevenue: 11000,
    })
  })

  test('compare with a year earlier, or with nothing', async () => {
    const s = await setup()
    await job(s, '2026-11-01', 'completed', 20000)
    await job(s, '2025-11-01', 'completed', 8000)

    const year = await report(s, { compare: 'year' })
    expect(year?.comparison).toEqual({ from: '2025-10-13', to: '2025-11-11' })
    expect(year?.before?.revenue).toBe(8000)

    const none = await report(s, { compare: 'none' })
    expect(none?.comparison).toBeNull()
    expect(none?.before).toBeNull()
    expect(none?.series[0].beforeRevenue).toBeNull()
  })

  test('a range that is no range is refused', async () => {
    const s = await setup()
    await expect(
      report(s, { from: '2026-11-11', to: '2026-10-13' }),
    ).rejects.toThrow('INVALID_RANGE')
    await expect(
      report(s, { from: '2025-01-01', to: '2026-11-11' }),
    ).rejects.toThrow('INVALID_RANGE')
    await expect(report(s, { today: 'tomorrow' })).rejects.toThrow(
      'INVALID_RANGE',
    )
  })

  test('booked ahead is the next four weeks’ work not yet started', async () => {
    const s = await setup()
    await job(s, TODAY, 'booked', 10000)
    await job(s, '2026-12-08', 'pending', 15000)
    // Day 29, a finished job and a cancelled one are not work ahead.
    await job(s, '2026-12-09', 'booked', 40000)
    await job(s, '2026-11-20', 'completed', 40000)
    await job(s, '2026-11-21', 'cancelled', 40000)

    const r = await report(s)
    expect(r?.bookedAhead).toEqual({ days: 28, count: 2, value: 25000 })
  })

  test('finished work waits until it is invoiced, whatever the range', async () => {
    const s = await setup()
    // Long before the range, and never invoiced.
    await job(s, '2026-03-01', 'completed', 30000)
    await job(s, '2026-11-05', 'completed', 12000)
    await job(s, '2026-11-06', 'invoiced', 90000)

    const r = await report(s)
    expect(r?.uninvoiced).toMatchObject({
      count: 2,
      value: 42000,
      oldCount: 1,
      oldValue: 30000,
      more: false,
    })
  })
})

describe('the filters', () => {
  test('a service narrows every figure, and each choice counts what it would show', async () => {
    const s = await setup()
    await job(s, '2026-11-01', 'completed', 20000)
    await job(s, '2026-11-02', 'completed', 45000, {
      jobType: 'Termite Inspection, General Pest Control',
    })
    await job(s, '2026-11-03', 'completed', 30000, { jobType: 'Rodents' })

    const all = await report(s)
    expect(all?.services).toEqual([
      { name: 'General Pest Control', count: 2 },
      { name: 'Rodents', count: 1 },
      { name: 'Termite Inspection', count: 1 },
    ])

    const termite = await report(s, { service: 'termite inspection' })
    expect(termite?.totals.revenue).toBe(45000)
    // The choices stay: picking one must not take the others away.
    expect(termite?.services).toHaveLength(3)
  })

  test('a person narrows to the jobs they lead and the ones they are also going on', async () => {
    const s = await setup()
    const sam = await createActor(s.t, { email: 'sam@coastal.test' })
    const samId = await joinBusiness(
      s.t,
      s.owner,
      sam,
      s.businessId,
      'subcontractor',
    )
    await job(s, '2026-11-01', 'completed', 20000)
    await job(s, '2026-11-02', 'completed', 30000, {
      assignedMembershipId: samId,
    })
    const shared = await job(s, '2026-11-03', 'completed', 40000)
    await s.t.run((ctx) =>
      ctx.db.insert('jobPeople', {
        businessId: s.businessId,
        jobId: shared,
        membershipId: samId,
        scheduledAt: noon('2026-11-03'),
        addedBy: s.ownerMembershipId,
        addedAt: 0,
      }),
    )

    const r = await report(s, { staff: samId })
    expect(r?.totals).toMatchObject({ revenue: 70000, completed: 2 })
    expect(r?.people.map((p) => [p.membershipId, p.count])).toEqual(
      expect.arrayContaining([
        [s.ownerMembershipId, 2],
        [samId, 2],
      ]),
    )
  })
})

describe('who sees what', () => {
  test('a subcontractor gets their own jobs, and no money without the grant', async () => {
    const s = await setup()
    const sam = await createActor(s.t, { email: 'sam@coastal.test' })
    const samId = await joinBusiness(
      s.t,
      s.owner,
      sam,
      s.businessId,
      'subcontractor',
    )
    await job(s, '2026-11-01', 'completed', 20000)
    await job(s, '2026-11-02', 'completed', 30000, {
      assignedMembershipId: samId,
    })

    const r = await sam.as.query(api.analytics.report, {
      businessId: s.businessId,
      ...RANGE,
      today: TODAY,
      // Asking for the owner's jobs changes nothing: it is not theirs to ask.
      staff: s.ownerMembershipId,
    })
    expect(r?.scope).toBe('assignee')
    expect(r?.totals.completed).toBe(1)
    expect(r?.people).toEqual([])
    if (r?.pricesHidden) {
      expect(r.totals.revenue).toBeNull()
      expect(r.totals.averageJob).toBeNull()
      expect(r.series.every((point) => point.revenue === null)).toBe(true)
      expect(r.uninvoiced.value).toBeNull()
      expect(r.uninvoiced.count).toBeNull()
    } else {
      expect(r?.totals.revenue).toBe(30000)
    }
  })

  test('someone outside the business is refused', async () => {
    const s = await setup()
    const stranger = await createActor(s.t, { email: 'who@elsewhere.test' })
    await expect(
      stranger.as.query(api.analytics.report, {
        businessId: s.businessId,
        ...RANGE,
        today: TODAY,
      }),
    ).rejects.toThrow('NO_ACCESS')
  })
})

describe('awaiting invoice, by age', () => {
  test('bands finished work by how long it has waited, oldest listed first', async () => {
    const s = await setup()
    await job(s, '2026-11-10', 'completed', 10000)
    await job(s, '2026-11-01', 'completed', 20000)
    await job(s, '2026-10-20', 'completed', 30000)
    const oldest = await job(s, '2026-08-01', 'completed', 40000, {
      jobNumber: 7,
    })
    await job(s, '2026-11-09', 'invoiced', 99000)

    const r = await s.owner.as.query(api.analytics.uninvoiced, {
      businessId: s.businessId,
      today: TODAY,
    })
    expect(r?.count).toBe(4)
    expect(r?.value).toBe(100000)
    expect(r?.bands).toEqual([
      { key: 'week', count: 1, value: 10000 },
      { key: 'fortnight', count: 1, value: 20000 },
      { key: 'month', count: 1, value: 30000 },
      { key: 'older', count: 1, value: 40000 },
    ])
    expect(r?.jobs[0]).toMatchObject({
      jobId: oldest,
      jobNumber: 7,
      client: 'J. Nguyen',
      suburb: 'Bayswater',
      price: 40000,
      dayKey: '2026-08-01',
      days: 102,
    })
    expect(r?.more).toBe(false)
  })
})

describe('where the work came from', () => {
  async function secondSite(s: Setup) {
    return s.t.run(async (ctx) => {
      const clientId = await ctx.db.insert('clients', {
        businessId: s.businessId,
        kind: 'business',
        name: 'Harbour Café',
        // First put on the books inside the range: a new client.
        createdAt: noon('2026-10-20'),
        updatedAt: noon('2026-10-20'),
      })
      return ctx.db.insert('properties', {
        businessId: s.businessId,
        clientId,
        addressLine: '3 Quay Street',
        suburb: 'Fremantle',
        state: 'WA',
        postcode: '6160',
        createdAt: noon('2026-10-20'),
      })
    })
  }

  function breakdowns(s: Setup, more: Record<string, unknown> = {}) {
    return s.owner.as.query(api.analytics.breakdowns, {
      businessId: s.businessId,
      ...RANGE,
      ...more,
    })
  }

  test('by service, client, suburb and lead, finished work only', async () => {
    const s = await setup()
    const cafe = await secondSite(s)
    await job(s, '2026-11-01', 'completed', 20000)
    await job(s, '2026-11-02', 'invoiced', 30000)
    await job(s, '2026-11-03', 'completed', 60000, {
      propertyId: cafe,
      jobType: 'Rodents, General Pest Control',
    })
    // Not finished, or not in the range: in none of it.
    await job(s, '2026-11-04', 'booked', 99000, { propertyId: cafe })
    await job(s, '2026-10-01', 'completed', 99000)

    const r = await breakdowns(s)
    expect(r?.completed).toBe(3)
    expect(r?.revenue).toBe(110000)
    // The two-service job is one job under each, its price shared.
    expect(r?.services).toEqual([
      { name: 'General Pest Control', completed: 3, revenue: 80000 },
      { name: 'Rodents', completed: 1, revenue: 30000 },
    ])
    expect(r?.areas).toEqual([
      { suburb: 'Fremantle', completed: 1, revenue: 60000 },
      { suburb: 'Bayswater', completed: 2, revenue: 50000 },
    ])
    expect(r?.clients).toMatchObject({
      served: 2,
      new: 1,
      newJobs: 1,
      person: { completed: 2, revenue: 50000 },
      business: { completed: 1, revenue: 60000 },
    })
    expect(r?.clients.top.map((c) => [c.name, c.revenue])).toEqual([
      ['Harbour Café', 60000],
      ['J. Nguyen', 50000],
    ])
    expect(r?.team).toMatchObject([
      { membershipId: s.ownerMembershipId, completed: 3, revenue: 110000 },
    ])
    expect(r?.partial).toBe(false)
    expect(r?.emails).toEqual({ sent: 0, failed: 0, bounced: 0 })
  })

  test('a service narrows it, as it narrows the overview', async () => {
    const s = await setup()
    const cafe = await secondSite(s)
    await job(s, '2026-11-01', 'completed', 20000)
    await job(s, '2026-11-03', 'completed', 60000, {
      propertyId: cafe,
      jobType: 'Rodents',
    })

    const r = await breakdowns(s, { service: 'rodents' })
    expect(r?.completed).toBe(1)
    expect(r?.areas.map((a) => a.suburb)).toEqual(['Fremantle'])
  })

  test('what repeats is valued by the year, and its finished visits counted', async () => {
    const s = await setup()
    const series = await s.t.run(async (ctx) => {
      const running = {
        businessId: s.businessId,
        propertyId: s.propertyId,
        assignedMembershipId: s.ownerMembershipId,
        jobType: 'General Pest Control',
        anchorDate: noon('2026-01-01'),
      }
      // Every three months at $200, and every two weeks at $50.
      const quarterly = await ctx.db.insert('recurrences', {
        ...running,
        price: 20000,
        intervalCount: 3,
        intervalUnit: 'month',
        active: true,
      })
      await ctx.db.insert('recurrences', {
        ...running,
        price: 5000,
        intervalCount: 2,
        intervalUnit: 'week',
        active: true,
      })
      // Stopped: worth nothing a year.
      await ctx.db.insert('recurrences', {
        ...running,
        price: 90000,
        frequency: 'monthly',
        active: false,
      })
      return quarterly
    })
    await job(s, '2026-11-01', 'completed', 20000, { recurrenceId: series })
    await job(s, '2026-11-02', 'completed', 30000)

    const r = await breakdowns(s)
    expect(r?.recurring).toEqual({
      services: 2,
      more: false,
      // 4 × $200 + 26 × $50.
      yearlyValue: 210000,
      completed: 1,
      revenue: 20000,
    })
  })

  test('a subcontractor gets their own work, no team, and no emails', async () => {
    const s = await setup()
    const sam = await createActor(s.t, { email: 'sam@coastal.test' })
    const samId = await joinBusiness(
      s.t,
      s.owner,
      sam,
      s.businessId,
      'subcontractor',
    )
    await job(s, '2026-11-01', 'completed', 20000)
    await job(s, '2026-11-02', 'completed', 30000, {
      assignedMembershipId: samId,
    })

    const r = await sam.as.query(api.analytics.breakdowns, {
      businessId: s.businessId,
      ...RANGE,
    })
    expect(r?.completed).toBe(1)
    expect(r?.team).toEqual([])
    expect(r?.emails).toBeNull()
    if (r?.pricesHidden) {
      expect(r.revenue).toBeNull()
      expect(r.services.every((row) => row.revenue === null)).toBe(true)
      expect(r.recurring.yearlyValue).toBeNull()
    }
  })
})
