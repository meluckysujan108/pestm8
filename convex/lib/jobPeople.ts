import { ConvexError } from 'convex/values'
import { isBinned } from './bin'
import { isInScope, reportReadable } from './capabilities'
import type { RowScope } from './capabilities'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * A job for more than one person: its lead (`jobs.assignedMembershipId`,
 * "Assigned to") and the people "also going" (`jobPeople`, one row each).
 *
 * The lead is everything one person has always been to a job — its colour on
 * the schedule, the name a report starts with (unless someone else on the job
 * writes it), who inherits it when someone leaves. Everyone on the job SEES it
 * wherever its lead would, and may do on it whatever its lead may
 * (`canEditJob`, which counts them all).
 *
 * The rule every reader keeps: a check that looks only at the lead leaves the
 * others silently out — Kevin simply doesn't see the job. So a scope check on a
 * job goes through `inScope` with `sharedJobIds`, or `jobInScope` for one job;
 * never `isInScope` on a job alone outside the business scope.
 */

/** Most people also going on one job, beside its lead. */
export const MAX_ALSO_GOING = 5

/** Most of one person's shared jobs read to answer a scope question. */
const MAX_SHARED_READ = 2000

/**
 * Most shared jobs one list reads, per person — each is a document fetched,
 * against a query's 4,096. Newest first when the list has no dates, so a
 * long history drops its oldest.
 */
const MAX_SHARED_JOBS = 400

/** The people also going on a job — not its lead — in the order added. */
export async function alsoGoingOf(
  ctx: QueryCtx,
  jobId: Id<'jobs'>,
): Promise<Array<Id<'memberships'>>> {
  const rows = await ctx.db
    .query('jobPeople')
    .withIndex('by_job', (q) => q.eq('jobId', jobId))
    .take(MAX_ALSO_GOING * 2)
  return rows.map((row) => row.membershipId)
}

/**
 * The people also going on each of these jobs, by job — one indexed read a
 * job, all at once. For a list already in hand; a date window is cheaper read
 * with `alsoGoingInWindow`.
 */
export async function alsoGoingFor(
  ctx: QueryCtx,
  jobs: ReadonlyArray<{ _id: Id<'jobs'> }>,
): Promise<Map<Id<'jobs'>, Array<Id<'memberships'>>>> {
  const lists = await Promise.all(jobs.map((job) => alsoGoingOf(ctx, job._id)))
  return new Map(
    jobs.flatMap((job, i) =>
      lists[i].length > 0 ? [[job._id, lists[i]]] : [],
    ),
  )
}

/**
 * The people also going on every job of a business in a window, by job: one
 * range read, where a month's schedule would otherwise read once per job.
 */
export async function alsoGoingInWindow(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  from: number,
  to: number,
): Promise<Map<Id<'jobs'>, Array<Id<'memberships'>>>> {
  const rows = await ctx.db
    .query('jobPeople')
    .withIndex('by_business_date', (q) =>
      q
        .eq('businessId', businessId)
        .gte('scheduledAt', from)
        .lt('scheduledAt', to),
    )
    .collect()
  const byJob = new Map<Id<'jobs'>, Array<Id<'memberships'>>>()
  for (const row of rows) {
    const list = byJob.get(row.jobId) ?? []
    list.push(row.membershipId)
    byJob.set(row.jobId, list)
  }
  return byJob
}

/** The scope's members, for the scopes that are a list of people. */
function membersOf(scope: RowScope): Array<Id<'memberships'>> {
  if (scope.kind === 'business') return []
  return scope.kind === 'own' ? [scope.membershipId] : [...scope.membershipIds]
}

/**
 * The jobs someone in this scope is also going on — empty for the whole
 * business, whose scope already takes every job. Read once for a page, then
 * asked of each job with `inScope`.
 */
export async function sharedJobIds(
  ctx: QueryCtx,
  scope: RowScope,
): Promise<ReadonlySet<Id<'jobs'>>> {
  const members = membersOf(scope)
  if (members.length === 0) return new Set()
  const rows = await Promise.all(
    members.map((membershipId) =>
      ctx.db
        .query('jobPeople')
        .withIndex('by_member_date', (q) => q.eq('membershipId', membershipId))
        .order('desc')
        .take(MAX_SHARED_READ),
    ),
  )
  return new Set(rows.flat().map((row) => row.jobId))
}

