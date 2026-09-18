/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { jobsInScope, visibleJob, wireScope } from './jobScope'
import { createActor, createBusiness, testApp } from '../../test/harness'
import type { Id } from '../_generated/dataModel'
import type { RowScope } from './capabilities'

/**
 * Loading the rows a scope allows.
 *
 * The interesting case is a team, because it is the only one that cannot be a
 * single indexed scan — `by_assignee_date` matches one id, not a list — so the
 * answers have to be merged, and merging is where order and limits go wrong.
 */

async function fixture() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)

  const member = (userId: string) =>
    t.run((ctx) =>
      ctx.db.insert('memberships', {
        userId,
        businessId,
        role: 'subcontractor',
        canViewAllJobs: false,
        colour: '#0ea5e9',
        status: 'active',
        createdAt: 0,
      }),
    )
  const jo = await member('u_jo')
  const kevin = await member('u_kevin')
  const priya = await member('u_priya')

  const propertyId = await t.run(async (ctx) => {
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'A Client',
      createdAt: 0,
      updatedAt: 0,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '1 Test St',
      suburb: 'Perth',
      state: 'WA',
      postcode: '6000',
      createdAt: 0,
    })
  })

  const book = (assignedMembershipId: Id<'memberships'>, scheduledAt: number) =>
    t.run((ctx) =>
      ctx.db.insert('jobs', {
        businessId,
        propertyId,
        assignedMembershipId,
        scheduledAt,
        price: 19500,
        durationMinutes: 60,
        status: 'booked',
        jobType: 'General',
        createdAt: 0,
      }),
    )

  // Interleaved on purpose: a merge that just concatenates would come back
  // grouped by person, which reads as a shuffled calendar.
  await book(jo, 100)
  await book(kevin, 200)
  await book(jo, 300)
  await book(kevin, 400)
  await book(priya, 500)

  return { t, businessId, ownerMembershipId, jo, kevin, priya }
}

const at = (jobs: Array<{ scheduledAt: number }>) =>
  jobs.map((j) => j.scheduledAt)

describe('a team is several indexed scans, merged', () => {
  test('comes back in date order, not grouped by person', async () => {
    const f = await fixture()
    const scope: RowScope = { kind: 'team', membershipIds: [f.jo, f.kevin] }

    const jobs = await f.t.run((ctx) =>
      jobsInScope(ctx, scope, { businessId: f.businessId }),
    )
    expect(at(jobs)).toEqual([100, 200, 300, 400])
  })

  test('leaves out everyone who is not on it', async () => {
    const f = await fixture()
    const jobs = await f.t.run((ctx) =>
      jobsInScope(
        ctx,
        { kind: 'team', membershipIds: [f.jo] },
        { businessId: f.businessId },
      ),
    )
    expect(at(jobs)).toEqual([100, 300])
  })

  /**
   * The whole limit can legitimately come from one member, so each scan has to
   * take the full limit and the trim has to happen after the merge. Taking
   * `limit / members` each would silently drop a busy person's work.
   */
  test('a limit is the newest across the team, not per person', async () => {
    const f = await fixture()
    const jobs = await f.t.run((ctx) =>
      jobsInScope(
        ctx,
        { kind: 'team', membershipIds: [f.jo, f.kevin] },
        {
          businessId: f.businessId,
          order: 'desc',
          limit: 3,
        },
      ),
    )
    expect(at(jobs)).toEqual([400, 300, 200])
  })

  test('honours both ends of a range', async () => {
    const f = await fixture()
    const jobs = await f.t.run((ctx) =>
      jobsInScope(
        ctx,
        { kind: 'team', membershipIds: [f.jo, f.kevin] },
        {
          businessId: f.businessId,
          from: 200,
          to: 400,
        },
      ),
    )
    expect(at(jobs)).toEqual([200, 300])
  })
})

describe('the other two scopes', () => {
  test('business is everyone, in date order', async () => {
    const f = await fixture()
    const jobs = await f.t.run((ctx) =>
      jobsInScope(ctx, { kind: 'business' }, { businessId: f.businessId }),
    )
    expect(at(jobs)).toEqual([100, 200, 300, 400, 500])
  })

  test('own is one person', async () => {
    const f = await fixture()
    const jobs = await f.t.run((ctx) =>
      jobsInScope(
        ctx,
        { kind: 'own', membershipId: f.priya },
        { businessId: f.businessId },
      ),
    )
    expect(at(jobs)).toEqual([500])
  })

  test('a range and a limit agree with the business scan', async () => {
    const f = await fixture()
    const jobs = await f.t.run((ctx) =>
      jobsInScope(
        ctx,
        { kind: 'business' },
        {
          businessId: f.businessId,
          order: 'desc',
          limit: 2,
        },
      ),
    )
    expect(at(jobs)).toEqual([500, 400])
  })
})

describe('one row already in hand', () => {
  /** Null rather than a refusal: a subcontractor who can tell a colleague's
   * job apart from a missing one has learned something about their round. */
  test('a job outside the scope reads as absent', () => {
    const scope: RowScope = {
      kind: 'own',
      membershipId: 'm_a' as Id<'memberships'>,
    }
    const job = { assignedMembershipId: 'm_b' as Id<'memberships'> }
    expect(visibleJob(scope, job)).toBeNull()
    expect(visibleJob(scope, null)).toBeNull()
    expect(
      visibleJob(scope, {
        assignedMembershipId: 'm_a' as Id<'memberships'>,
      }),
    ).not.toBeNull()
  })
})

describe('what the frontend is told', () => {
  /** A third value would not error — the chart and the notice would simply
   * stop rendering, in a build that may be hours behind the backend. */
  test('stays the two values the shipped client understands', () => {
    expect(wireScope({ kind: 'business' })).toBe('business')
    expect(
      wireScope({ kind: 'own', membershipId: 'm' as Id<'memberships'> }),
    ).toBe('assignee')
    expect(wireScope({ kind: 'team', membershipIds: [] })).toBe('assignee')
  })
})
