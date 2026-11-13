import { ConvexError } from 'convex/values'
import type { MutationCtx } from '../_generated/server'
import type { Doc } from '../_generated/dataModel'

/**
 * The rules a job's status obeys, in one place, so that every path that writes
 * one asks the same question.
 *
 * Convex has no check constraints or triggers, so "enforced at the database"
 * means this: the schema admits `recurring` and `paid`, but no mutation
 * argument does (`settableJobStatus` in schema.ts), and every write that
 * changes an existing job's status asks `assertStatusChange` — directly in
 * `jobs.update`, through `setJobStatus` everywhere else. The only code that
 * ever produces `recurring` is `initialJobStatus('recurrence')`, called when
 * the recurrence engine inserts a visit, and the only code that moves a job
 * into or out of `paid` is `followMoney`, called when its payments change.
 * convex/jobStatus.test.ts and convex/payments.test.ts hold every path to that.
 *
 * Browser-safe, like lib/siteWork.ts: `src/` reads `detailsLocked` and
 * `sinksOnDay` from here, so the phone and the server cannot disagree.
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
 * is" policy guards the way INTO these — from any of them — so that picking
 * Invoiced, or taking the money, is not a way round what picking Completed
 * would be refused.
 */
export const DONE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'completed',
  'invoiced',
  'paid',
])

/**
 * Work that counts: booked by somebody and not called off. A projection is
 * the engine's guess at a date nobody has confirmed, and a cancellation is
 * work that is not happening, so neither goes into a job total anywhere —
 * the week strip, the month grid, the team legend, the dashboard, analytics.
 * Projections are counted, when they are, as their own separate number.
 */
export function isCountedJob(job: { status: JobStatus }): boolean {
  return job.status !== 'cancelled' && job.status !== 'recurring'
}

/** A move from unfinished work to finished work — what the report policy asks about. */
export function entersDone(from: JobStatus, to: JobStatus): boolean {
  return DONE_STATUSES.has(to) && !DONE_STATUSES.has(from)
}

/**
 * Billed or settled, so what the job says can no longer change on its own: the
 * price, the date and who went are what the invoice or the receipt says. A
 * string, because the phone asks it of whatever status it was last told.
 */
export function detailsLocked(status: string): boolean {
  return status === 'invoiced' || status === 'paid'
}

/** Why a locked job refused a change, in the code the form has words for. */
export function detailsLockedError(status: string): ConvexError<string> {
  return new ConvexError(status === 'paid' ? 'JOB_PAID' : 'JOB_INVOICED')
}

/**
 * Nothing moves a job INTO `recurring` or `paid` by asking: the first is the
 * engine's, the second follows from payments. And nothing moves one out of
 * `paid` by asking either, because a job that says Invoiced with its money in
 * hand is telling the owner to chase someone who has paid: removing the
 * payment is how it is reopened (`followMoney`). A job already at a status
 * staying there is not a move, and is allowed.
 */
export function assertStatusChange(from: JobStatus, to: JobStatus): void {
  if (to === from) return
  if (to === 'recurring' || to === 'paid') {
    throw new ConvexError('STATUS_NOT_SETTABLE')
  }
  if (from === 'paid') throw new ConvexError('JOB_PAID')
}

/**
 * What a change of status does to `invoicedAt`: set on the way into Invoiced,
 * and cleared by being moved out of it by hand, which says it was not billed
 * after all. Going to Paid is neither, so that removing the payment can tell
 * a billed job from one that never was.
 */
export function invoiceStamp(
  job: Pick<Doc<'jobs'>, 'status' | 'invoicedAt'>,
  to: JobStatus,
  now: number = Date.now(),
): Partial<Pick<Doc<'jobs'>, 'invoicedAt'>> {
  if (to === job.status) return {}
  if (to === 'invoiced') return { invoicedAt: now }
  if (to === 'paid' || job.invoicedAt === undefined) return {}
  return { invoicedAt: undefined }
}

/**
 * The one way to change an existing job's status by hand. `extra` rides along
 * in the same patch for a field the transition stamps (`completedAt`).
 */
export async function setJobStatus(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  status: JobStatus,
  extra: Partial<Pick<Doc<'jobs'>, 'completedAt'>> = {},
): Promise<void> {
  assertStatusChange(job.status, status)
  await ctx.db.patch(job._id, {
    ...extra,
    ...invoiceStamp(job, status),
    status,
  })
}

