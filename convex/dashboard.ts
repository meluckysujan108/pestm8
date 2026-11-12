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
import { countsFromOf, earnedOnWaivedJobs, moneyFigures } from './lib/payments'
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
    // The day's own end, not start + 24h: the Schedule ends a day the same
    // way, so on a daylight-saving Sunday the two cannot disagree about
    // which jobs are today's.
    const dayEnd = endOfDayInZone(todayKey, business.timezone)
    // Bounded both ends: a job can be marked invoiced ahead of its visit, and
    // without an end it would count toward this month and every month until
    // the one it is booked in.
    const month = monthBoundsInZone(todayKey, business.timezone)

    // The same rule the calendar reads by (`jobsInRange` in jobs.ts): neither
    // a cancellation nor a projected visit is work on the books. Every number
    // below is a job total shown to an owner, so a fortnightly series must not
    // make "12 upcoming" out of one booking and a standing arrangement.
    const live = all.filter(
      (j) => j.status !== 'cancelled' && j.status !== 'recurring',
    )

    // Read from what was actually paid, for the screens that say To bill,
    // Owing and Paid this month. The older figures beside them stay until no
    // app in the field reads them.
    const money = await moneyFigures(
      ctx,
      env.caps,
      businessId,
      all,
      month,
      env.actor.acting._id,
      countsFromOf(business),
    )
    const waived = await earnedOnWaivedJobs(ctx, businessId)

    return {
      todayCount: live.filter(
        (j) => j.scheduledAt >= dayStart && j.scheduledAt < dayEnd,
      ).length,
      upcomingCount: live.filter(
        (j) => j.scheduledAt >= dayEnd && NOT_STARTED_STATUSES.has(j.status),
      ).length,
      // Work done, money not yet billed: the number the owner is meant to act
      // on. (It was the amber state on every card until Phase 4.3 made
      // Completed green; Analytics links from this figure to those jobs.)
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
              // Paid as well, or taking the money for a job would make the
              // month's billing shrink.
              (j.status === 'invoiced' || j.status === 'paid') &&
              j.scheduledAt >= month.start &&
              j.scheduledAt < month.end,
          )
          .reduce((sum, j) => sum + (waived.get(j._id) ?? j.price), 0),
      ),
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
