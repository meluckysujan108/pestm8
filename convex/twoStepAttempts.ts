import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import type { MutationCtx } from './_generated/server'

/**
 * The per-account cap on two-step codes (the `twoStepAttempts` table in
 * schema.ts has the why). Internal: only the auth hooks in convex/auth.ts
 * call these, from the HTTP action that serves `/api/auth/*`.
 *
 * Ten, then fifteen minutes: Better Auth's own lockout defaults, which this
 * stands in for. Ten wrong codes in a row is well past a thumb slipping on a
 * phone in the sun, and at ten per quarter-hour a six-digit code (three live
 * at once, the ±30 s window) would take an attacker years on average.
 */
export const MAX_TWO_STEP_ATTEMPTS = 10
export const TWO_STEP_LOCK_MS = 15 * 60_000

/**
 * Counts one code check against the account BEFORE it runs, and refuses it
 * while the account is locked. Counting first rather than after a failure is
 * the point: a script sends its guesses in parallel, and "check the count,
 * verify, then add one" would let every guess in flight pass the check before
 * any of them was recorded. This mutation is the one serialised step.
 *
 * The attempt that reaches the limit still runs — it is the tenth, not the
 * eleventh — and locks the account for whatever comes after it; if it was
 * right, `recordSuccess` clears the lock straight away.
 */
export const beginAttempt = internalMutation({
  args: { userId: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), retryAfterMs: v.number() }),
  ),
  handler: async (ctx, { userId }) => {
    const now = Date.now()
    const row = await attemptsFor(ctx, userId)

    if (row?.lockedUntil !== undefined && row.lockedUntil > now) {
      return { ok: false as const, retryAfterMs: row.lockedUntil - now }
    }

    // An expired lock starts the count again, rather than locking again on
    // the very next wrong code.
    const attempts =
      (row?.lockedUntil !== undefined ? 0 : (row?.attempts ?? 0)) + 1
    const lockedUntil =
      attempts >= MAX_TWO_STEP_ATTEMPTS ? now + TWO_STEP_LOCK_MS : undefined

    if (row) await ctx.db.patch(row._id, { attempts, lockedUntil })
    else
      await ctx.db.insert('twoStepAttempts', { userId, attempts, lockedUntil })
    return { ok: true as const }
  },
})

/** A right code: the count starts again from nothing. */
export const recordSuccess = internalMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    await clearTwoStepAttempts(ctx, userId)
    return null
  },
})

/**
 * Also used by the owner's two-step reset (team.ts), so a person set up again
 * does not start their first sign-in under someone else's lock.
 */
export async function clearTwoStepAttempts(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  const row = await attemptsFor(ctx, userId)
  if (row) await ctx.db.delete(row._id)
}

function attemptsFor(ctx: MutationCtx, userId: string) {
  return ctx.db
    .query('twoStepAttempts')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .unique()
}