/**
 * The money a job has taken, from its live payments.
 *
 * `afterWork` is the part of `paid` that was not a deposit. A deposit is money
 * ahead of the work and says nothing about billing; money taken once the work
 * is done with some still owing is "part now, the rest later", which is what
 * makes a job Invoiced.
 */
export type JobMoney = { paid: number; afterWork: number; waived: boolean }

export function moneyOf(
  payments: ReadonlyArray<
    Pick<Doc<'payments'>, 'amount' | 'method' | 'deposit' | 'removedAt'>
  >,
): JobMoney {
  const live = payments.filter((p) => p.removedAt === undefined)
  return {
    paid: live.reduce((sum, p) => sum + p.amount, 0),
    afterWork: live
      .filter((p) => p.deposit !== true)
      .reduce((sum, p) => sum + p.amount, 0),
    waived: live.some((p) => p.method === 'noCharge'),
  }
}

/** Cents still owing. Past the price is nothing owing, not a negative. */
export function owingOn(price: number, money: JobMoney): number {
  return money.waived ? 0 : Math.max(0, price - money.paid)
}

/**
 * Nothing left to collect. Money has to have been recorded: a job with no
 * price and no payment is not paid, it is a job nobody has priced. A $0 job
 * is settled by saying "No charge".
 */
export function isSettled(price: number, money: JobMoney): boolean {
  return money.waived || (money.paid > 0 && money.paid >= price)
}

/**
 * The status a finished job's money gives it, whichever way the money just
 * moved. A job not finished yet keeps its own: a deposit leaves it Booked.
 *
 * - All of it in → Paid.
 * - Billed, or part taken after the work → Invoiced: the rest is owed.
 * - Otherwise (the last payment taken off, say) → Completed: to bill.
 */
export function statusFromMoney(
  job: Pick<Doc<'jobs'>, 'status' | 'price' | 'invoicedAt'>,
  money: JobMoney,
): JobStatus {
  if (!DONE_STATUSES.has(job.status)) return job.status
  if (isSettled(job.price, money)) return 'paid'
  if (job.invoicedAt !== undefined || money.afterWork > 0) return 'invoiced'
  return 'completed'
}

/**
 * What finishing a job as `chosen` really makes it: a deposit that already
 * covers the price means there is nothing to bill, and it goes straight to
 * Paid. Short of that it is what the person chose.
 */
export function finishedStatus(
  chosen: 'completed' | 'invoiced',
  price: number,
  money: JobMoney,
): JobStatus {
  return isSettled(price, money) ? 'paid' : chosen
}

/**
 * A job's status following its money: the only way into or out of `paid`.
 * Not `setJobStatus`, whose whole point is to refuse this move when a person
 * asks for it.
 */
export async function followMoney(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  status: JobStatus,
  extra: Partial<Pick<Doc<'jobs'>, 'completedAt' | 'invoicedAt'>> = {},
): Promise<void> {
  if (status === 'recurring') throw new ConvexError('STATUS_NOT_SETTABLE')
  await ctx.db.patch(job._id, { ...extra, status })
}

/**
 * Finished as far as the day's list is concerned: the work is over and nobody
 * is going. Invoiced and Paid count only once the work is done, because a
 * visit can be billed and even settled before it happens, and sinking that
 * would hide one still ahead.
 */
export function sinksOnDay(job: {
  status: string
  completedAt?: number
}): boolean {
  return (
    job.status === 'completed' ||
    // Billed or paid at the door, which is the end of the visit. One billed
    // ahead of the work has no completion yet, and is still to be done.
    ((job.status === 'invoiced' || job.status === 'paid') &&
      job.completedAt !== undefined)
  )
}

/**
 * A day's jobs in the order the schedule lists them: by start time, with
 * finished work sunk to the bottom so what is still ahead leads the day.
 * Stable, so finished jobs keep their own time order among themselves.
 */
export function orderForDay<
  T extends { status: JobStatus; scheduledAt: number; completedAt?: number },
>(jobs: Array<T>): Array<T> {
  return [...jobs]
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .sort((a, b) => Number(sinksOnDay(a)) - Number(sinksOnDay(b)))
}
