import { ConvexError } from 'convex/values'
import { requireAssignableMember } from './access'
import { requireWriteActor, teamOf } from './actor'
import { canDispatchTo, canEditJob } from './capabilities'
import { factsFromMembership } from './membershipFacts'
import type { Ctx, WriteEnvelope } from './actor'
import type { ReadActor } from './capabilities'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * Who may change booked work, and who it may be booked onto — the two
 * questions every job and recurrence mutation asks, answered once.
 *
 * `jobs.ts` and `recurrences.ts` each kept a private copy of the edit guard
 * while it was three lines. It is not any more: a contractor's right to edit
 * their team's work needs the team loaded, and two copies of that are two
 * chances for one file to let a contractor reach work the other refuses.
 *
 * Both decide on the ACTING account, through the write actor. The old guard
 * resolved the real person with `requireMembership`, which never reads a
 * switch — so an owner working inside a subcontractor's account wrote with
 * the owner's full reach, nothing recorded that he was in someone else's
 * account, and a switch past its twelve hours still wrote.
 */

/**
 * `canEditJob`, with the contractor's team loaded only when it can change the
 * answer: the acting account is a contractor, and the work is not theirs.
 *
 * Works for a recurrence as well as a job — both are scoped by who the work is
 * assigned to, and that is the only column this reads.
 */
export async function mayEditJob(
  ctx: Ctx,
  actor: ReadActor,
  work: { assignedMembershipId: Id<'memberships'> },
): Promise<boolean> {
  const acting = actor.acting
  const team =
    acting.role === 'contractor' && work.assignedMembershipId !== acting._id
      ? await teamOf(ctx, acting.businessId, acting._id)
      : []
  return canEditJob(actor, work, team)
}

/**
 * Resolve the writer, load the job, confirm it belongs to this business, and
 * refuse a write from anyone the acting account may not edit it as.
 */
export async function requireEditableJob(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  jobId: Id<'jobs'>,
): Promise<{ env: WriteEnvelope; job: Doc<'jobs'> }> {
  const env = await requireWriteActor(ctx, businessId)

  const job = await ctx.db.get(jobId)
  if (!job || job.businessId !== businessId) throw new ConvexError('NOT_FOUND')
  if (!(await mayEditJob(ctx, env.actor, job))) {
    throw new ConvexError('NO_ACCESS')
  }

  return { env, job }
}

/**
 * Refuse to book work onto someone this writer may not dispatch to.
 *
 * Tenancy and status first, with their own error: an id from another business,
 * or someone invited but never joined, is a bad argument whoever is asking.
 * Then `canDispatchTo`, on the acting account — the same function the roster's
 * `bookable` flag comes from, so a picker cannot offer a refused option.
 */
export async function requireBookable(
  ctx: MutationCtx,
  env: WriteEnvelope,
  businessId: Id<'businesses'>,
  assigneeId: Id<'memberships'>,
): Promise<void> {
  const assignee = await requireAssignableMember(ctx, businessId, assigneeId)
  if (!canDispatchTo(env.actor, factsFromMembership(assignee))) {
    throw new ConvexError('NO_ACCESS')
  }
}
