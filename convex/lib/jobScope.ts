import { isInScope } from './capabilities'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { RowScope } from './capabilities'

/**
 * Loading the jobs someone may see, from the scope that says which those are.
 *
 * `isInScope` in capabilities.ts answers the question for a row already in
 * hand. This answers it for rows still in the database, which is a different
 * problem: filtering after a full-tenant read is both slower and a leak waiting
 * for someone to forget the filter.
 *
 * No new index. A team is served by one indexed scan per member, run together —
 * exactly the query the 'own' scope already runs, times the size of a team.
 * That is deliberate: `by_assignee_date` is a single-equality index and cannot
 * match a list of ids, and the alternative (read the whole business and filter
 * in memory) is the thing `by_assignee_date` was added to avoid. For a business
 * with a handful of subcontractors per contractor, a handful of indexed scans
 * is the cheaper and more obviously correct answer.
 */
export async function jobsInScope(
  ctx: QueryCtx,
  scope: RowScope,
  opts: {
    businessId: Id<'businesses'>
    /** Inclusive lower bound on `scheduledAt`. */
    from?: number
    /** Exclusive upper bound. */
    to?: number
    order?: 'asc' | 'desc'
    /** Newest or oldest `limit` within the range, by `scheduledAt`. */
    limit?: number
  },
): Promise<Array<Doc<'jobs'>>> {
  const { businessId, from, to, order = 'asc', limit } = opts

  if (scope.kind === 'business') {
    const q = ctx.db
      .query('jobs')
      .withIndex('by_business_date', (b) => {
        const eq = b.eq('businessId', businessId)
        if (from !== undefined && to !== undefined)
          return eq.gte('scheduledAt', from).lt('scheduledAt', to)
        if (from !== undefined) return eq.gte('scheduledAt', from)
        if (to !== undefined) return eq.lt('scheduledAt', to)
        return eq
      })
      .order(order)
    return limit === undefined ? q.collect() : q.take(limit)
  }

  const ids =
    scope.kind === 'own' ? [scope.membershipId] : [...scope.membershipIds]

  const perMember = await Promise.all(
    ids.map((membershipId) => {
      const q = ctx.db
        .query('jobs')
        .withIndex('by_assignee_date', (a) => {
          const eq = a.eq('assignedMembershipId', membershipId)
          if (from !== undefined && to !== undefined)
            return eq.gte('scheduledAt', from).lt('scheduledAt', to)
          if (from !== undefined) return eq.gte('scheduledAt', from)
          if (to !== undefined) return eq.lt('scheduledAt', to)
          return eq
        })
        .order(order)
      // Each member contributes up to `limit`, because the true top `limit`
      // across a team can all come from one person. Trimmed after merging.
      return limit === undefined ? q.collect() : q.take(limit)
    }),
  )

  if (ids.length === 1) return perMember[0] ?? []

  // Each scan comes back ordered; merging several does not, and the business
  // branch above is ordered. Callers rendering a day or a month would otherwise
  // get a different order depending on who is asking.
  const sign = order === 'asc' ? 1 : -1
  const jobs = perMember
    .flat()
    .sort((a, b) => sign * (a.scheduledAt - b.scheduledAt))
  return limit === undefined ? jobs : jobs.slice(0, limit)
}

/**
 * The newest `limit` jobs in scope with one of `statuses`, most recently
 * created first — what the Job tab lists.
 *
 * One indexed scan per status (and, for a team, per member), each already
 * newest-first and bounded, merged by creation time. Status is part of the
 * index rather than a filter after it because of what is newest: a business
 * running a few recurring series has its most recently created rows almost
 * all projected `recurring` visits, inserted in bulk by the nightly cron. Read
 * the newest `limit` and drop those afterwards, and the page comes back mostly
 * — sometimes entirely — empty. Asking only for the statuses wanted never
 * reads them at all.
 */
export async function jobsNewestFirst(
  ctx: QueryCtx,
  scope: RowScope,
  opts: {
    businessId: Id<'businesses'>
    limit: number
    statuses: ReadonlyArray<Doc<'jobs'>['status']>
  },
): Promise<Array<Doc<'jobs'>>> {
  const { businessId, limit, statuses } = opts
  const newestFirst = (rows: Array<Doc<'jobs'>>) =>
    rows.sort((a, b) => b._creationTime - a._creationTime).slice(0, limit)

  if (scope.kind === 'business') {
    const perStatus = await Promise.all(
      statuses.map((status) =>
        ctx.db
          .query('jobs')
          .withIndex('by_business_status', (q) =>
            q.eq('businessId', businessId).eq('status', status),
          )
          .order('desc')
          .take(limit),
      ),
    )
    return newestFirst(perStatus.flat())
  }

  const ids =
    scope.kind === 'own' ? [scope.membershipId] : [...scope.membershipIds]

  const perScan = await Promise.all(
    ids.flatMap((membershipId) =>
      statuses.map((status) =>
        ctx.db
          .query('jobs')
          .withIndex('by_assignee_status', (q) =>
            q.eq('assignedMembershipId', membershipId).eq('status', status),
          )
          .order('desc')
          // The true newest `limit` can all be one person's, in one status.
          .take(limit),
      ),
    ),
  )

  // The index is per assignee, not per business: someone who works for two
  // businesses must not see the other one's jobs in this business's list.
  return newestFirst(
    perScan.flat().filter((job) => job.businessId === businessId),
  )
}

/**
 * The same decision for a job already loaded — a deep link, a note's job, a
 * property's history. Returns null rather than throwing at the call sites that
 * must not distinguish "not yours" from "does not exist": a subcontractor who
 * can tell a colleague's job apart from a missing one has learned something
 * about the colleague's round.
 */
export function visibleJob<
  T extends { assignedMembershipId: Id<'memberships'> },
>(scope: RowScope, job: T | null): T | null {
  if (!job) return null
  return isInScope(scope, job) ? job : null
}

/**
 * The scope, in the two values the frontend already understands.
 *
 * The client is a separate Vercel build that may be hours behind the backend
 * (CLAUDE.md), and it branches on exactly `'business'` and `'assignee'` in two
 * places. Sending a third value would not error anywhere — the chart and the
 * "only your own jobs" notice would simply stop rendering, with nothing in any
 * log. That is the same silent function-signature drift that took prod down
 * once already.
 *
 * So a team reads as `'assignee'` for now: not the whole business, which is the
 * distinction both call sites actually make. The honest third case ships in the
 * same change as the contractor role, when the frontend can be taught it and
 * both builds go out together.
 */
export function wireScope(scope: RowScope): 'business' | 'assignee' {
  return scope.kind === 'business' ? 'business' : 'assignee'
}
