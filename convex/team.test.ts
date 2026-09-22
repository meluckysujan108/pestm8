/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * Removing someone from a business.
 *
 * The behaviour worth pinning down is not "the row says removed" — it is what
 * happens to everything attached to that person: tomorrow's jobs, the repeating
 * service, the half-finished compliance record, the invitation still sitting in
 * their inbox, and the session on their phone.
 */

async function team() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@coastalpest.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)

  const kevin = await createActor(t, {
    email: 'kevin@kevinspest.test',
    name: 'Kevin',
  })
  const priya = await createActor(t, {
    email: 'priya@example.test',
    name: 'Priya',
  })
  const kevinMembershipId = await join(t, owner, kevin, businessId)
  const priyaMembershipId = await join(t, owner, priya, businessId)

  return {
    t,
    owner,
    kevin,
    priya,
    businessId,
    ownerMembershipId,
    kevinMembershipId,
    priyaMembershipId,
  }
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

async function seedWork(
  t: TestApp,
  businessId: Id<'businesses'>,
  membershipId: Id<'memberships'>,
) {
  return t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
    const jobId = await ctx.db.insert('jobs', {
      businessId,
      propertyId,
      assignedMembershipId: membershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt: now + 3 * 24 * 60 * 60 * 1000,
      durationMinutes: 60,
      status: 'booked',
      createdAt: now,
    })
    const recurrenceId = await ctx.db.insert('recurrences', {
      businessId,
      propertyId,
      assignedMembershipId: membershipId,
      frequency: 'quarterly',
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate: now,
      active: true,
    })
    const reportId = await ctx.db.insert('reports', {
      businessId,
      propertyId,
      authorMembershipId: membershipId,
      template: 'treatmentRecord',
      templateVersion: 1,
      legalBasis: 'APVMA',
      status: 'draft',
      data: {},
      photoIds: [],
      createdAt: now,
    })
    return { jobId, recurrenceId, reportId, propertyId }
  })
}