/** `isInScope` for a job, counting the people also going on it. */
export function inScope(
  scope: RowScope,
  job: { _id: Id<'jobs'>; assignedMembershipId: Id<'memberships'> },
  shared: ReadonlySet<Id<'jobs'>>,
): boolean {
  return isInScope(scope, job) || shared.has(job._id)
}

/** The same question of one job, reading only that job's people. */
export async function jobInScope(
  ctx: QueryCtx,
  scope: RowScope,
  job: { _id: Id<'jobs'>; assignedMembershipId: Id<'memberships'> },
): Promise<boolean> {
  if (isInScope(scope, job)) return true
  const members = membersOf(scope)
  if (members.length === 0) return false
  const people = await alsoGoingOf(ctx, job._id)
  return people.some((id) => members.includes(id))
}

/**
 * The jobs the scope's members are also going on, in a window of
 * `scheduledAt` — what `jobsInScope` adds to their own. Binned jobs, and any
 * of another business (a person's rows are indexed by person, not business),
 * are left out.
 */
export async function sharedJobsInRange(
  ctx: QueryCtx,
  scope: RowScope,
  opts: {
    businessId: Id<'businesses'>
    from?: number
    to?: number
    order: 'asc' | 'desc'
    limit?: number
  },
): Promise<Array<Doc<'jobs'>>> {
  const members = membersOf(scope)
  if (members.length === 0) return []
  const { businessId, from, to, order, limit } = opts
  const unbounded = from === undefined && to === undefined
  const rows = await Promise.all(
    members.map((membershipId) =>
      ctx.db
        .query('jobPeople')
        .withIndex('by_member_date', (r) => {
          const eq = r.eq('membershipId', membershipId)
          if (from !== undefined && to !== undefined)
            return eq.gte('scheduledAt', from).lt('scheduledAt', to)
          if (from !== undefined) return eq.gte('scheduledAt', from)
          if (to !== undefined) return eq.lt('scheduledAt', to)
          return eq
        })
        .order(unbounded ? 'desc' : order)
        .take(Math.min(limit ?? MAX_SHARED_JOBS, MAX_SHARED_JOBS)),
    ),
  )
  const ids = [...new Set(rows.flat().map((row) => row.jobId))]
  const jobs = await Promise.all(ids.map((id) => ctx.db.get(id)))
  return jobs.filter(
    (job): job is Doc<'jobs'> =>
      job !== null && job.businessId === businessId && !isBinned(job),
  )
}

/**
 * Who a report on this job may be read by, beyond its author's scope: anyone
 * in the reader's scope who is on the job — its lead, or also going. The job's
 * reports are the record of a visit they were on, whoever wrote them.
 */
export async function onReportsJob(
  ctx: QueryCtx,
  scope: RowScope,
  report: { jobId?: Id<'jobs'>; businessId: Id<'businesses'> },
): Promise<boolean> {
  if (report.jobId === undefined) return false
  const job = await ctx.db.get(report.jobId)
  if (!job || job.businessId !== report.businessId) return false
  return jobInScope(ctx, scope, job)
}

/**
 * The people also going, as asked for: each once, never the lead, at most
 * MAX_ALSO_GOING. Refuses too many rather than dropping any silently.
 */
export function tidyAlsoGoing(
  lead: Id<'memberships'>,
  ids: ReadonlyArray<Id<'memberships'>>,
): Array<Id<'memberships'>> {
  const tidy = [...new Set(ids)].filter((id) => id !== lead)
  if (tidy.length > MAX_ALSO_GOING) throw new ConvexError('TOO_MANY_PEOPLE')
  return tidy
}

/**
 * Make a job's people also going exactly `ids` (already tidied and checked):
 * rows for the new, none for the gone, the rest left as they were — so who
 * added whom, and when, survives an edit that did not touch them.
 */
