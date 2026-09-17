import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { internal } from '../_generated/api'
import { refreshSearchText } from '../reports'

/**
 * Reports gain an order and a way to be found.
 *
 * The library now pages through `by_business_updated` and matches a search
 * index over `searchText`, and every row written before this has neither.
 * Absent values are not harmless here: on the index `undefined` sorts below
 * every number, so an unbackfilled report would sit at the bottom of a
 * descending list forever, and an unbackfilled `searchText` simply cannot be
 * found.
 *
 * RUNBOOK
 *
 * 1. EXPAND — shipped with this file. Both columns are optional and every
 *    writer stamps them, so new and edited reports need nothing.
 *
 * 2. SNAPSHOT — `npx convex export --prod --path <file>.zip` before running
 *    against production (CLAUDE.md). This pass writes to every report row.
 *
 * 3. MIGRATE — `npx convex run migrations/reportsLibrary:backfill '{"cursor":null}'`,
 *    then again with `--prod`. Confirm `--prod` resolves to
 *    `rare-retriever-156` first: `.env.local` points at dev.
 *
 * 4. VERIFY — `npx convex run migrations/reportsLibrary:invariant` must report
 *    `withoutUpdatedAt: 0` and `withoutSearchText: 0` on both.
 *
 * `updatedAt` is backfilled to `finalisedAt ?? createdAt`, which is the
 * closest true thing available: nothing recorded when a draft was last edited,
 * and inventing "now" would shuffle a business's whole history to the top of
 * its own list on the day this ran.
 */

const PAGE = 100

export const backfill = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('reports').paginate({ numItems: PAGE, cursor })

    let stamped = 0
    let described = 0
    for (const report of page.page) {
      if (report.updatedAt === undefined) {
        await ctx.db.patch(report._id, {
          updatedAt: report.finalisedAt ?? report.createdAt,
        })
        stamped += 1
      }
      if (report.searchText === undefined) {
        // Reads the property, the client and the template the same way the
        // list does, so a backfilled row is findable by exactly what a new
        // one is findable by.
        await refreshSearchText(ctx, report._id)
        described += 1
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.reportsLibrary.backfill, {
        cursor: page.continueCursor,
      })
    }

    return { scanned: page.page.length, stamped, described, done: page.isDone }
  },
})

export const invariant = internalQuery({
  args: {},
  handler: async (ctx) => {
    const reports = await ctx.db.query('reports').collect()
    return {
      reports: reports.length,
      withoutUpdatedAt: reports.filter((r) => r.updatedAt === undefined).length,
      withoutSearchText: reports.filter((r) => r.searchText === undefined).length,
      inTrash: reports.filter((r) => r.deletedAt !== undefined).length,
    }
  },
})