describe('removing a member', () => {
  test('refuses to strand booked work, then moves it to the named successor', async () => {
    const s = await team()
    const { jobId, recurrenceId } = await seedWork(
      s.t,
      s.businessId,
      s.kevinMembershipId,
    )

    // Kevin has work ahead of him, so the owner must say who picks it up.
    await expect(
      s.owner.as.mutation(api.team.remove, {
        businessId: s.businessId,
        membershipId: s.kevinMembershipId,
      }),
    ).rejects.toThrow(/NEEDS_REASSIGNMENT/)

    const result = await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
      reassignTo: s.priyaMembershipId,
    })
    expect(result).toMatchObject({
      reassignedJobs: 1,
      reassignedRecurrences: 1,
    })

    const { job, recurrence, membership } = await s.t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      recurrence: await ctx.db.get(recurrenceId),
      membership: await ctx.db.get(s.kevinMembershipId),
    }))
    expect(job?.assignedMembershipId).toBe(s.priyaMembershipId)
    expect(recurrence?.assignedMembershipId).toBe(s.priyaMembershipId)
    expect(membership?.status).toBe('removed')
    expect(membership?.removedByMembershipId).toBe(s.ownerMembershipId)
  })

  test('access stops immediately, while their other business is untouched', async () => {
    const s = await team()

    // Kevin also works for a second business — the §6.5 case that makes
    // "revoke their session" the wrong blunt instrument.
    const otherOwner = await createActor(s.t, { email: 'other@else.test' })
    const other = await createBusiness(s.t, otherOwner, 'Other Pest')
    await join(s.t, otherOwner, s.kevin, other.businessId)

    await expect(
      s.kevin.as.query(api.memberships.listForBusiness, {
        businessId: s.businessId,
      }),
    ).resolves.toBeInstanceOf(Array)

    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })

    await expect(
      s.kevin.as.query(api.memberships.listForBusiness, {
        businessId: s.businessId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.kevin.as.query(api.clients.list, { businessId: s.businessId }),
    ).rejects.toThrow(/NO_ACCESS/)

    // Still signed in, and still working for the other business.
    const businesses = await s.kevin.as.query(api.businesses.listForUser, {})
    expect(businesses.map((b) => b.businessId)).toEqual([other.businessId])
  })

  test('their session is deleted when that was their only business', async () => {
    const s = await team()
    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })

    // getAuthUser resolves the session by id; with the row gone, the phone in
    // their pocket is signed out rather than merely losing access.
    await expect(
      s.kevin.as.query(api.businesses.listForUser, {}),
    ).rejects.toThrow(/Unauthenticated/i)
  })

  test('an unfinished compliance draft moves to whoever removed them', async () => {
    const s = await team()
    const { reportId } = await seedWork(s.t, s.businessId, s.kevinMembershipId)

    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
      reassignTo: s.priyaMembershipId,
    })

    const report = await s.t.run(async (ctx) => ctx.db.get(reportId))
    // Only an author can finalise a draft, so leaving it on a removed member
    // would strand a record the business is required to keep.
    expect(report?.authorMembershipId).toBe(s.ownerMembershipId)
  })

  test('an outstanding invitation for their address dies with them', async () => {
    const s = await team()

    // Inserted directly: `invitations.create` refuses to invite an existing
    // member, so a live invite alongside a membership can only be a row that
    // pre-dates today's rules. Those are exactly what must not survive a
    // removal and let someone walk back in.
    await s.t.run(async (ctx) => {
      await ctx.db.insert('invitations', {
        businessId: s.businessId,
        email: 'kevin@kevinspest.test',
        role: 'subcontractor',
        invitedByMembershipId: s.ownerMembershipId,
        createdAt: Date.now(),
        tokenHash: 'legacy-hash',
        expiresAt: Date.now() + 60 * 60 * 1000,
      })
    })

    await s.owner.as.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.kevinMembershipId,
    })

    const live = await s.t.run(async (ctx) => {
      const rows = await ctx.db
        .query('invitations')
        .withIndex('by_email', (q) => q.eq('email', 'kevin@kevinspest.test'))
        .collect()
      return rows.filter(
        (r) => r.claimedAt === undefined && r.revokedAt === undefined,
      )
    })
    expect(live).toHaveLength(0)
  })

  test('the owner cannot be removed, and nobody can remove themselves', async () => {
    const s = await team()

    await expect(
      s.owner.as.mutation(api.team.remove, {
        businessId: s.businessId,
        membershipId: s.ownerMembershipId,
      }),
    ).rejects.toThrow(/CANNOT_REMOVE_SELF/)

    await expect(
      s.kevin.as.mutation(api.team.remove, {
        businessId: s.businessId,
        membershipId: s.priyaMembershipId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('the successor must be an active member of this business', async () => {
    const s = await team()
    await seedWork(s.t, s.businessId, s.kevinMembershipId)

    const outsiderApp = await createActor(s.t, { email: 'other@else.test' })
    const other = await createBusiness(s.t, outsiderApp, 'Other Pest')

    await expect(
      s.owner.as.mutation(api.team.remove, {
        businessId: s.businessId,
        membershipId: s.kevinMembershipId,
        reassignTo: other.ownerMembershipId,
      }),
    ).rejects.toThrow(/INVALID_ASSIGNEE/)
  })
})

describe('leaving', () => {
  test('a subcontractor can leave; an owner cannot', async () => {
    const s = await team()

    await s.kevin.as.mutation(api.team.leave, { businessId: s.businessId })
    const membership = await s.t.run(async (ctx) =>
      ctx.db.get(s.kevinMembershipId),
    )
    expect(membership?.status).toBe('removed')

    await expect(
      s.owner.as.mutation(api.team.leave, { businessId: s.businessId }),
    ).rejects.toThrow(/LAST_OWNER/)
  })
})

describe('after removal', () => {
  test('the repeating-service cron stops booking work for them', async () => {
    const s = await team()
    const { recurrenceId } = await seedWork(
      s.t,
      s.businessId,
      s.kevinMembershipId,
    )

    // Leave the series pointed at Kevin so the cron has to make the decision.
    await s.kevin.as.mutation(api.team.leave, {
      businessId: s.businessId,
      reassignTo: s.priyaMembershipId,
    })
    await s.t.run(async (ctx) => {
      await ctx.db.patch(recurrenceId, {
        assignedMembershipId: s.kevinMembershipId,
      })
    })

    const before = await s.t.run(
      async (ctx) => (await ctx.db.query('jobs').collect()).length,
    )
    await s.t.mutation(internal.recurrences.materialiseAll, {})
    const after = await s.t.run(
      async (ctx) => (await ctx.db.query('jobs').collect()).length,
    )
    expect(after).toBe(before)
  })
})
