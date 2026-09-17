import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation } from '../_generated/server'
import { authComponent } from '../auth'
import { grantsFromMembership } from '../lib/membershipFacts'

/**
 * One-off: make the access model the stored truth rather than a derivation.
 *
 * Every membership row predates `grants`, so `grantsFromMembership` reads the
 * legacy `canViewAllJobs` column and fills in the rest — deliberately, so that
 * nobody's access changed on the day the model deployed. That fallback is what
 * this removes the need for. It writes exactly what the fallback already
 * computes, so no one's access changes here either: the answer stops being
 * derived, and starts being a row you can look at.
 *
 * That matters for the contract step more than for today. The legacy columns
 * cannot be dropped while anything still reads them, and `grantsFromMembership`
 * is the last reader. Until every row carries its own `grants`, dropping
 * `canViewAllJobs` would silently mean "nobody can see anyone else's
 * schedule".
 *
 * `displayName` is frozen at the same time, for a different reason: attribution
 * reads it rather than the live Better Auth user, so that leaving the business
 * and renaming your login cannot rewrite your name on reports you signed and
 * audit rows you caused.
 *
 * SAFETY, and it is the property that makes this re-runnable: every write is
 * conditional on the field being absent. A row an owner has since changed
 * through Settings → Team is skipped, so this can never undo a decision
 * somebody made in the new UI — including if it is run twice, or run again
 * months later.
 *
 * Expand → migrate → contract (CLAUDE.md). The expand step has already shipped:
 * every column this writes is optional in the schema, so a row without them is
 * valid before and after.
 *
 *   npx convex run migrations/accessV3:backfillMemberships '{"cursor":null}' --prod
 *
 * Verify with:
 *
 *   npx convex run --prod --inline-query \
 *     'return (await ctx.db.query("memberships").collect()).filter(m => !m.grants).length'
 *
 * which must be 0. Each batch schedules the next, so one command finishes the
 * job. CONTRACT — dropping the legacy columns — is a separate, later deploy,
 * gated on no old client still calling the functions that read them.
 */

const PAGE = 50

export const backfillMemberships = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('memberships')
      .paginate({ numItems: PAGE, cursor })

    let written = 0
    for (const member of page.page) {
      const patch: {
        grants?: ReturnType<typeof grantsFromMembership>
        displayName?: string
      } = {}

      // Only where absent. A row the owner has already set through the UI is
      // somebody's decision, and this is not entitled to revisit it.
      if (member.grants === undefined) {
        patch.grants = grantsFromMembership(member)
      }
      if (member.displayName === undefined) {
        const user = await authComponent.getAnyUserById(ctx, member.userId)
        // Only when there is a real name to freeze. Writing an empty string
        // would make "no snapshot yet" indistinguishable from "their name is
        // blank", and `displayNameOf` would stop falling back to the user.
        const name = user?.name.trim()
        if (name) patch.displayName = name
      }

      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(member._id, patch)
        written += 1
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.accessV3.backfillMemberships,
        { cursor: page.continueCursor },
      )
    }

    return { scanned: page.page.length, written, done: page.isDone }
  },
})
