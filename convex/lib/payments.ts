import { ConvexError } from 'convex/values'
import { unbinned } from './bin'
import { DONE_STATUSES, moneyOf, owingOn } from './jobStatus'
import {
  MAX_HAND_OVER_NOTE_LENGTH,
  MAX_REFERENCE_LENGTH,
} from './paymentLimits'
import { hidePrices, redactTotal } from './prices'
import type { CapabilitySet } from './capabilities'
import type { JobMoney } from './jobStatus'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * Reading what has been paid. Which status that money gives a job is
 * lib/jobStatus.ts; who may record it is convex/payments.ts.
 */

/**
 * More than any job takes, and the read below is cut off here. `payments.record`
 * refuses the next one, so a row past the limit can never go uncounted.
 */
export const MAX_PAYMENTS_ON_A_JOB = 200

/**
 * The most rows the owner's figures read, newest first. They share one query's
 * read limit with the jobs read beside them (`jobsInScope`), so this is a
 * ceiling and not a promise: a business past about 15,000 jobs needs running
 * totals instead.
 */
const MAX_PAYMENTS_READ = 16000

/** Far more jobs than any business gives away; the newest count if not. */
const MAX_WAIVED_JOBS = 500

/** Every payment on a job, taken back or not. */
export function paymentsOfJob(
  ctx: QueryCtx | MutationCtx,
  jobId: Id<'jobs'>,
): Promise<Array<Doc<'payments'>>> {
  return ctx.db
    .query('payments')
    .withIndex('by_jobId', (q) => q.eq('jobId', jobId))
    .take(MAX_PAYMENTS_ON_A_JOB)
}

export async function moneyOnJob(
  ctx: QueryCtx | MutationCtx,
  jobId: Id<'jobs'>,
): Promise<JobMoney> {
  return moneyOf(await paymentsOfJob(ctx, jobId))
}

/**
 * What a job's card says about its money, oldest payment first. Only for work
 * that is done: anything sooner has nothing to say yet, and a day's cards
 * should not each pay for a read to say it.
 */
export async function paymentOnCard(
  ctx: QueryCtx,
  caps: CapabilitySet,
  job: Doc<'jobs'>,
) {
  if (!DONE_STATUSES.has(job.status)) return undefined
  const rows = (await paymentsOfJob(ctx, job._id))
    .filter((row) => row.removedAt === undefined)
    .sort((a, b) => a.receivedAt - b.receivedAt)
  const money = moneyOf(rows)
  const hidden = hidePrices(caps)
  return {
    methods: [...new Set(rows.map((row) => row.method))],
    paid: hidden ? 0 : money.paid,
    owing: hidden ? 0 : owingOn(job.price, money),
  }
}

/**
 * What each job marked No charge actually brought in, for whatever adds up
 * earnings from job prices: a job given away did not earn its price. Usually
 * nothing, or a deposit kept. Absent from the map means the job earned its
 * price as usual.
 */
export async function earnedOnWaivedJobs(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
): Promise<Map<Id<'jobs'>, number>> {
  const waivers = await ctx.db
    .query('payments')
    .withIndex('by_businessId_and_method', (q) =>
      q.eq('businessId', businessId).eq('method', 'noCharge'),
    )
    .order('desc')
    .take(MAX_WAIVED_JOBS)
  const entries = await Promise.all(
    waivers
      .filter((waiver) => waiver.removedAt === undefined)
      .map(
        async (waiver) =>
          [waiver.jobId, (await moneyOnJob(ctx, waiver.jobId)).paid] as const,
      ),
  )
  return new Map(entries)
}

/** Below this many jobs, each one's payments are read on their own. */
const PER_JOB_READS = 200

/**
 * What is left to bill on each of these jobs, a deposit taken off: as To bill
 * counts it (`moneyFigures`). A few jobs read their own payments; more read
 * the business's once, as the figures do, rather than make a query each.
 */
export async function leftToBill(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  jobs: ReadonlyArray<Doc<'jobs'>>,
): Promise<Map<Id<'jobs'>, number>> {
  if (jobs.length <= PER_JOB_READS) {
    return new Map(
      await Promise.all(
        jobs.map(
          async (job) =>
            [
              job._id,
              owingOn(job.price, await moneyOnJob(ctx, job._id)),
            ] as const,
        ),
      ),
    )
  }
  const wanted = new Set(jobs.map((job) => job._id))
  const byJob = new Map<Id<'jobs'>, Array<Doc<'payments'>>>()
  const read = await ctx.db
    .query('payments')
    .withIndex('by_businessId_and_receivedAt', (q) =>
      q.eq('businessId', businessId),
    )
    .order('desc')
    .take(MAX_PAYMENTS_READ)
  for (const row of read) {
    if (!wanted.has(row.jobId)) continue
    byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), row])
  }
  return new Map(
    jobs.map((job) => [
      job._id,
      owingOn(job.price, moneyOf(byJob.get(job._id) ?? [])),
    ]),
  )
}

