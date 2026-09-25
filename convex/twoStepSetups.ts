import { v } from 'convex/values'
import { components } from './_generated/api'
import { internalMutation, internalQuery } from './_generated/server'
import { twoFactorSetupState } from './lib/twoFactorSetup'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { TwoFactorSetupState } from './lib/twoFactorSetup'

/**
 * Who started each account's two-step set-up (the `twoStepSetups` table in
 * schema.ts; convex/lib/twoFactorSetup.ts has the why). Internal: the auth
 * hooks in convex/auth.ts write the claim, and check it both before and
 * after `/two-factor/get-totp-uri` reads a key; `auth.twoFactorStatus` reads
 * it through `setupStateFor`.
 */

const setupState = v.union(
  v.literal('none'),
  v.literal('unfinished'),
  v.literal('elsewhere'),
  v.literal('stale'),
  v.literal('on'),
)

/**
 * This session made this row. Replaces any earlier claim: the account has
 * one key at a time, so it has one claim at a time.
 */
export const claim = internalMutation({
  args: { userId: v.string(), sessionId: v.string(), twoFactorId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await claimOf(ctx, args.userId)
    if (existing) await ctx.db.replace(existing._id, args)
    else await ctx.db.insert('twoStepSetups', args)
    return null
  },
})

/**
 * The set-up state as `auth.twoFactorStatus` would answer it to this
 * session — for the auth endpoints, which have the session but not a query
 * context of their own. The account's flag is read here, not taken from the
 * caller, so the two can never disagree.
 */
export const stateFor = internalQuery({
  args: { userId: v.string(), sessionId: v.string() },
  returns: setupState,
  handler: async (ctx, { userId, sessionId }) =>
    (await readSetup(ctx, userId, await flagOf(ctx, userId), sessionId)).state,
})

/**
 * Whether `twoFactorId` is the account's key right now AND this session may
 * carry on with it — `unfinished`, and that row — asked in one transaction.
 *
 * For the check after `/two-factor/get-totp-uri` has read a key
 * (`onlyItsOwnKey` in convex/auth.ts). The check before it (`stateFor`) is a
 * transaction of its own, and so is the endpoint's read of the row: the row
 * can change between the two, and "you may carry on" said of one row is no
 * licence to hand out another. So once the key is read, the row it came
 * from is named here and asked about by id. A claim naming this session and
 * this row was only ever written by this session's own enable, after it made
 * the row (`claimNewKey`); a row's key never changes under its id. So a yes
 * here means the key read is the one this session made, however the reads
 * interleaved.
 */
export const holdsKey = internalQuery({
  args: { userId: v.string(), sessionId: v.string(), twoFactorId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { userId, sessionId, twoFactorId }) => {
    const { state, rowId } = await readSetup(
      ctx,
      userId,
      await flagOf(ctx, userId),
      sessionId,
    )
    return state === 'unfinished' && rowId === twoFactorId
  },
})

/**
 * The account's set-up state, for `sessionId` (null: nobody's session, so
 * nothing is theirs to carry on with). On is `on` without reading the row.
 */
export async function setupStateFor(
  ctx: QueryCtx,
  userId: string,
  enabled: boolean,
  sessionId: string | null,
): Promise<TwoFactorSetupState> {
  return (await readSetup(ctx, userId, enabled, sessionId)).state
}

/**
 * The state, and the id of the row it was worked out from (null when none
 * was read).
 *
 * The row is read the way the plugin reads it (findOne by userId), so if a
 * race ever left two, this reports on the one verify-totp and get-totp-uri
 * would both use; and only its id and `verified` — `select` keeps the
 * encrypted secret and recovery codes from even reaching this function.
 */
async function readSetup(
  ctx: QueryCtx,
  userId: string,
  enabled: boolean,
  sessionId: string | null,
): Promise<{ state: TwoFactorSetupState; rowId: string | null }> {
  if (enabled) return { state: 'on', rowId: null }
  const row: { _id: string; verified?: boolean | null } | null =
    await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'twoFactor',
      where: [{ field: 'userId', value: userId }],
      select: ['_id', 'verified'],
    })
  if (row === null) return { state: 'none', rowId: null }
  const claimed = await claimOf(ctx, userId)
  const state = twoFactorSetupState(
    false,
    { id: row._id, verified: row.verified },
    claimed && {
      sessionId: claimed.sessionId,
      twoFactorId: claimed.twoFactorId,
    },
    sessionId,
  )
  return { state, rowId: row._id }
}

async function flagOf(ctx: QueryCtx, userId: string): Promise<boolean> {
  const user: { twoFactorEnabled?: boolean | null } | null = await ctx.runQuery(
    components.betterAuth.adapter.findOne,
    {
      model: 'user',
      where: [{ field: '_id', value: userId }],
      select: ['twoFactorEnabled'],
    },
  )
  return user?.twoFactorEnabled === true
}

function claimOf(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query('twoStepSetups')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .unique()
}
