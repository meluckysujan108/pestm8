import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation } from '../_generated/server'
import { insertJobNote } from '../notes'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * One-off: a job's plain note (`jobs.notes`, 29 Sept 2026) becomes a note in
 * Notes on that job, as every job note is now — on the job, on the client,
 * in Notes → Jobs and found by search. Then the plain field is cleared.
 *
 * EXPAND → MIGRATE → CONTRACT:
 *   1. Deploy the backend that reads both (the job card falls back to
 *      `jobs.notes` until this runs) and the frontend that no longer writes
 *      the plain field.
 *   2. Snapshot, then run this once:
 *        CONVEX_DEPLOYMENT=prod:rare-retriever-156 \
 *          npx convex run migrations/jobNotesToNotesV1:backfillAll '{"cursor":null}'
 *      Each page schedules the next. Re-running is safe: a job with no plain
 *      note is skipped.
 *   3. Check none is left, on the same deployment:
 *        CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run --inline-query \
 *          'return (await ctx.db.query("jobs").collect()).filter(j => j.notes !== undefined).length'
 *      An app from before job notes were Notes can still write one through
 *      `jobs.update` until the contract step; run this again just before it.
 *   4. Contract, in two steps. First (30 Sept 2026) a backend that neither
 *      reads nor writes the field: `jobs.update` still takes `notes` from an
 *      older app, and keeps it as a note in Notes instead
 *      (`notes.insertJobNoteOnce`). Count again (3) once that backend is
 *      live, not before — an older app could write one until the moment it
 *      is — and if any is left, run this again (2). Done on production
 *      30 Sept 2026 (PR #101): 0 of 1049 jobs after it went live. Then,
 *      still to do: drop `jobs.notes` from the schema, and this file, once
 *      every deployment counts none. Until then a deployment holding one (a
 *      test backend) runs this to clear it.
 *
 * The note is the owner's: who typed a plain note was never recorded, and
 * the owner may edit or delete any note.
 */

const PAGE = 100

async function ownerOf(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<Id<'memberships'> | null> {
  const members = await ctx.db
    .query('memberships')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .collect()
  return members.find((m) => m.role === 'owner')?._id ?? null
}

export const backfillAll = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('jobs').paginate({ numItems: PAGE, cursor })
    const owners = new Map<Id<'businesses'>, Id<'memberships'> | null>()
    for (const job of page.page) {
      if (job.notes === undefined) continue
      if (!owners.has(job.businessId)) {
        owners.set(job.businessId, await ownerOf(ctx, job.businessId))
      }
      const author = owners.get(job.businessId) ?? job.assignedMembershipId
      const noteId = await insertJobNote(ctx, {
        job,
        authorMembershipId: author,
        text: job.notes,
      })
      // A job in the Recycle bin keeps its note there with it: restored
      // together, or wiped together (bin.ts), never left live on its own.
      if (job.deletedAt !== undefined) {
        await ctx.db.patch(noteId, {
          deletedAt: job.deletedAt,
          ...(job.binEntryId !== undefined && { binEntryId: job.binEntryId }),
        })
      }
      await ctx.db.patch(job._id, { notes: undefined })
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.jobNotesToNotesV1.backfillAll,
        { cursor: page.continueCursor },
      )
    }
  },
})
