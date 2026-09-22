import { v } from 'convex/values'
import { query } from './_generated/server'
import { startOfDayInZone, todayKeyInZone } from './lib/dates'
import { requireActor } from './lib/actor'
import { jobsInScope, wireScope } from './lib/jobScope'
import { NOT_STARTED_STATUSES } from './lib/jobStatus'
import { hidePrices, redactTotal } from './lib/prices'

/**
 * Dashboard metrics, scoped the same way the schedule is: a subcontractor
 * without canViewAllJobs sees their own numbers, not the whole business's.
 */
export const summary = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return null

    const all = await jobsInScope(ctx, env.listScope, { businessId })

    const todayKey = todayKeyInZone(business.timezone)
    const dayStart = startOfDayInZone(todayKey, business.timezone)
    const dayEnd = dayStart + 24 * 60 * 60 * 1000
    const monthStart = startOfDayInZone(
      `${todayKey.slice(0, 7)}-01`,
      business.timezone,
    )
    // Bounded both ends: a job can be marked invoiced ahead of its visit, and
    // without an end it would count toward this month and every month until
    // the one it is booked in.
    const [year, month] = todayKey.slice(0, 7).split('-').map(Number)
    const nextMonthStart = startOfDayInZone(
      month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`,
      business.timezone,
    )

    const live = all.filter((j) => j.status !== 'cancelled')

    return {
      todayCount: live.filter(
        (j) => j.scheduledAt >= dayStart && j.scheduledAt < dayEnd,
      ).length,
      upcomingCount: live.filter(
        (j) => j.scheduledAt >= dayEnd && NOT_STARTED_STATUSES.has(j.status),
      ).length,
      // The amber state: work done, money not yet billed. This is the number
      // the owner is meant to act on.
      /**
       * The count travels with the value, and that is not tidiness.
       *
       * "4 jobs awaiting invoice" beside a hidden total says little; the same
       * pair when the count is 1 says the price exactly. Redacting only the
       * money leaves the arithmetic sitting right next to it.
       */
      awaitingInvoice: redactTotal(
        env.caps,
        live.filter((j) => j.status === 'completed').length,
      ),
      awaitingInvoiceValue: redactTotal(
        env.caps,
        live
          .filter((j) => j.status === 'completed')
          .reduce((sum, j) => sum + j.price, 0),
      ),
      invoicedThisMonth: redactTotal(
        env.caps,
        live
          .filter(
            (j) =>
              j.status === 'invoiced' &&
              j.scheduledAt >= monthStart &&
              j.scheduledAt < nextMonthStart,
          )
          .reduce((sum, j) => sum + j.price, 0),
      ),
      pricesHidden: hidePrices(env.caps),
      scope: wireScope(env.listScope),
    }
  },
})
