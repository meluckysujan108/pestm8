import { v } from 'convex/values'
import { query } from './_generated/server'
import {
  endOfDayInZone,
  monthBoundsInZone,
  startOfDayInZone,
  todayKeyInZone,
} from './lib/dates'
import { requireActor } from './lib/actor'
import { jobsInScope, wireScope } from './lib/jobScope'
import { NOT_STARTED_STATUSES } from './lib/jobStatus'
import { countsFromOf, moneyFigures } from './lib/payments'
import { hidePrices } from './lib/prices'

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
    // The day's own end, not start + 24h: the Schedule ends a day the same
    // way, so on a daylight-saving Sunday the two cannot disagree about
    // which jobs are today's.
    const dayEnd = endOfDayInZone(todayKey, business.timezone)
    // This month in the business's zone, bounded both ends: what Paid this
    // month adds up.
    const month = monthBoundsInZone(todayKey, business.timezone)

    // The same rule the calendar reads by (`jobsInRange` in jobs.ts): neither
    // a cancellation nor a projected visit is work on the books. Every number
    // below is a job total shown to an owner, so a fortnightly series must not
    // make "12 upcoming" out of one booking and a standing arrangement.
    const live = all.filter(
      (j) => j.status !== 'cancelled' && j.status !== 'recurring',
    )

    // Read from what was actually paid: To bill, Owing and Paid this month.
    /**
     * The count travels with the value, and that is not tidiness.
     *
     * "4 jobs to bill" beside a hidden total says little; the same pair when
     * the count is 1 says the price exactly. So `moneyFigures` redacts each
     * count with its value, never the money alone.
     */
    const money = await moneyFigures(
      ctx,
      env.caps,
      businessId,
      all,
      month,
      env.actor.acting._id,
      countsFromOf(business),
    )

    return {
      todayCount: live.filter(
        (j) => j.scheduledAt >= dayStart && j.scheduledAt < dayEnd,
      ).length,
      upcomingCount: live.filter(
        (j) => j.scheduledAt >= dayEnd && NOT_STARTED_STATUSES.has(j.status),
      ).length,
      toBill: money.toBill,
      toBillValue: money.toBillValue,
      owing: money.owing,
      owingValue: money.owingValue,
      paidThisMonth: money.paidThisMonth,
      pricesHidden: hidePrices(env.caps),
      scope: wireScope(env.listScope),
    }
  },
})
