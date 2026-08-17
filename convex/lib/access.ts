import { ConvexError } from 'convex/values'
import { authComponent } from '../auth'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx, MutationCtx } from '../_generated/server'

export type Ctx = QueryCtx | MutationCtx
export type Membership = Doc<'memberships'>

/**
 * ARCHITECTURE.md §4.1: every query and mutation resolves the caller's
 * membership first and filters by businessId. A function body that touches
 * ctx.db without calling this first is a bug, whether or not it currently leaks.
 */
export async function requireMembership(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<Membership> {
  const user = await authComponent.getAuthUser(ctx)
  if (!user) throw new ConvexError('UNAUTHENTICATED')

  const membership = await ctx.db
    .query('memberships')
    .withIndex('by_user_business', (q) =>
      q.eq('userId', user._id).eq('businessId', businessId),
    )
    .unique()

  // Same error for "not a member" and "membership revoked" — a distinct
  // message would confirm the business exists to a non-member.
  if (!membership || membership.status !== 'active') {
    throw new ConvexError('NO_ACCESS')
  }

  return membership
}

export async function requireOwner(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<Membership> {
  const membership = await requireMembership(ctx, businessId)
  if (membership.role !== 'owner') throw new ConvexError('NO_ACCESS')
  return membership
}

export type JobVisibility =
  | { scope: 'business'; businessId: Id<'businesses'> }
  | { scope: 'assignee'; membershipId: Id<'memberships'> }

export function jobVisibility(m: Membership): JobVisibility {
  return m.role === 'owner' || m.canViewAllJobs
    ? { scope: 'business', businessId: m.businessId }
    : { scope: 'assignee', membershipId: m._id }
}

/**
 * Write access is deliberately stricter than read: canViewAllJobs grants
 * visibility of another person's booking, never the right to edit it.
 */
export function canEditJob(
  m: Membership,
  job: { assignedMembershipId: Id<'memberships'> },
): boolean {
  return m.role === 'owner' || job.assignedMembershipId === m._id
}

export async function getAuthUserId(ctx: Ctx): Promise<string> {
  const user = await authComponent.getAuthUser(ctx)
  if (!user) throw new ConvexError('UNAUTHENTICATED')
  return user._id
}
