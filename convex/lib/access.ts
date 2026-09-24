import { ConvexError } from 'convex/values'
import { authComponent } from '../auth'
import { MFA_ENROLMENT_REQUIRED, isMfaRequired } from './mfa'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx, MutationCtx } from '../_generated/server'

export type Ctx = QueryCtx | MutationCtx
export type Membership = Doc<'memberships'>
export type AuthUser = Awaited<ReturnType<typeof authComponent.getAuthUser>>

/**
 * The signed-in person, for every app function — and the one place compulsory
 * two-step sign-in is enforced on the server.
 *
 * The sign-in screen asking for a code is not the control. Anyone signed in
 * before this shipped still holds a live session that never saw a code, and a
 * brand-new account is signed in the moment it is created. So the rule is
 * enforced where the data is: every query and mutation resolves the caller
 * through here, and an account without two-step sign-in set up gets
 * MFA_ENROLMENT_REQUIRED instead of an answer. The client turns that code into
 * the set-up screen, not an error.
 *
 * Deliberately NOT used by (the enrolment allow-list — everything an
 * un-enrolled person needs to reach the set-up screen and nothing more):
 *
 * - `auth.getCurrentUser` — name and email for the set-up screen and the
 *   account menu; reveals nothing they did not type themselves.
 * - `auth.twoFactorStatus` — whether they still have to enrol, which is how
 *   the client knows where to send them.
 * - `invitations.preview` — works signed out by design, so there is nothing
 *   to gate.
 *
 * Joining a business (`invitations.redeem`) and creating one
 * (`businesses.create`) are gated like everything else, on purpose: the order
 * is sign up, set up two-step sign-in, then join. Letting someone join first
 * would put an account with only a password on the team, which is exactly
 * what this exists to stop.
 *
 * Throws ConvexError('Unauthenticated') with no live session, exactly as
 * `getAuthUser` does — the session row is re-read every call, which is what
 * makes offboarding and an owner's two-step reset take effect.
 */
export async function requireAuthUser(ctx: Ctx): Promise<AuthUser> {
  const user = await authComponent.getAuthUser(ctx)
  if (isMfaRequired() && user.twoFactorEnabled !== true) {
    throw new ConvexError(MFA_ENROLMENT_REQUIRED)
  }
  return user
}

/**
 * ARCHITECTURE.md §4.1: every query and mutation resolves the caller's
 * membership first and filters by businessId. A function body that touches
 * ctx.db without calling this first is a bug, whether or not it currently leaks.
 */
export async function requireMembership(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<Membership> {
  // requireAuthUser throws ConvexError('Unauthenticated') when there is no
  // live session, so there is no null case to handle here.
  const user = await requireAuthUser(ctx)

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
 * (editing a job, authorMembershipId, requireOwner, ...): those must always
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
  const user = await requireAuthUser(ctx)
  return user._id
}
