import { ConvexError } from 'convex/values'
import { authComponent } from '../auth'
import type { Doc, Id } from '../_generated/dataModel'
import type { MembershipFacts } from './capabilities'
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
  // getAuthUser throws ConvexError('Unauthenticated') when there is no live
  // session, so there is no null case to handle here.
  const user = await authComponent.getAuthUser(ctx)

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

/**
 * True per-membership permission check for "view as" — never trusted from a
 * stored flag alone, always re-derived against the CURRENT state of both
 * memberships. An owner may view as any active subcontractor in their own
 * business; a subcontractor granted `canViewOtherAccounts` may view as any
 * OTHER active subcontractor in the same business — never the owner, even
 * then, and never across businesses.
 */
export function canViewAs(caller: Membership, target: Membership): boolean {
  if (target.businessId !== caller.businessId) return false
  if (target.status !== 'active') return false
  if (target._id === caller._id) return false
  if (target.role === 'owner') return false
  return caller.role === 'owner' || caller.canViewOtherAccounts === true
}

/**
 * The effective membership for READ SCOPE only — e.g. feeding `jobVisibility`
 * for a list query. Never use this for anything identity- or write-bearing
 * (canEditJob, authorMembershipId, requireOwner, ...): those must always
 * resolve the REAL caller via `requireMembership`, so "view as" can never be
 * used to act as anyone. If the caller's stored `viewingAsMembershipId` no
 * longer checks out (grant revoked, target archived, etc.), this silently
 * falls back to the caller's own membership rather than erroring — a stale
 * selection should never break the page, only stop taking effect.
 */
export async function resolveViewScope(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<Membership> {
  const real = await requireMembership(ctx, businessId)
  if (!real.viewingAsMembershipId) return real

  const target = await ctx.db.get(real.viewingAsMembershipId)
  if (!target || !canViewAs(real, target)) return real

  return target
}

export type JobVisibility =
  | { scope: 'business'; businessId: Id<'businesses'> }
  | { scope: 'assignee'; membershipId: Id<'memberships'> }

/**
 * Takes resolved facts rather than a membership row, so the only place that
 * reads the legacy `canViewAllJobs` column is `grantsFromMembership` — where
 * the mapping to `otherSchedules` is written down and explained. Same answer
 * for every row in existence; one fewer place that knows the old column name.
 */
export function jobVisibility(m: MembershipFacts): JobVisibility {
  return m.role === 'owner' || m.grants.otherSchedules
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

/**
 * The person a job or series may be booked onto.
 *
 * `jobs.update` used to patch `assignedMembershipId` without loading it at all,
 * so a member of any business could push jobs onto someone else's calendar in a
 * business they had never joined — the victim saw attacker-chosen addresses on
 * their schedule and could not open or cancel them. `recurrences.create` had
 * the same gap, and the daily cron kept materialising more.
 *
 * Status matters as well as tenancy: booking work for someone who was invited
 * but never joined, or who has been removed, puts jobs on a calendar nobody is
 * reading.
 */
export async function requireAssignableMember(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  membershipId: Id<'memberships'>,
): Promise<Membership> {
  const assignee = await ctx.db.get(membershipId)
  if (
    !assignee ||
    assignee.businessId !== businessId ||
    assignee.status !== 'active'
  ) {
    throw new ConvexError('INVALID_ASSIGNEE')
  }
  return assignee
}

export async function getAuthUserId(ctx: Ctx): Promise<string> {
  const user = await authComponent.getAuthUser(ctx)
  return user._id
}