/** Trimmed, and absent when blank. */
function trimmedWithin(
  raw: string | undefined,
  limit: number,
): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  if (trimmed.length > limit) throw new ConvexError('INVALID_PAYMENT')
  return trimmed
}

export function normaliseReference(
  raw: string | undefined,
): string | undefined {
  return trimmedWithin(raw, MAX_REFERENCE_LENGTH)
}

export function normaliseHandOverNote(
  raw: string | undefined,
): string | undefined {
  return trimmedWithin(raw, MAX_HAND_OVER_NOTE_LENGTH)
}

/**
 * Money marked as someone else's and not passed on yet, by who owes whom.
 *
 * The person it is owed to sees it even on a job that is not theirs to see:
 * when a subcontractor's work is given to the owner, the money coming back is
 * the one thing about that job they still need to know.
 */
async function openHandOvers(
  ctx: QueryCtx,
  live: ReadonlyArray<Doc<'payments'>>,
  seen: ReadonlySet<Id<'jobs'>>,
  viewer: Id<'memberships'>,
) {
  const pairs = new Map<
    string,
    {
      from: Id<'memberships'>
      to: Id<'memberships'>
      value: number
      paymentIds: Array<Id<'payments'>>
    }
  >()
  for (const row of live) {
    const mark = row.handOver
    if (!mark || mark.doneAt !== undefined) continue
    if (!seen.has(row.jobId)) {
      const party = mark.from === viewer || mark.to === viewer
      if (!party || !unbinned(await ctx.db.get(row.jobId))) continue
    }
    const key = `${mark.from}:${mark.to}`
    const pair = pairs.get(key) ?? {
      from: mark.from,
      to: mark.to,
      value: 0,
      paymentIds: [],
    }
    pair.value += row.amount
    pair.paymentIds.push(row._id)
    pairs.set(key, pair)
  }
  return [...pairs.values()]
}

/**
 * Whether a job's money is counted on the Payments page: work booked, done
 * or billed on or after the day the business counts from
 * (`businesses.paymentsFrom`). A visit booked before the day but finished
 * after it was asked how it was paid, so it counts.
 */
export function counts(
  job: Pick<Doc<'jobs'>, 'scheduledAt' | 'completedAt' | 'invoicedAt'>,
  countsFrom: number,
) {
  return (
    job.scheduledAt >= countsFrom ||
    (job.completedAt ?? -1) >= countsFrom ||
    (job.invoicedAt ?? -1) >= countsFrom
  )
}

/** The day the business counts from; 0 or absent counts everything. */
export function countsFromOf(business: Doc<'businesses'>): number {
  return business.paymentsFrom ?? 0
}

/** When a job was billed, as near as it says: the invoice, else the visit. */
export function billedAt(job: Doc<'jobs'>): number {
  return job.invoicedAt ?? job.completedAt ?? job.scheduledAt
}

/**
 * What the owner's money figures add up to, over the jobs this caller may see:
 *
 * - To bill: Completed, less any deposit. Nobody has billed it or been paid.
 * - Owing: Invoiced, less what has come in.
 * - Paid this month: money received this calendar month, by when it arrived.
 * - Hand-overs: money someone marked as another person's, not passed on yet.
 *
 * And all but the last again per person (`byPerson`), because a subcontractor
 * is self-employed and keeps what they earn: one total for the business would
 * tell the owner they have money that was never theirs. A job's balance is its
 * lead's. Money received is too, unless it is marked for someone else, when it
 * counts as that person's whether or not it has reached them yet.
 *
 * `jobs` is everything in scope, cancelled included: a deposit on a job later
 * called off is still money somebody took, until it is taken back. A job in
 * the Recycle bin is not in it, and so nor is its money.
 *
 * To bill and Owing count work booked from `countsFrom` (the business's
 * `paymentsFrom`, see schema.ts); older work still waiting is counted apart,
 * as `olderNotCounted`, so the page can say it is there and offer to count
 * it. Money received is counted whatever job it was for: it really came in.
 *
 * Read once and added up in memory, as `dashboard.summary` does its jobs: the
 * alternative is a query per unpaid job, and years of Invoiced work would run
 * into the limit on how many one function may make.
 */