export async function setAlsoGoing(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  ids: ReadonlyArray<Id<'memberships'>>,
  addedBy: Id<'memberships'>,
): Promise<{
  added: Array<Id<'memberships'>>
  removed: Array<Id<'memberships'>>
}> {
  const rows = await ctx.db
    .query('jobPeople')
    .withIndex('by_job', (q) => q.eq('jobId', job._id))
    .collect()
  const wanted = new Set(ids)
  const removed: Array<Id<'memberships'>> = []
  for (const row of rows) {
    if (!wanted.has(row.membershipId)) {
      await ctx.db.delete(row._id)
      removed.push(row.membershipId)
    }
  }
  const have = new Set(rows.map((row) => row.membershipId))
  const added = ids.filter((id) => !have.has(id))
  const addedAt = Date.now()
  for (const membershipId of added) {
    await ctx.db.insert('jobPeople', {
      businessId: job.businessId,
      jobId: job._id,
      membershipId,
      scheduledAt: job.scheduledAt,
      addedBy,
      addedAt,
    })
  }
  return { added, removed }
}

/** The rows' copy of the job's date, after the job moved. */
export async function syncAlsoGoingDate(
  ctx: MutationCtx,
  jobId: Id<'jobs'>,
  scheduledAt: number,
): Promise<void> {
  const rows = await ctx.db
    .query('jobPeople')
    .withIndex('by_job', (q) => q.eq('jobId', jobId))
    .collect()
  for (const row of rows) {
    if (row.scheduledAt !== scheduledAt) {
      await ctx.db.patch(row._id, { scheduledAt })
    }
  }
}

/** A job gone for good takes its people rows with it. */
export async function dropAlsoGoing(
  ctx: MutationCtx,
  jobId: Id<'jobs'>,
): Promise<void> {
  const rows = await ctx.db
    .query('jobPeople')
    .withIndex('by_job', (q) => q.eq('jobId', jobId))
    .collect()
  for (const row of rows) await ctx.db.delete(row._id)
}

/**
 * Everyone on a job, its lead first, with the people also going read for a
 * whole window (`alsoGoingInWindow`).
 */
export function everyoneOn(
  job: { _id: Id<'jobs'>; assignedMembershipId: Id<'memberships'> },
  alsoGoing: ReadonlyMap<Id<'jobs'>, ReadonlyArray<Id<'memberships'>>>,
): Array<Id<'memberships'>> {
  return [job.assignedMembershipId, ...(alsoGoing.get(job._id) ?? [])]
}

/**
 * Whether a report may be read: its author's scope (`reportReadable`), or it
 * is on a job the reader is on — as its lead or also going — whoever wrote
 * it. The job's reports are the record of a visit they were on; the Reports
 * library still lists by author. `shared`, when a page already read it,
 * answers the "also going" half without a read per report.
 */
export async function reportReadableHere(
  ctx: QueryCtx,
  scope: RowScope,
  readerId: Id<'memberships'>,
  report: {
    authorMembershipId: Id<'memberships'>
    jobId?: Id<'jobs'>
    businessId: Id<'businesses'>
  },
  shared?: ReadonlySet<Id<'jobs'>>,
): Promise<boolean> {
  if (reportReadable(scope, readerId, report)) return true
  if (report.jobId === undefined) return false
  if (shared?.has(report.jobId)) return true
  return onReportsJob(ctx, scope, report)
}

/**
 * The jobs the scope's members were most recently put on, newest first, with
 * one of these statuses — what the Job tab adds to their own, which it lists
 * newest booked first (by when they were added, which for a job booked with
 * them on it is when it was booked).
 */
export async function sharedJobsNewest(
  ctx: QueryCtx,
  scope: RowScope,
  opts: {
    businessId: Id<'businesses'>
    limit: number
    statuses: ReadonlyArray<Doc<'jobs'>['status']>
  },
): Promise<Array<Doc<'jobs'>>> {
  const members = membersOf(scope)
  if (members.length === 0) return []
  const rows = await Promise.all(
    members.map((membershipId) =>
      ctx.db
        .query('jobPeople')
        .withIndex('by_member', (q) => q.eq('membershipId', membershipId))
        .order('desc')
        .take(Math.min(opts.limit, MAX_SHARED_JOBS)),
    ),
  )
  const ids = [...new Set(rows.flat().map((row) => row.jobId))]
  const wanted = new Set(opts.statuses)
  const jobs = await Promise.all(ids.map((id) => ctx.db.get(id)))
  return jobs.filter(
    (job): job is Doc<'jobs'> =>
      job !== null &&
      job.businessId === opts.businessId &&
      !isBinned(job) &&
      wanted.has(job.status),
  )
}
