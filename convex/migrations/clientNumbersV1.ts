import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation } from '../_generated/server'
import { assignClientNumber } from '../lib/clientRecord'

/**
 * One-off: a number for every client made before clients had one.
 *
 * Expand only — `clientNumber` is optional, so the deploy that adds it needs
 * no loosening, and nothing is contracted afterwards. Each client gets one
 * more than the highest its business has used, oldest client first.
 *
 * Run it AFTER importing a client list that carries its own numbers, so the
 * imported clients keep theirs and the older PestM8 clients follow on from
 * the highest. (Run before, the older clients take 1, 2, 3… and an imported
 * client whose number is taken gets the next free one instead.)
 *
 *   npx convex export --prod --path before-client-numbers.zip
 *   npx convex run migrations/clientNumbersV1:backfillAll '{"cursor":null}' --prod
 *
 * Each batch schedules the next. Re-running is safe: a client that has a
 * number is left alone.
 */

const PAGE = 100

export const backfillAll = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('businesses')
      .paginate({ numItems: PAGE, cursor })
    for (const business of page.page) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.clientNumbersV1.backfillBusiness,
        { businessId: business._id, cursor: null },
      )
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.clientNumbersV1.backfillAll,
        { cursor: page.continueCursor },
      )
    }
  },
})

export const backfillBusiness = internalMutation({
  args: {
    businessId: v.id('businesses'),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { businessId, cursor }) => {
    // Oldest first: `by_business` ends in `_creationTime`.
    const page = await ctx.db
      .query('clients')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .paginate({ numItems: PAGE, cursor })
    for (const client of page.page) {
      if (client.clientNumber !== undefined) continue
      await ctx.db.patch(client._id, {
        clientNumber: await assignClientNumber(ctx, businessId),
      })
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.clientNumbersV1.backfillBusiness,
        { businessId, cursor: page.continueCursor },
      )
    }
  },
})