export async function moneyFigures(
  ctx: QueryCtx,
  caps: CapabilitySet,
  businessId: Id<'businesses'>,
  jobs: ReadonlyArray<Doc<'jobs'>>,
  month: { start: number; end: number },
  viewer: Id<'memberships'>,
  countsFrom = 0,
) {
  const seen = new Set(jobs.map((job) => job._id))
  const live = (
    await ctx.db
      .query('payments')
      .withIndex('by_businessId_and_receivedAt', (q) =>
        q.eq('businessId', businessId),
      )
      .order('desc')
      .take(MAX_PAYMENTS_READ)
  ).filter((row) => row.removedAt === undefined)
  const rows = live.filter((row) => seen.has(row.jobId))

  const byJob = new Map<Id<'jobs'>, Array<Doc<'payments'>>>()
  for (const row of rows) {
    byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), row])
  }
  const waiting = (job: Doc<'jobs'>) =>
    job.status === 'completed' || job.status === 'invoiced'
  const balanceOf = (job: Doc<'jobs'>) => ({
    lead: job.assignedMembershipId,
    owed: owingOn(job.price, moneyOf(byJob.get(job._id) ?? [])),
  })
  const counted = jobs.filter((job) => waiting(job) && counts(job, countsFrom))
  const older = jobs.filter((job) => waiting(job) && !counts(job, countsFrom))
  const total = (values: ReadonlyArray<number>) =>
    values.reduce((sum, value) => sum + value, 0)

  const toBill = counted
    .filter((job) => job.status === 'completed')
    .map(balanceOf)
  const owingJobs = counted.filter((job) => job.status === 'invoiced')
  const owing = owingJobs.map(balanceOf)
  // How long the oldest bill has waited, for "oldest 34 days".
  const owingSince = owingJobs.length
    ? Math.min(...owingJobs.map(billedAt))
    : null
  const thisMonth = rows.filter(
    (row) => row.receivedAt >= month.start && row.receivedAt < month.end,
  )

  type Methods = Map<Doc<'payments'>['method'], number>
  const addMethod = (methods: Methods, row: Doc<'payments'>) => {
    if (row.amount > 0) {
      methods.set(row.method, (methods.get(row.method) ?? 0) + row.amount)
    }
  }
  const methodList = (methods: Methods) =>
    [...methods.entries()].map(([method, value]) => ({ method, value }))

  const methods: Methods = new Map()
  for (const row of thisMonth) addMethod(methods, row)

  const people = new Map<
    Id<'memberships'>,
    {
      toBill: number
      toBillValue: number
      owing: number
      owingValue: number
      paidThisMonth: number
      methods: Methods
    }
  >()
  const person = (membershipId: Id<'memberships'>) => {
    const found = people.get(membershipId)
    if (found) return found
    const fresh = {
      toBill: 0,
      toBillValue: 0,
      owing: 0,
      owingValue: 0,
      paidThisMonth: 0,
      methods: new Map() as Methods,
    }
    people.set(membershipId, fresh)
    return fresh
  }
  for (const { lead, owed } of toBill) {
    person(lead).toBill += 1
    person(lead).toBillValue += owed
  }
  for (const { lead, owed } of owing) {
    person(lead).owing += 1
    person(lead).owingValue += owed
  }
  const leadOf = new Map(jobs.map((job) => [job._id, job.assignedMembershipId]))
  for (const row of thisMonth) {
    const whose = row.handOver?.to ?? leadOf.get(row.jobId)
    // A No charge brought in nothing, so it gives nobody a line.
    if (whose === undefined || row.amount === 0) continue
    person(whose).paidThisMonth += row.amount
    addMethod(person(whose).methods, row)
  }

  // The count travels with the value, as `dashboard.summary` says: beside a
  // hidden total, a count of one is the price.
  const hidden = hidePrices(caps)
  return {
    toBill: redactTotal(caps, toBill.length),
    toBillValue: redactTotal(caps, total(toBill.map((b) => b.owed))),
    owing: redactTotal(caps, owing.length),
    owingValue: redactTotal(caps, total(owing.map((b) => b.owed))),
    owingSince: hidden ? null : owingSince,
    olderNotCounted: redactTotal(caps, older.length),
    olderNotCountedValue: redactTotal(
      caps,
      total(older.map((job) => balanceOf(job).owed)),
    ),
    paidThisMonth: redactTotal(caps, total(thisMonth.map((r) => r.amount))),
    paidThisMonthByMethod: hidden ? [] : methodList(methods),
    byPerson: hidden
      ? []
      : [...people.entries()].map(
          ([membershipId, { methods: theirs, ...figures }]) => ({
            membershipId,
            ...figures,
            paidThisMonthByMethod: methodList(theirs),
          }),
        ),
    handOvers: hidden ? [] : await openHandOvers(ctx, live, seen, viewer),
  }
}
