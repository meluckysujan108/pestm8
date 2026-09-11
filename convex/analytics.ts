import { v } from 'convex/values'
import { query } from './_generated/server'
import { authComponent } from './auth'
import { jobVisibility, resolveViewScope } from './lib/access'
import { dayKeyOf, startOfDayInZone, todayKeyInZone } from './lib/dates'
import { jobsInRange } from './jobs'
import type { Id } from './_generated/dataModel'

/** Shifts a `"YYYY-MM"` key by `offset` months (either direction). */
function monthKeyOffset(monthKey: string, offset: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  const total = year * 12 + (month - 1) + offset
  const y = Math.floor(total / 12)
  const m = (total % 12) + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

/**
 * Historical trend data for the Analytics page — a distinct concern from
 * `dashboard.summary`'s "today's operational snapshot", so it lives in its
 * own file rather than growing that one. One query, not several: everything
 * below is a single pass over one scoped `jobsInRange` read, matching the
 * "collect once, aggregate in memory" approach `dashboard.summary` and
 * `jobs.monthTeamLoad` already use at this app's scale.
 */
export const overview = query({
  args: { businessId: v.id('businesses'), months: v.optional(v.number()) },
  handler: async (ctx, { businessId, months = 6 }) => {
    const membership = await resolveViewScope(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return null

    const currentMonthKey = todayKeyInZone(business.timezone).slice(0, 7)
    const startMonthKey = monthKeyOffset(currentMonthKey, -(months - 1))
    const afterEndMonthKey = monthKeyOffset(currentMonthKey, 1)
    const from = startOfDayInZone(`${startMonthKey}-01`, business.timezone)
    const to = startOfDayInZone(`${afterEndMonthKey}-01`, business.timezone)
    const monthKeys = Array.from({ length: months }, (_, i) =>
      monthKeyOffset(startMonthKey, i),
    )

    // `jobsInRange` already excludes cancelled jobs, so a true cancellation
    // rate would need a second, unfiltered scan — not worth it for a first
    // cut. `statusBreakdown` below can therefore only ever show
    // booked/inProgress/completed/invoiced.
    const jobs = await jobsInRange(ctx, membership, from, to)

    const revenueByMonth = new Map(monthKeys.map((k) => [k, 0]))
    const volumeByMonth = new Map(monthKeys.map((k) => [k, 0]))
    const statusCounts = new Map<string, number>()
    const typeCounts = new Map<string, number>()
    const technicianCounts = new Map<Id<'memberships'>, number>()

    for (const job of jobs) {
      const monthKey = dayKeyOf(job.scheduledAt, business.timezone).slice(0, 7)
      volumeByMonth.set(monthKey, (volumeByMonth.get(monthKey) ?? 0) + 1)
      // Only earned money — a booked job hasn't happened yet, matching
      // `dashboard.summary`'s own awaitingInvoiceValue/invoicedThisMonth
      // semantics rather than inventing a third revenue definition.
      if (job.status === 'completed' || job.status === 'invoiced') {
        revenueByMonth.set(
          monthKey,
          (revenueByMonth.get(monthKey) ?? 0) + job.price,
        )
      }
      statusCounts.set(job.status, (statusCounts.get(job.status) ?? 0) + 1)
      typeCounts.set(job.jobType, (typeCounts.get(job.jobType) ?? 0) + 1)
      technicianCounts.set(
        job.assignedMembershipId,
        (technicianCounts.get(job.assignedMembershipId) ?? 0) + 1,
      )
    }

    // `jobType` is free text (§ schema), so a business's accumulated
    // vocabulary is unbounded — cap the chart to what Miller's Law allows
    // regardless of how many distinct strings a business has typed over time.
    const sortedTypes = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])
    const topTypes = sortedTypes.slice(0, 5)
    const otherTypeCount = sortedTypes
      .slice(5)
      .reduce((sum, [, c]) => sum + c, 0)

    const technicianLoad = await Promise.all(
      [...technicianCounts.entries()].map(async ([membershipId, count]) => {
        const assignee = await ctx.db.get(membershipId)
        const user = assignee
          ? await authComponent.getAnyUserById(ctx, assignee.userId)
          : null
        return {
          membershipId,
          name: user?.name ?? 'Unassigned',
          colour: assignee?.colour ?? '#8E8E93',
          count,
        }
      }),
    )
    technicianLoad.sort((a, b) => b.count - a.count)

    return {
      // Drives which charts render client-side — an assignee-scoped
      // subcontractor's technicianLoad always degenerates to one row
      // (themselves), so that chart is skipped entirely rather than shown
      // as a meaningless single bar.
      scope: jobVisibility(membership).scope,
      months: monthKeys,
      revenueByMonth: monthKeys.map((k) => ({
        month: k,
        value: revenueByMonth.get(k) ?? 0,
      })),
      volumeByMonth: monthKeys.map((k) => ({
        month: k,
        value: volumeByMonth.get(k) ?? 0,
      })),
      statusBreakdown: [...statusCounts.entries()].map(([status, count]) => ({
        status,
        count,
      })),
      typeBreakdown: [
        ...topTypes.map(([jobType, count]) => ({ jobType, count })),
        ...(otherTypeCount > 0
          ? [{ jobType: 'Other', count: otherTypeCount }]
          : []),
      ],
      technicianLoad,
    }
  },
})
