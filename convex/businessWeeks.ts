import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'
import { dayKeyOf, startOfWeekKey } from './lib/dates'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

/**
 * Each business's week: its time zone, and the Monday of the week it is in
 * now, for a query that answers only for this week. `jobs.openWork` answers
 * for that Monday alone, and sends someone else's work only within its
 * twenty weeks, in the business's own days (the owner's answer to C5, 1 Nov
 * 2026: twenty weeks, as the phone holds, and never more).
 *
 * A query never reads the clock (convex/_generated/ai/guidelines.md: it is
 * kept as of whenever it last ran), and `openWork` never reads the
 * business's row, which every booking, visit and numbered report patches.
 * So the week is kept in a row of its own: written when the business is
 * made or its zone changes, and moved on by the cron every fifteen minutes,
 * only when the Monday changes. What reads it runs again once a week. Every
 * zone in use is a whole quarter-hour from UTC, so a business's week turns
 * at most two minutes before its row does.
 */

const PAGE = 100

/** Writes the business's week as of `now`, if it isn't already that. */
export async function keepWeek(
  ctx: MutationCtx,
  business: Pick<Doc<'businesses'>, '_id' | 'timezone'>,
  now: number,
): Promise<void> {
  const { _id: businessId, timezone } = business
  const monday = startOfWeekKey(dayKeyOf(now, timezone))
  const row = await ctx.db
    .query('businessWeeks')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .unique()
  if (row === null) {
    await ctx.db.insert('businessWeeks', { businessId, timezone, monday })
  } else if (row.monday !== monday || row.timezone !== timezone) {
    await ctx.db.patch('businessWeeks', row._id, { timezone, monday })
  }
}

/**
 * Every business's week, a page at a time, the next page in a run of its
 * own. Also makes the row of any business that has none.
 */
export const advance = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const now = Date.now()
    const page = await ctx.db
      .query('businesses')
      .paginate({ numItems: PAGE, cursor: cursor ?? null })
    for (const business of page.page) await keepWeek(ctx, business, now)
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.businessWeeks.advance, {
        cursor: page.continueCursor,
      })
    }
  },
})
