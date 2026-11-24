import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseOverview,
  expectRejected,
  setupBusinessWithSub,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { addDaysToKey, dayKeyOf } from '../convex/lib/dates'

/**
 * `analytics.report` — the query behind the Analytics page's figures, asked
 * directly. Money and status mean what they mean on the dashboard: a
 * `pending` job hasn't happened yet and must not inflate revenue. Only
 * `completed` is exercised here; `invoiced` and `paid` count the same way
 * (convex/analytics.ts). `analyticsPage.spec.ts` drives the page itself.
 *
 * Day 15 at noon, in every job below: comfortably clear of both ends of the
 * calendar month in any timezone the test runner and the business
 * (`Australia/Perth`) could disagree by.
 */
function midMonth(monthsAgo: number): number {
  const d = new Date()
  d.setDate(15)
  d.setHours(12, 0, 0, 0)
  d.setMonth(d.getMonth() - monthsAgo)
  return d.getTime()
}

/**
 * A range wide enough to hold last month's 15th and this month's, whichever
 * side of the 15th today is: ninety days back to forty ahead. The totals over
 * it don't depend on where a month or a day turns over.
 */
function wideRange() {
  const today = dayKeyOf(Date.now(), 'Australia/Perth')
  return {
    from: addDaysToKey(today, -90),
    to: addDaysToKey(today, 40),
    today,
  }
}

test('revenue counts only completed jobs and leaves out pending ones', async () => {
  const owner = await signUpActor(
    uniqueEmail('analytics-owner'),
    FIXTURE_PASSWORD,
    'Terence',
  )

  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `Analytics Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  // The owner opens in My jobs; the business's figures are Overview's.
  await chooseOverview(owner.client, businessId)
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const ownerMembershipId = members.find((m) => m.role === 'owner')!._id

  async function bookJob(
    price: number,
    scheduledAt: number,
    complete: boolean,
  ) {
    const jobId = await owner.client.mutation(api.jobs.create, {
      businessId,
      propertyId,
      assignedMembershipId: ownerMembershipId,
      jobType: 'General Pest Control',
      price,
      scheduledAt,
      durationMinutes: 60,
    })
    if (complete)
      await owner.client.mutation(api.jobs.complete, { businessId, jobId })
    return jobId
  }

  // This month: one completed (counts), one still pending (must not count).
  await bookJob(20000, midMonth(0), true)
  await bookJob(50000, midMonth(0), false)
  // Last month: one completed.
  await bookJob(15000, midMonth(1), true)

  const report = await owner.client.query(api.analytics.report, {
    businessId,
    ...wideRange(),
    compare: 'none',
  })
  expect(report?.scope).toBe('business')
  expect(report?.totals).toMatchObject({
    // Not 85000: the pending job is booked, and earns nothing yet.
    revenue: 35000,
    completed: 2,
    booked: 3,
    cancelled: 0,
  })
  // Every dollar is in the chart's points, and nowhere twice.
  expect(
    report!.series.reduce((sum, point) => sum + (point.revenue ?? 0), 0),
  ).toBe(35000)
  expect(report?.comparison).toBeNull()
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

  const args = { businessId: s.businessId, ...wideRange() }
  const ownerView = await s.owner.client.query(api.analytics.report, args)
  const subView = await s.sub.client.query(api.analytics.report, args)

  expect(ownerView?.scope).toBe('business')
  expect(subView?.scope).toBe('assignee')

  // The owner sees both their own fixture job (Termite Inspection) and the
  // sub's (Ants); the sub sees only their own.
  expect(ownerView!.services.map((service) => service.name).sort()).toEqual([
    'Ants',
    'Termite Inspection',
  ])
  expect(subView!.services.map((service) => service.name)).toEqual(['Ants'])
  expect(subView!.totals.booked).toBe(1)
  expect(ownerView!.totals.booked).toBeGreaterThan(subView!.totals.booked)

  // Nobody to choose between in a list that is one person's already: the
  // technician filter is the whole business's only.
  expect(subView!.people).toEqual([])
  expect(ownerView!.people.map((person) => person.membershipId)).toContain(
    s.subMembershipId,
  )
})

test('a non-member is rejected', async () => {
  const owner = await signUpActor(
    uniqueEmail('analytics-private'),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `Private Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  const outsider = await signUpActor(
    uniqueEmail('analytics-outsider'),
    FIXTURE_PASSWORD,
    'Outsider',
  )
  await expectRejected(
    () =>
      outsider.client.query(api.analytics.report, {
        businessId,
        ...wideRange(),
      }),
    'NO_ACCESS',
  )
})
