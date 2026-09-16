import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { components } from './_generated/api'
import { authComponent } from './auth'
import { requireMembership } from './lib/access'
import { inviteState } from './lib/inviteTokens'
import { forSelf, recordAudit } from './lib/audit'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { requireActor, requireCapability } from './lib/actor'

/**
 * Offboarding.
 *
 * Until now nothing in the codebase ever set a membership to 'removed'. A
 * subcontractor who finished up, or left on bad terms, kept reading the client
 * book and their own schedule indefinitely, and the only remedy was editing
 * production data by hand.
 *
 * Removing someone is not one write. Their future work has to land on somebody
 * else, their half-finished compliance records have to stay completable, their
 * outstanding invitations have to die, and their session has to stop working.
 * Doing any of that separately leaves a business in a worse state than before.
 */

const FUTURE_JOB_STATUSES = new Set(['booked', 'inProgress'])

async function futureJobsOf(
  ctx: QueryCtx | MutationCtx,
  membershipId: Id<'memberships'>,
  businessId: Id<'businesses'>,
) {
  const jobs = await ctx.db
    .query('jobs')
    .withIndex('by_assignee_date', (q) =>
      q.eq('assignedMembershipId', membershipId).gte('scheduledAt', Date.now()),
    )
    .collect()
  // The index is per assignee, not per business: a member of two businesses
  // must not have the other one's work counted here.
  return jobs.filter(
    (job) =>
      job.businessId === businessId && FUTURE_JOB_STATUSES.has(job.status),
  )
}

async function activeRecurrencesOf(
  ctx: QueryCtx | MutationCtx,
  membershipId: Id<'memberships'>,
  businessId: Id<'businesses'>,
) {
  const recurrences = await ctx.db
    .query('recurrences')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .collect()
  return recurrences.filter(
    (r) => r.active && r.assignedMembershipId === membershipId,
  )
}

async function openDraftsOf(
  ctx: QueryCtx | MutationCtx,
  membershipId: Id<'memberships'>,
  businessId: Id<'businesses'>,
) {
  const reports = await ctx.db
    .query('reports')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .collect()
  return reports.filter(
    (r) => r.authorMembershipId === membershipId && r.status === 'draft',
  )
}

/**
 * What the owner is shown before confirming. "Remove Kevin" means something
 * different when Kevin has twelve jobs booked and a termite certificate part
 * written, and the confirmation should say so.
 */
export const removalPreview = query({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
  },
  handler: async (ctx, { businessId, membershipId }) => {
    requireCapability(await requireActor(ctx, businessId), 'team.manage')
    const target = await ctx.db.get(membershipId)
    if (!target || target.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    const user = await authComponent.getAnyUserById(ctx, target.userId)
    const [futureJobs, recurrences, drafts] = await Promise.all([
      futureJobsOf(ctx, membershipId, businessId),
      activeRecurrencesOf(ctx, membershipId, businessId),
      openDraftsOf(ctx, membershipId, businessId),
    ])

    return {
      name: user?.name ?? user?.email ?? 'This person',
      futureJobs: futureJobs.length,
      activeRecurrences: recurrences.length,
      openDrafts: drafts.length,
    }
  },
})

