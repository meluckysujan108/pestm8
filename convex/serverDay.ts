import { internalMutation } from './_generated/server'

/**
 * The server's day, in UTC, for a query that answers only near today:
 * `jobs.openWork` answers for this week and last (`openWorkWeeks` in
 * lib/siteWork.ts). A query never reads the clock, since it would be kept
 * as of whenever it last ran (convex/_generated/ai/guidelines.md), so the
 * hourly cron writes the day into one row instead, and only when it has
 * changed: what reads it runs again once a day.
 *
 * With no row yet (a new deployment, before the cron's first run),
 * `openWork` answers for any Monday, as it did before the row existed.
 */
export const advance = internalMutation({
  args: {},
  handler: async (ctx) => {
    const utcDay = new Date(Date.now()).toISOString().slice(0, 10)
    const row = await ctx.db.query('serverDay').first()
    if (row === null) {
      await ctx.db.insert('serverDay', { utcDay })
    } else if (row.utcDay !== utcDay) {
      await ctx.db.patch('serverDay', row._id, { utcDay })
    }
    return { utcDay }
  },
})
