import { ConvexError } from 'convex/values'
import type { MutationCtx } from '../_generated/server'
import type { Doc } from '../_generated/dataModel'

/**
 * The rules a job's status obeys, in one place, so that every path that writes
 * one asks the same question.
 *
 * Convex has no check constraints or triggers, so "enforced at the database"
 * means this: the schema admits `recurring`, but no mutation argument does
 * (`settableJobStatus` in schema.ts), and every write that changes an existing
 * job's status asks `assertStatusChange` — directly in `jobs.update`, through
 * `setJobStatus` everywhere else. The only code that ever produces `recurring`
 * is `initialJobStatus('recurrence')`, called when the recurrence engine
 * inserts a visit. convex/jobStatus.test.ts holds every path to that.
 */

export type JobStatus = Doc<'jobs'>['status']

/**
 * The status a job is born with. By hand it is `pending`; projected by the
 * recurrence engine it is `recurring`, which is the only way a job ever gets
 * that status.
 */
export function initialJobStatus(origin: 'manual' | 'recurrence'): JobStatus {
  return origin === 'recurrence' ? 'recurring' : 'pending'
}

/**
 * Work nobody has started: a projected visit, or one booked by hand and not
 * yet begun. Ending a series cancels these; removing a person hands these on.
 */
export const NOT_STARTED_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'recurring',
  'pending',
  'booked',
])

/**
 * Work that is done, billed or not. The business's "not done until its report
 * is" policy guards the way INTO these — from either status — so that picking
 * Invoiced is not a way round what picking Completed would be refused.
 */
export const DONE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'completed',
  'invoiced',
])

/** A move from unfinished work to finished work — what the report policy asks about. */
export function entersDone(from: JobStatus, to: JobStatus): boolean {
  return DONE_STATUSES.has(to) && !DONE_STATUSES.has(from)
}

/**
 * One-way, like a draft order becoming an order: nothing can move a job INTO
 * `recurring`. A job that is already `recurring` staying so is not a move, and
 * is allowed — anything else arriving at `recurring` is refused, whether the
 * job left it a moment ago or never had it.
 */
export function assertStatusChange(from: JobStatus, to: JobStatus): void {
  if (to === 'recurring' && from !== 'recurring') {
    throw new ConvexError('STATUS_NOT_SETTABLE')
  }
}

/**
 * The one way to change an existing job's status. `extra` rides along in the
 * same patch for a field the transition stamps (`completedAt`).
 */
export async function setJobStatus(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  status: JobStatus,
  extra: Partial<Pick<Doc<'jobs'>, 'completedAt'>> = {},
): Promise<void> {
  assertStatusChange(job.status, status)
  await ctx.db.patch(job._id, { ...extra, status })
}

/**
 * A day's jobs in the order the schedule lists them: by start time, with
 * completed work sunk to the bottom so what is still ahead leads the day.
 * Stable, so completed jobs keep their own time order among themselves.
 */
export function orderForDay<
  T extends { status: JobStatus; scheduledAt: number },
>(jobs: Array<T>): Array<T> {
  return [...jobs]
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .sort(
      (a, b) =>
        Number(a.status === 'completed') - Number(b.status === 'completed'),
    )
}