async function offboard(
  ctx: MutationCtx,
  {
    actor,
    target,
    businessId,
    reassignTo,
    action,
  }: {
    /** Only the id is ever used — for the audit row and `removedByMembershipId`
     * — so this takes the id rather than the whole row. That lets the caller
     * pass either a membership document or the resolved actor's facts, which
     * are not the same shape and do not need to be. */
    actor: { _id: Id<'memberships'> }
    target: Doc<'memberships'>
    businessId: Id<'businesses'>
    reassignTo?: Id<'memberships'>
    action: 'membership.remove' | 'membership.leave'
  },
) {
  const now = Date.now()

  const [futureJobs, recurrences, drafts] = await Promise.all([
    futureJobsOf(ctx, target._id, businessId),
    activeRecurrencesOf(ctx, target._id, businessId),
    openDraftsOf(ctx, target._id, businessId),
  ])

  // Work does not silently disappear from the schedule. If there is anything
  // booked ahead, the caller has to say who picks it up.
  if (futureJobs.length > 0 || recurrences.length > 0) {
    if (!reassignTo) throw new ConvexError('NEEDS_REASSIGNMENT')

    const successor = await ctx.db.get(reassignTo)
    if (
      !successor ||
      successor.businessId !== businessId ||
      successor.status !== 'active' ||
      successor._id === target._id
    ) {
      throw new ConvexError('INVALID_ASSIGNEE')
    }

    for (const job of futureJobs) {
      await ctx.db.patch(job._id, { assignedMembershipId: successor._id })
    }
    for (const recurrence of recurrences) {
      await ctx.db.patch(recurrence._id, {
        assignedMembershipId: successor._id,
      })
    }
  }

  // A half-written Treatment Record is a record the business is required to
  // keep, and only its author can finalise one. Leaving them attached to a
  // removed member would strand them forever, so they move to whoever ran the
  // removal — with the original author preserved in the audit entry.
  for (const draft of drafts) {
    await ctx.db.patch(draft._id, { authorMembershipId: actor._id })
  }

  await ctx.db.patch(target._id, {
    status: 'removed',
    removedAt: now,
    removedByMembershipId: actor._id,
    canViewAllJobs: false,
    canViewOtherAccounts: false,
    viewingAsMembershipId: undefined,
  })

  // Anyone currently looking through this person's eyes stops doing so.
  const siblings = await ctx.db
    .query('memberships')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .collect()
  for (const sibling of siblings) {
    if (sibling.viewingAsMembershipId === target._id) {
      await ctx.db.patch(sibling._id, { viewingAsMembershipId: undefined })
    }
  }

  // An outstanding link for their address would let them walk straight back in.
  const user = await authComponent.getAnyUserById(ctx, target.userId)
  const email = user?.email.toLowerCase()
  if (email) {
    const invitations = await ctx.db
      .query('invitations')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()
    for (const invitation of invitations) {
      if (invitation.businessId !== businessId) continue
      if (inviteState(invitation, now) !== 'valid') continue
      await ctx.db.patch(invitation._id, { revokedAt: now })
    }
  }

  // Convex access stops on their next call regardless, because requireMembership
  // re-reads the membership every time. Deleting the sessions also ends the web
  // session on the device in their pocket — but only if this was their last
  // active membership, since a person can work for two businesses.
  const otherActive = await ctx.db
    .query('memberships')
    .withIndex('by_user', (q) => q.eq('userId', target.userId))
    .collect()
  const stillMemberElsewhere = otherActive.some(
    (m) => m._id !== target._id && m.status === 'active',
  )
  if (!stillMemberElsewhere) {
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: 'session',
        where: [{ field: 'userId', value: target.userId }],
      },
      paginationOpts: { numItems: 200, cursor: null },
    })
  }

  await recordAudit(ctx, forSelf(actor._id), {
    businessId,
    action,
    entityType: 'memberships',
    entityId: target._id,
    meta: {
      reassignedJobs: futureJobs.length,
      reassignedRecurrences: recurrences.length,
      transferredDrafts: drafts.length,
      reassignedTo: reassignTo,
      sessionsRevoked: !stillMemberElsewhere,
    },
    at: now,
  })

  return {
    reassignedJobs: futureJobs.length,
    reassignedRecurrences: recurrences.length,
    transferredDrafts: drafts.length,
  }
}

export const remove = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    reassignTo: v.optional(v.id('memberships')),
  },
  handler: async (ctx, { businessId, membershipId, reassignTo }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real

    const target = await ctx.db.get(membershipId)
    if (!target || target.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (target._id === actor._id) throw new ConvexError('CANNOT_REMOVE_SELF')
    // The owner account is the key to the business. It is not removable from
    // inside the app at all, which also makes "last owner" unreachable here.
    if (target.role === 'owner') throw new ConvexError('LAST_OWNER')
    if (target.status === 'removed') throw new ConvexError('NOT_FOUND')

    return offboard(ctx, {
      actor,
      target,
      businessId,
      reassignTo,
      action: 'membership.remove',
    })
  },
})

/**
 * Leaving is the subcontractor's own decision, the mirror of joining being
 * theirs (§1.4). An owner cannot leave: there would be nobody holding the
 * business.
 */
export const leave = mutation({
  args: {
    businessId: v.id('businesses'),
    reassignTo: v.optional(v.id('memberships')),
  },
  handler: async (ctx, { businessId, reassignTo }) => {
    const actor = await requireMembership(ctx, businessId)
    if (actor.role === 'owner') throw new ConvexError('LAST_OWNER')

    return offboard(ctx, {
      actor,
      target: actor,
      businessId,
      reassignTo,
      action: 'membership.leave',
    })
  },
})
