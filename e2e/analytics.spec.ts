import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * `analytics.overview` — the historical-trend query behind the Analytics
 * page's charts. Money/status semantics deliberately mirror
 * `dashboard.summary`'s: a `booked` job hasn't happened yet and must not
 * inflate revenue; a job cannot reach `invoiced` at all today (no mutation
 * sets it — invoicing/Xero isn't built, per `access-control.spec.ts`'s own
 * `test.fixme` notes), so only `completed` is exercised here.
 *
 * Day 15 at noon, in every job below: comfortably clear of both ends of the
 * calendar month in any timezone the test runner and the business
 * (`Australia/Perth`) could disagree by, so which month a job lands in is
 * never ambiguous.
 */
function midMonth(monthsAgo: number): number {
  const d = new Date()
  d.setDate(15)
  d.setHours(12, 0, 0, 0)
  d.setMonth(d.getMonth() - monthsAgo)
  return d.getTime()
}

test('revenue counts only completed jobs, excludes booked, and buckets by month', async () => {
  const owner = await signUpActor(uniqueEmail('analytics-owner'), FIXTURE_PASSWORD, 'Terence')

  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `Analytics Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, { businessId })
  const ownerMembershipId = members.find((m) => m.role === 'owner')!._id

  async function bookJob(price: number, scheduledAt: number, complete: boolean) {
    const jobId = await owner.client.mutation(api.jobs.create, {
      businessId,
      propertyId,
      assignedMembershipId: ownerMembershipId,
      jobType: 'General Pest Control',
      price,
      scheduledAt,
      durationMinutes: 60,
    })
    if (complete) await owner.client.mutation(api.jobs.complete, { businessId, jobId })
    return jobId
  }

  // This month: one completed (counts), one still booked (must not count).
  await bookJob(20000, midMonth(0), true)
  await bookJob(50000, midMonth(0), false)
  // Last month: one completed, a different month bucket.
  await bookJob(15000, midMonth(1), true)

  const overview = await owner.client.query(api.analytics.overview, { businessId })
  expect(overview?.scope).toBe('business')

  const thisMonthKey = overview!.months.at(-1)
  const lastMonthKey = overview!.months.at(-2)

  const thisMonthRevenue = overview!.revenueByMonth.find((r) => r.month === thisMonthKey)
  const lastMonthRevenue = overview!.revenueByMonth.find((r) => r.month === lastMonthKey)
  expect(thisMonthRevenue?.value).toBe(20000) // not 70000 — the booked job is excluded
  expect(lastMonthRevenue?.value).toBe(15000)

  const thisMonthVolume = overview!.volumeByMonth.find((r) => r.month === thisMonthKey)
  expect(thisMonthVolume?.value).toBe(2) // volume counts both, unlike revenue

  const booked = overview!.statusBreakdown.find((s) => s.status === 'booked')
  const completed = overview!.statusBreakdown.find((s) => s.status === 'completed')
  expect(booked?.count).toBe(1)
  expect(completed?.count).toBe(2)
})

test('a subcontractor without canViewAllJobs sees only their own jobs reflected', async () => {
  const s = await setupBusinessWithSub('analytics-scope')

  // The fixture's own job is assigned to the owner; add one assigned to the
  // subcontractor so the two scopes would disagree if scoping were broken.
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'Ants',
    price: 16000,
    scheduledAt: midMonth(0),
    durationMinutes: 45,
  })

  const ownerView = await s.owner.client.query(api.analytics.overview, {
    businessId: s.businessId,
  })
  const subView = await s.sub.client.query(api.analytics.overview, {
    businessId: s.businessId,
  })

  expect(ownerView?.scope).toBe('business')
  expect(subView?.scope).toBe('assignee')

  // Totals across the whole window, not a single month bucket — the
  // fixture's own job (assigned to the owner) uses `Date.now()` while this
  // test's job uses a fixed mid-month timestamp, and comparing per-month
  // volumes risks the two landing in different month buckets right at a
  // month boundary (the same class of tenant-timezone-vs-runner-clock bug
  // already hit once in this codebase's calendar tests). The 6-month window
  // itself has no such edge.
  const totalVolume = (o: NonNullable<typeof ownerView>) =>
    o.volumeByMonth.reduce((sum, r) => sum + r.value, 0)

  // Owner sees both their own fixture job (Termite Inspection) and the
  // sub's (Ants); the sub sees only their own.
  expect(ownerView!.typeBreakdown.map((t) => t.jobType).sort()).toEqual(
    ['Ants', 'Termite Inspection'].sort(),
  )
  expect(subView!.typeBreakdown.map((t) => t.jobType)).toEqual(['Ants'])
  expect(totalVolume(subView!)).toBe(1)
  expect(totalVolume(ownerView!)).toBeGreaterThan(totalVolume(subView!))

  // A workload comparison of one person is meaningless — the UI hides the
  // chart entirely for an assignee-scoped caller (see AnalyticsCharts.tsx),
  // but the data itself still only ever contains the caller's own row.
  expect(subView!.technicianLoad.every((t) => t.membershipId === s.subMembershipId)).toBe(true)
})

test('a non-member is rejected', async () => {
  const owner = await signUpActor(uniqueEmail('analytics-private'), FIXTURE_PASSWORD, 'Terence')
  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `Private Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  const outsider = await signUpActor(uniqueEmail('analytics-outsider'), FIXTURE_PASSWORD, 'Outsider')
  await expectRejected(
    () => outsider.client.query(api.analytics.overview, { businessId }),
    'NO_ACCESS',
  )
})
