import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { internal } from '../_generated/api'
import { freezeTemplate } from '../lib/templateSnapshot'
import type { CustomSource } from '../lib/templateSnapshot'

/**
 * The contract step the reports rebuild deferred: `customTemplateSnapshot`.
 *
 * A finalised custom report used to carry its template's wording twice —
 * inline, in `customTemplateSnapshot`, and by reference, in
 * `templateSnapshotId`. Every reader now takes the reference, and finalise
 * no longer writes the inline copy (it refuses to lock a custom report it
 * cannot freeze instead). What is left is the column itself, which the
 * schema cannot drop while any row still holds it.
 *
 * RUNBOOK
 *
 * 1. DEPLOY — shipped with this file. Nothing reads or writes the column;
 *    the schema still declares it, so existing rows validate.
 *
 * 2. SNAPSHOT — `npx convex export --prod --include-file-storage --path <file>.zip`
 *    before running against production (CLAUDE.md).
 *
 * 3. MIGRATE — `npx convex run migrations/reportsContract:clearCustomSnapshots '{"cursor":null}'`,
 *    then again with `--prod`. Confirm `--prod` resolves to
 *    `rare-retriever-156` first: `.env.local` points at dev.
 *
 * 4. VERIFY — `npx convex run migrations/reportsContract:invariant` must report
 *    `withCustomSnapshot: 0` and `finalisedCustomWithoutSnapshot: 0`.
 *
 * The column stays declared (see its schema comment): dropping it would
 * refuse the push to any deployment still holding an old row, for no gain.
 * Run this on a deployment whenever its invariant is not zero.
 *
 * A row whose inline copy is its ONLY copy — finalised, custom, with no
 * `templateSnapshotId` — is frozen from that inline copy first and cleared
 * only once the reference exists. None existed on prod or dev when this was
 * written; the branch is here so the migration can never be the thing that
 * loses a signed document's wording.
 */

const PAGE = 100

export const clearCustomSnapshots = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('reports')
      .paginate({ numItems: PAGE, cursor })

    let cleared = 0
    let frozen = 0
    let kept = 0
    for (const report of page.page) {
      if (report.customTemplateSnapshot === undefined) continue

      if (report.templateSnapshotId === undefined) {
        const templateSnapshotId = await freezeTemplate(ctx, report, {
          custom: report.customTemplateSnapshot as CustomSource,
        })
        if (templateSnapshotId === undefined) {
          // Its only copy of the wording, and it could not be frozen: keep it.
          // The invariant counts it, so the release does not report done.
          kept += 1
          continue
        }
        await ctx.db.patch(report._id, { templateSnapshotId })
        frozen += 1
      }

      await ctx.db.patch(report._id, { customTemplateSnapshot: undefined })
      cleared += 1
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.reportsContract.clearCustomSnapshots,
        { cursor: page.continueCursor },
      )
    }

    return {
      scanned: page.page.length,
      cleared,
      frozen,
      kept,
      done: page.isDone,
    }
  },
})

export const invariant = internalQuery({
  args: {},
  handler: async (ctx) => {
    const reports = await ctx.db.query('reports').collect()
    return {
      reports: reports.length,
      withCustomSnapshot: reports.filter(
        (r) => r.customTemplateSnapshot !== undefined,
      ).length,
      finalisedCustomWithoutSnapshot: reports.filter(
        (r) =>
          r.template === 'custom' &&
          r.status === 'finalised' &&
          r.templateSnapshotId === undefined,
      ).length,
    }
  },
})
