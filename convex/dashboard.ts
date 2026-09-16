import { v } from 'convex/values'
import { query } from './_generated/server'
import { startOfDayInZone, todayKeyInZone } from './lib/dates'
import { requireActor } from './lib/actor'
import { jobsInScope, wireScope } from './lib/jobScope'

/**
 * Dashboard metrics, scoped the same way the schedule is: a subcontractor
 * without canViewAllJobs sees their own numbers, not the whole business's.
 */
export const summary = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const { scope } = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return null

    const all = await jobsInScope(ctx, scope, { businessId })

    const todayKey = todayKeyInZone(business.timezone)
    const dayStart = startOfDayInZone(todayKey, business.timezone)
    const dayEnd = dayStart + 24 * 60 * 60 * 1000
    const monthStart = startOfDayInZone(
      `${todayKey.slice(0, 7)}-01`,
      business.timezone,
    )

    const live = all.filter((j) => j.status !== 'cancelled')

    return {
      todayCount: live.filter(
        (j) => j.scheduledAt >= dayStart && j.scheduledAt < dayEnd,
      ).length,
      upcomingCount: live.filter(
        (j) => j.scheduledAt >= dayEnd && j.status === 'booked',
      ).length,
      // The amber state: work done, money not yet billed. This is the number
      // the owner is meant to act on.
      awaitingInvoice: live.filter((j) => j.status === 'completed').length,
      awaitingInvoiceValue: live
        .filter((j) => j.status === 'completed')
        .reduce((sum, j) => sum + j.price, 0),
      invoicedThisMonth: live
        .filter((j) => j.status === 'invoiced' && j.scheduledAt >= monthStart)
        .reduce((sum, j) => sum + j.price, 0),
      scope: wireScope(scope),
    }
  },
})
