import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation, internalQuery } from '../_generated/server'
import type { Doc } from '../_generated/dataModel'
import type { Interval } from '../lib/recurrence'

/**
 * One-off: the fixed `recurrences.frequency` enum → a custom
 * `intervalCount`/`intervalUnit` pair (Phase 3, Recurring Jobs).
 *
 * The four names it could take — monthly, quarterly, sixMonthly, yearly —
 * were the only intervals a Recurring Job could be sold on. A fortnightly
 * rodent program, a one-week follow-up and a 15-year termite warranty
 * inspection are all real contracts and none of them could be booked. The
 * replacement stores the number and the unit, so any combination works.
 *
 * NOTHING BREAKS IF THIS HAS NOT RUN. `intervalOf` (convex/lib/recurrence.ts)
 * maps the old four onto the new shape on read, so a deployment on this code
 * with un-migrated rows behaves correctly — it just keeps a dead column. That
 * is what makes the contract step safe to leave until the backfill is
 * verified, rather than racing it.
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
 * `recurrences.create` and `convertJobToRecurring` both changed their
 * argument shape, so an older frontend's "make recurring" fails argument
 * validation against this backend.
 *
 * 0. SNAPSHOT — this rewrites every recurrence row:
 *
 *      npx convex export --path recurrences-before-intervals.zip
 *
 *    And read what is there first:
 *
 *      npx convex run migrations/recurringIntervalV1:invariant
 *
 * 1. EXPAND — deploy this commit's schema as it stands. `frequency`,
 *    `intervalCount` and `intervalUnit` are all optional, so both the old
 *    rows and the new writes validate:
 *
 *      npx convex deploy
 *
 * 2. MIGRATE — one command. Each batch schedules the next, so it finishes on
 *    its own; safe to re-run, since rows already carrying an interval are
 *    skipped:
 *
 *      npx convex run migrations/recurringIntervalV1:backfill '{"cursor":null}'
 *
 * 3. VERIFY — `invariant` must report `withoutInterval: 0` AND
 *    `withFrequency: 0`. The second matters as much as the first: the
 *    contract step drops the column, and Convex refuses a schema any existing
 *    row fails, so a row still holding `frequency` would block the deploy.
 *
 *      npx convex run migrations/recurringIntervalV1:invariant
 *
 * 4. CONTRACT — in a LATER commit, once both are 0: drop `frequency` from the
 *    `recurrences` table in convex/schema.ts, delete the `frequency`
 *    validator and `LEGACY_FREQUENCY`/the fallback branch in `intervalOf`,
 *    make `intervalCount`/`intervalUnit` required, and deploy again. Left as
 *    a separate commit on purpose — the expand state is correct indefinitely,
 *    and a contract that ships alongside the backfill has no way to roll back
 *    if the backfill turns out to have missed rows.
 */

type LegacyRecurrence = Doc<'recurrences'> & {
  frequency?: 'monthly' | 'quarterly' | 'sixMonthly' | 'yearly'
}

const INTERVAL_BY_FREQUENCY: Record<string, Interval> = {
  monthly: { count: 1, unit: 'month' },
  quarterly: { count: 3, unit: 'month' },
  sixMonthly: { count: 6, unit: 'month' },
  yearly: { count: 1, unit: 'year' },
}

const PAGE = 100

export const backfill = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('recurrences')
      .paginate({ numItems: PAGE, cursor })

    let converted = 0
    let unknown = 0

    for (const row of page.page) {
      const recurrence = row as LegacyRecurrence
      const alreadyDone =
        recurrence.intervalUnit !== undefined &&
        recurrence.frequency === undefined
      if (alreadyDone) continue

      const interval =
        recurrence.intervalUnit !== undefined
          ? // Interval already written by an earlier pass or by a normal
            // write; only the dead column is left to clear.
            null
          : (recurrence.frequency &&
              INTERVAL_BY_FREQUENCY[recurrence.frequency]) ||
            undefined

      if (interval === undefined) {
        // A row with neither an interval nor a frequency the map knows. Left
        // exactly as it is rather than guessed at: `intervalOf` reads it as
        // monthly either way, and a row silently rewritten to monthly would
        // hide the fact that something wrote a shape nothing expected. It
        // will show up in `invariant` as `withoutInterval`.
        unknown++
        continue
      }

      await ctx.db.patch(recurrence._id, {
        ...(interval
          ? { intervalCount: interval.count, intervalUnit: interval.unit }
          : {}),
        // Cleared, not just superseded. The contract step drops this column,
        // and Convex refuses a schema that any existing row fails — a row
        // still holding `frequency` would block that deploy indefinitely.
        frequency: undefined,
      })
      converted++
    }

    // Each batch schedules the next, so one command finishes the table. The
    // cursor has to be carried forward: re-running from `null` by hand would
    // read the same first page every time and never reach row 101.
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.recurringIntervalV1.backfill,
        { cursor: page.continueCursor },
      )
    }

    return { done: page.isDone, converted, unknown }
  },
})

/** Both numbers must be 0 before the contract deploy. See step 3. */
export const invariant = internalQuery({
  args: {},
  handler: async (ctx) => {
    let total = 0
    let withoutInterval = 0
    let withFrequency = 0

    for await (const row of ctx.db.query('recurrences')) {
      const recurrence = row as LegacyRecurrence
      total++
      if (recurrence.intervalUnit === undefined) withoutInterval++
      if (recurrence.frequency !== undefined) withFrequency++
    }

    return { total, withoutInterval, withFrequency }
  },
})
