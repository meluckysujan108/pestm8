import { ConvexError, v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { startOfDayInZone, todayKeyInZone } from '../lib/dates'
import { isDayKey } from '../lib/siteWork'

/**
 * One-off, with Release 3 of job payments: give every business that has none
 * a day its Payments page counts from (`businesses.paymentsFrom`).
 *
 * Before payments could be recorded, nothing ever marked a job Paid, so every
 * job done since a business began is still Completed or Invoiced. Counted, it
 * would all read as money to bill or chase: Pest M8 Pest Control alone had
 * 101 Completed jobs ($28,620) and 16 Invoiced ($9,090) when this shipped.
 * So the page counts from the day payments arrived, and says how many older
 * jobs it leaves out; the owner can count them by moving the day back.
 *
 * The day is the start of today in each business's own zone, or `day` if one
 * is given. Nothing about any job changes. A business that already has a day
 * keeps it, so a second run changes nothing.
 *
 * EVERY COMMAND NAMES ITS DEPLOYMENT (see jobStatusV1.ts). For production,
 * after the backend with `paymentsFrom` is deployed there, on the same day:
 *
 *   1. CHECK:   CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/paymentsFromV1:remaining
 *   2. PREVIEW: CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/paymentsFromV1:run '{"dryRun":true}'
 *   3. RUN:     CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/paymentsFromV1:run '{}'
 *   4. VERIFY:  step 1 again reports none.
 *
 * Nothing to contract: the field stays optional, and absent counts every job,
 * which is right for a business made since. Until step 3 runs, a business's
 * page counts everything, so run it straight after the deploy.
 */

/** Far more businesses than there are; one read takes them all. */
const MAX_BUSINESSES = 1000

export const remaining = internalQuery({
  args: {},
  handler: async (ctx) => {
    const businesses = await ctx.db.query('businesses').take(MAX_BUSINESSES)
    return businesses
      .filter((business) => business.paymentsFrom === undefined)
      .map((business) => ({ businessId: business._id, name: business.name }))
  },
})

export const run = internalMutation({
  args: {
    /** "YYYY-MM-DD" in each business's zone. Today if absent. */
    day: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { day, dryRun = false }) => {
    if (day !== undefined && !isDayKey(day)) {
      throw new ConvexError('INVALID_DAY')
    }
    const businesses = await ctx.db.query('businesses').take(MAX_BUSINESSES)
    const changes = []
    for (const business of businesses) {
      if (business.paymentsFrom !== undefined) continue
      const from = day ?? todayKeyInZone(business.timezone)
      const paymentsFrom = startOfDayInZone(from, business.timezone)
      changes.push({
        businessId: business._id,
        name: business.name,
        day: from,
        paymentsFrom,
      })
      if (!dryRun) await ctx.db.patch(business._id, { paymentsFrom })
    }
    return { dryRun, changes }
  },
})
