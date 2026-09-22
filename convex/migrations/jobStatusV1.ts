import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation, internalQuery } from '../_generated/server'
import type { Doc } from '../_generated/dataModel'

/**
 * One-off: retire the `inProgress` job status (2026-09-22, the Phase 1 status
 * rules). Every job still holding it becomes `booked` — work was confirmed and
 * begun but not finished, which is the nearest status that remains. Its
 * `startedAt` stays, so a report started from it still prints the real start.
 *
 * convex/schema.ts no longer admits `inProgress`, and Convex refuses to deploy
 * a schema that an existing row fails.
 *
 * EVERY COMMAND NAMES ITS DEPLOYMENT. `npx convex deploy` always lands on a
 * project's production deployment, while a bare `npx convex run` goes to
 * whatever `.env.local` names — so a runbook mixing the two migrates one
 * deployment and deploys another. For production (CLAUDE.md), prefix every
 * command below with `CONVEX_DEPLOYMENT=prod:rare-retriever-156` and confirm
 * each deploy's URL with `--dry-run` first. For a dev deployment, prefix with
 * its own `CONVEX_DEPLOYMENT=dev:<name>` and push with `npx convex dev --once`
 * wherever this says `npx convex deploy`.
 *
 * Before any of it: Vercel's newest successful build must include this
 * commit's frontend (CLAUDE.md, "Ship the frontend and backend together").
 *
 * 0. CHECK — read-only:
 *
 *      npx convex run --inline-query 'return (await ctx.db.query("jobs").filter((q) => q.eq(q.field("status"), "inProgress")).collect()).length'
 *
 *    0 → a plain `npx convex deploy`; nothing below is needed. Otherwise
 *    expand → migrate → contract, as `notesV2.ts` sets out:
 *
 * 1. EXPAND — temporarily add `v.literal('inProgress')` back to `jobStatus`
 *    in convex/schema.ts (NOT to `settableJobStatus`, so nobody can choose it
 *    in the meantime), then `npx convex deploy --typecheck disable`.
 *
 * 2. MIGRATE — each batch schedules the next, so it finishes on its own:
 *
 *      npx convex run migrations/jobStatusV1:retireInProgress '{"cursor":null}'
 *
 * 3. VERIFY — `npx convex run migrations/jobStatusV1:remaining` reports 0.
 *
 * 4. CONTRACT — revert the loosening (git checkout convex/schema.ts), then
 *    `npx convex deploy`. Re-running step 2 is safe: it skips rows already
 *    moved.
 */

type LegacyJob = Omit<Doc<'jobs'>, 'status'> & {
  status: Doc<'jobs'>['status'] | 'inProgress'
}

const PAGE = 100

export const retireInProgress = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('jobs').paginate({ numItems: PAGE, cursor })

    for (const row of page.page) {
      const job = row as LegacyJob
      if (job.status !== 'inProgress') continue
      await ctx.db.patch(job._id, { status: 'booked' })
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.jobStatusV1.retireInProgress,
        { cursor: page.continueCursor },
      )
    }
  },
})

/** How many jobs still hold `inProgress`. Must be 0 before the contract deploy. */
export const remaining = internalQuery({
  args: {},
  handler: async (ctx) => {
    let count = 0
    for await (const row of ctx.db.query('jobs')) {
      if ((row as LegacyJob).status === 'inProgress') count++
    }
    return count
  },
})
