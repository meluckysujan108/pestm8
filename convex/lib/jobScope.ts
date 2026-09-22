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
 * The newest `limit` jobs in scope, most recently created first.
 *
 * Same shape as `jobsInScope` and the same reasoning about indexes — one
 * indexed scan per member of a team rather than a whole-tenant read — but
 * ordered by creation rather than by `scheduledAt`, which is what the Job tab
 * lists by. Bounded on purpose: a business's jobs grow fastest of anything in
 * the app, since every recurring series projects six months of them.
 */
export async function jobsNewestFirst(
  ctx: QueryCtx,
  scope: RowScope,
  opts: { businessId: Id<'businesses'>; limit: number },
): Promise<Array<Doc<'jobs'>>> {
  const { businessId, limit } = opts

  if (scope.kind === 'business') {
    return ctx.db
      .query('jobs')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .take(limit)
  }

  const ids =
    scope.kind === 'own' ? [scope.membershipId] : [...scope.membershipIds]

  const perMember = await Promise.all(
    ids.map((membershipId) =>
      ctx.db
        .query('jobs')
        .withIndex('by_assignee', (q) =>
          q.eq('assignedMembershipId', membershipId),
        )
        .order('desc')
        // The true newest `limit` across a team can all belong to one person.
        .take(limit),
    ),
  )

  if (ids.length === 1) return (perMember[0] ?? []).slice(0, limit)

  // The index is per assignee, not per business: someone who works for two
  // businesses must not see the other one's jobs in this business's list.
  return perMember
    .flat()
    .filter((job) => job.businessId === businessId)
    .sort((a, b) => b._creationTime - a._creationTime)
    .slice(0, limit)
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
