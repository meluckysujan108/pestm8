import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation, internalQuery } from '../_generated/server'
import { freezeTemplate } from '../lib/templateSnapshot'
import type { CustomSource } from '../lib/templateSnapshot'

/**
 * One-off: stamp every report with the template revision it was written
 * against, and give every finalised report its own frozen copy of that
 * template.
 *
 * WHY THIS EXISTS. Until now a built-in report rendered from the live `.ts`
 * module, which was safe only because those four files never changed. The
 * verbatim rewrite changes all of them. Without a snapshot, correcting a typo
 * would silently alter what a document signed last year says — retroactively,
 * invisibly, and on a legal record.
 *
 * ORDERING — the one rule that matters. This backfill reads the built-ins by
 * importing them, so it captures whatever is in the working tree when it runs.
 * It MUST be deployed and run, on every deployment, BEFORE the rewritten
 * templates merge. Run it after and it writes the new prose into old reports'
 * snapshots, wearing the authority of a snapshot, with no way to tell
 * afterwards. Verify zero-missing on dev AND prod before that branch lands.
 *
 * Expand → migrate → contract, as `notesV2.ts` sets out — with one difference
 * worth stating plainly, so nobody copies a ritual they do not need:
 *
 * 1. EXPAND — a plain `npx convex deploy`. NO hand-loosening of
 *    convex/schema.ts and NO `--typecheck disable`. Every addition this phase
 *    makes is either a new table (`reportTemplateSnapshots`), a new index
 *    (`reportPhotos.by_storage`) or an optional field (`templateSnapshotId`,
 *    `templateVersion`), so no existing row can fail validation. That is what
 *    made notesV2 need the loosening; this does not.
 *
 * 2. MIGRATE — each batch schedules the next, so each finishes on its own:
 *
 *      npx convex run migrations/reportSnapshotsV1:backfillTemplateVersion '{"cursor":null}'
 *      npx convex run migrations/reportSnapshotsV1:backfillSnapshots '{"cursor":null}'
 *
 *    (`backfillTemplateVersion` has since been removed: the contract release
 *    made `templateVersion` required, so the schema itself now guarantees it.)
 *
 *    then again with `--prod`. Confirm `--prod` resolves to the intended
 *    deployment before running it: `.env.local` points at dev.
 *
 * 3. VERIFY — `npx convex run migrations/reportSnapshotsV1:invariant` must
 *    report `finalisedWithoutSnapshot: 0` on both deployments (it also
 *    reported `reportsWithoutVersion: 0` until the schema made that certain). `snapshotRows` in the tens means the hash is
 *    canonicalising; in the hundreds it is not.
 *
 * 4. CONTRACT — done by the contract release (docs/reports/migrations.md):
 *    `templateVersion` is `v.number()`, and `customTemplateSnapshot` was
 *    cleared by `migrations/reportsContract` and dropped. `templateSnapshotId`
 *    stays optional forever: Convex cannot express "required only when
 *    finalised". `photoIds` is left alone — read by nothing, and removing it
 *    is a full-table rewrite for no gain.
 *
 * Re-running any step is safe: each skips rows it has already converted.
 *
 * Run on: dev (acoustic-schnauzer-237) — 2026-09-12. Prod
 * (rare-retriever-156) — 2026-09-16, with the verbatim rewrite: 30 reports,
 * 12 finalised, both counts zero afterwards, 5 snapshot rows.
 */

// Smaller: each row additionally does an indexed lookup and possibly an
// insert.
const SNAPSHOT_PAGE = 100

export const backfillSnapshots = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('reports')
      .paginate({ numItems: SNAPSHOT_PAGE, cursor })

    for (const report of page.page) {
      // Drafts resolve live by design — nothing is binding yet, so picking up
      // a template edit is correct. Only signed documents get frozen.
      if (report.status !== 'finalised') continue
      if (report.templateSnapshotId !== undefined) continue

      const templateSnapshotId = await freezeTemplate(ctx, report, {
        // The inline copy, not a fresh read of the live doc: that doc may have
        // moved on since this report was signed, and the inline copy is
        // exactly what the report has been rendering from all along.
        custom: report.customTemplateSnapshot as CustomSource | undefined,
      })
      if (templateSnapshotId) {
        await ctx.db.patch(report._id, { templateSnapshotId })
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.reportSnapshotsV1.backfillSnapshots,
        { cursor: page.continueCursor },
      )
    }
  },
})

/**
 * The gate on the rewrite: run it, read two zeros, then merge.
 *
 * A single full scan. There is no index on `status`, so counting
 * finalised-without-a-snapshot reads every row either way, and Convex allows
 * only one paginated query per function — so paginating the scan is not
 * available here.
 *
 * That is acceptable precisely because of how it fails. If this ever outgrows
 * Convex's read limit it THROWS, loudly, and whoever is running the migration
 * sees it and splits the count. A gate that errors is safe; one that quietly
 * under-reports would say "zero missing" about a table it only half read, and
 * that answer is the permission to ship the rewrite. Measured sub-second at
 * 1571 reports / ~760 KB.
 *
 * Internal, so this is never a public query collecting an unbounded table.
 */
export const invariant = internalQuery({
  args: {},
  handler: async (ctx) => {
    const reports = await ctx.db.query('reports').collect()
    // Bounded by construction: deduplication means this table holds one row
    // per distinct template revision, not one per report.
    const snapshots = await ctx.db.query('reportTemplateSnapshots').collect()

    return {
      reports: reports.length,
      finalised: reports.filter((r) => r.status === 'finalised').length,
      finalisedWithoutSnapshot: reports.filter(
        (r) => r.status === 'finalised' && r.templateSnapshotId === undefined,
      ).length,
      snapshotRows: snapshots.length,
      snapshotsByTemplate: snapshots.reduce<Record<string, number>>(
        (acc, row) => {
          acc[row.template] = (acc[row.template] ?? 0) + 1
          return acc
        },
        {},
      ),
    }
  },
})
