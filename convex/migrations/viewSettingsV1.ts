import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation, internalQuery } from '../_generated/server'
import { grantsFromMembership } from '../lib/membershipFacts'
import type { Doc } from '../_generated/dataModel'

/**
 * Retiring the old view settings on `memberships`:
 *
 * - `canViewAllJobs`, the "Can view all jobs" switch, which "Other people's
 *   jobs" (`grants.otherSchedules` / `editOthers`) replaced in #182;
 * - `canViewOtherAccounts` and `viewingAsMembershipId`, the read-only "view
 *   as" whose menu went with the header account button.
 *
 * Expand → migrate → contract:
 *
 * 1. EXPAND (the release that adds this file): the three are optional, no
 *    longer read (bar `canViewAllJobs` as the fallback for a row with no
 *    `grants`), and written only to clear them.
 * 2. MIGRATE (this file): every row gets a `grants` of its own, from that
 *    same fallback, so what anyone may see does not change; and loses the
 *    three columns. Prod had `grants` on all 17 rows on 2026-11-24, 4 rows
 *    holding `canViewOtherAccounts: true` and none a `viewingAsMembershipId`.
 * 3. CONTRACT (a later release): drop the three from schema.ts, with
 *    `grantsFromMembership`'s fallback, `setCanViewAllJobs`,
 *    `setCanViewOtherAccounts` and `setViewingAs`. A deploy of that schema
 *    is refused while any row still holds one of the three, so a row missed
 *    here cannot slip through.
 *
 * EVERY COMMAND NAMES ITS DEPLOYMENT (see jobStatusV1.ts). For production,
 * once step 1 is deployed there:
 *
 *   0. SNAPSHOT: npx convex export --prod --path <file>.zip
 *   1. CHECK:    CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/viewSettingsV1:remaining '{}'
 *   2. PREVIEW:  CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/viewSettingsV1:run '{"dryRun":true}'
 *   3. RUN:      CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/viewSettingsV1:run '{}'
 *   4. VERIFY:   step 1 again reports `due: 0`.
 *
 * Both read a page of memberships at a time; `remaining` says where the next
 * page starts (`continueCursor`) when there is more than one, and `run`
 * schedules its own next page. A second run changes nothing.
 *
 * ROLLING THE BACKEND BACK past step 1 needs `restoreForRollback` first: the
 * older schema requires `canViewAllJobs` on every row, and step 1 stops
 * writing it on a new row, as step 2 clears it from the old ones. Run it
 * immediately before the rollback deploy: any membership written in between
 * (an invitation accepted, a grant changed) comes out without the column
 * again, and that deploy is refused until it is run once more. It cannot
 * bring back `canViewOtherAccounts`, which nothing on the older backend
 * reads without a `viewingAsMembershipId`; the step 0 snapshot holds it.
 */

const PAGE = 200

/** A row holding any of the three, or with no `grants` of its own. */
function isDue(m: Doc<'memberships'>): boolean {
  return (
    m.grants === undefined ||
    m.canViewAllJobs !== undefined ||
    m.canViewOtherAccounts !== undefined ||
    m.viewingAsMembershipId !== undefined
  )
}

const cursorArg = v.optional(v.union(v.string(), v.null()))

export const remaining = internalQuery({
  args: { cursor: cursorArg },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('memberships')
      .paginate({ numItems: 1000, cursor: cursor ?? null })
    const due = page.page.filter(isDue)
    return {
      due: due.length,
      withoutGrants: due.filter((m) => m.grants === undefined).length,
      viewOtherAccountsOn: due.filter((m) => m.canViewOtherAccounts === true)
        .length,
      viewingAsSet: due.filter((m) => m.viewingAsMembershipId !== undefined)
        .length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    }
  },
})

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: cursorArg },
  handler: async (ctx, { dryRun = false, cursor }) => {
    const page = await ctx.db
      .query('memberships')
      .paginate({ numItems: PAGE, cursor: cursor ?? null })

    let changed = 0
    let grantsWritten = 0
    for (const m of page.page) {
      if (!isDue(m)) continue
      changed += 1
      if (m.grants === undefined) grantsWritten += 1
      if (dryRun) continue
      await ctx.db.patch(m._id, {
        // What is in effect now, made its own: the fallback, from the old
        // column, for a row that never had one. A row with `grants` keeps
        // them exactly as they are.
        ...(m.grants === undefined ? { grants: grantsFromMembership(m) } : {}),
        canViewAllJobs: undefined,
        canViewOtherAccounts: undefined,
        viewingAsMembershipId: undefined,
      })
    }

    // A dry run looks at the first page only.
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.viewSettingsV1.run, {
        cursor: page.continueCursor,
      })
    }
    return { dryRun, changed, grantsWritten, isDone: page.isDone }
  },
})

/**
 * Before rolling the backend back past step 1 only: puts `canViewAllJobs`
 * back on every row without it, from `grants`, which the older schema
 * requires and the older code reads only where `grants` is absent.
 */
export const restoreForRollback = internalMutation({
  args: { cursor: cursorArg },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('memberships')
      .paginate({ numItems: PAGE, cursor: cursor ?? null })

    let restored = 0
    for (const m of page.page) {
      if (m.canViewAllJobs !== undefined) continue
      await ctx.db.patch(m._id, {
        canViewAllJobs: grantsFromMembership(m).otherSchedules,
      })
      restored += 1
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.viewSettingsV1.restoreForRollback,
        { cursor: page.continueCursor },
      )
    }
    return { restored, isDone: page.isDone }
  },
})
