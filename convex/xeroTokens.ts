import { ConvexError, v } from 'convex/values'
import {
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server'
import { internal } from './_generated/api'
import {
  accessAad,
  decryptToken,
  encryptToken,
  refreshAad,
} from './lib/xeroCrypto'
import { XeroError, refreshTokens, revokeRefreshToken } from './lib/xeroHttp'
import { isLiveXero } from './lib/xeroHooks'
import type { ActionCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import type { XeroTokenSet } from './lib/xeroHttp'

/**
 * Xero access tokens, kept usable: one place that hands an action a working
 * access token for a grant, refreshing it when it has lapsed.
 *
 * Xero's refresh token ROTATES on every use, so two refreshes of one grant at
 * once would leave one of them storing a token Xero has already replaced. A
 * refresh therefore happens only under a lease on the grant row
 * (`claimRefresh`, shaped like reports.claimPdf): one holder at a time, 60 s,
 * and a lease whose time has passed may be taken by the next caller — an
 * action that died mid-refresh must not lock the grant for good. Everyone
 * else waits briefly and reads what the holder stored.
 *
 * Tokens are opened and sealed here, in actions only (lib/xeroCrypto.ts); the
 * mutations move ciphertexts. Nothing here puts a token or a ciphertext in a
 * scheduler argument or a log line — the scheduler gets a grant id.
 *
 * Errors reach callers as codes:
 * - XERO_RECONNECT: the grant is dead or gone; the person has to connect
 *   again. Every connection on it already says so (`markGrantDead`).
 * - XERO_BUSY: someone else's refresh is still out after three looks.
 * - XERO_RETRY: Xero did not answer, or answered with something a later try
 *   may not get. Nothing was lost.
 */

/** How long a refresh may hold the grant. Far longer than one token call
 * (20 s at most, lib/xeroHttp.ts), far shorter than anyone's patience. */
const LEASE_MS = 60_000
/** An access token with less left than this is refreshed before use, so it
 * cannot lapse halfway through what it was fetched for. */
const FRESH_MARGIN_MS = 5 * 60_000
/** Waiting on someone else's refresh: this long between looks, this many
 * looks. */
const BUSY_WAIT_MS = 2000
const BUSY_LOOKS = 3
/** A refresh token unused for 60 days dies at Xero. Anything idle for half
 * that is refreshed by the nightly keep-alive. */
const IDLE_MS = 30 * 24 * 60 * 60_000
const KEEP_ALIVE_BATCH = 50
/** Apart, so a night's batch is not 50 token calls in the same second. */
const KEEP_ALIVE_GAP_MS = 2000

type GrantForUse = Pick<
  Doc<'xeroGrants'>,
  'status' | 'xeroUserId' | 'accessCipher' | 'accessExpiresAt'
>

type RefreshClaim =
  | { claimed: true; refreshCipher: string; xeroUserId: string }
  | { claimed: false; reason: 'busy' | 'dead' | 'gone' }

/** What an action needs to use a grant's access token, or to know it can't.
 * Never the refresh token: that leaves the row only under the lease. */
export const grantForUse = internalQuery({
  args: { grantId: v.id('xeroGrants') },
  handler: async (ctx, { grantId }): Promise<GrantForUse | null> => {
    const grant = await ctx.db.get('xeroGrants', grantId)
    if (!grant) return null
    return {
      status: grant.status,
      xeroUserId: grant.xeroUserId,
      accessCipher: grant.accessCipher,
      accessExpiresAt: grant.accessExpiresAt,
    }
  },
})

/**
 * Take the job of refreshing this grant, or say why not.
 *
 * Hands back the refresh token's ciphertext with the lease, read in the same
 * transaction that took it: the holder refreshes the token the row holds at
 * that moment, never one an earlier read saw before somebody else rotated it.
 */
export const claimRefresh = internalMutation({
  args: { grantId: v.id('xeroGrants'), holder: v.string() },
  handler: async (ctx, { grantId, holder }): Promise<RefreshClaim> => {
    const grant = await ctx.db.get('xeroGrants', grantId)
    if (!grant) return { claimed: false, reason: 'gone' }
    if (grant.status === 'dead') return { claimed: false, reason: 'dead' }

    const now = Date.now()
    // A lease past its time belongs to an action that died or hung: taking
    // it is safe, because Xero keeps a replaced refresh token usable for 30
    // minutes, so even a holder that did reach Xero has not stranded us.
    if (grant.refreshLease && grant.refreshLease.until > now) {
      return { claimed: false, reason: 'busy' }
    }
    await ctx.db.patch('xeroGrants', grantId, {
      refreshLease: { holder, until: now + LEASE_MS },
    })
    return {
      claimed: true,
      refreshCipher: grant.refreshCipher,
      xeroUserId: grant.xeroUserId,
    }
  },
})

/**
 * Keeps a refreshed token set, only if this holder still has the lease.
 *
 * Anyone else holding it — or nobody, because a new consent replaced the
 * whole set meanwhile (convex/xero.ts `storeCallback` clears the lease) —
 * means the row already has something newer than this answer, and writing
 * over it would put back a token Xero has replaced.
 */
export const storeRefreshed = internalMutation({
  args: {
    grantId: v.id('xeroGrants'),
    holder: v.string(),
    accessCipher: v.string(),
    accessExpiresAt: v.number(),
    refreshCipher: v.string(),
    scopes: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ stored: boolean }> => {
    const grant = await ctx.db.get('xeroGrants', args.grantId)
    if (
      !grant ||
      grant.status !== 'active' ||
      grant.refreshLease?.holder !== args.holder
    ) {
      return { stored: false }
    }
    await ctx.db.patch('xeroGrants', args.grantId, {
      accessCipher: args.accessCipher,
      accessExpiresAt: args.accessExpiresAt,
      refreshCipher: args.refreshCipher,
      // Xero names the scopes on every refresh; an answer that did not is
      // no reason to forget what was granted.
      scopes: args.scopes.length > 0 ? args.scopes : grant.scopes,
      refreshedAt: Date.now(),
      refreshLease: undefined,
    })
    return { stored: true }
  },
})

/** Gives the lease back early after a refresh that failed, so the next
 * caller tries straight away instead of waiting out the minute. */
export const releaseRefresh = internalMutation({
  args: { grantId: v.id('xeroGrants'), holder: v.string() },
  handler: async (ctx, { grantId, holder }) => {
    const grant = await ctx.db.get('xeroGrants', grantId)
    if (grant?.refreshLease?.holder !== holder) return
    await ctx.db.patch('xeroGrants', grantId, { refreshLease: undefined })
  },
})

/**
 * Xero refused this grant's refresh token: it is dead, and so is every
 * connection that used it until the person connects again. Connections
 * already disconnected, or already waiting on a reconnect, are left as they
 * are.
 *
 * `holder`, when given, is the refresh that found it dead, and the grant is
 * only marked if that refresh still holds the lease. A new consent that
 * landed while the refresh was out replaced the very token Xero refused
 * (`storeCallback` clears the lease), and that new set is good: marking it
 * dead would send someone who has just connected straight back to Connect.
 */
export const markGrantDead = internalMutation({
  args: { grantId: v.id('xeroGrants'), holder: v.optional(v.string()) },
  handler: async (ctx, { grantId, holder }): Promise<{ marked: boolean }> => {
    const grant = await ctx.db.get('xeroGrants', grantId)
    if (!grant) return { marked: false }
    if (holder !== undefined && grant.refreshLease?.holder !== holder) {
      return { marked: false }
    }

    const now = Date.now()
    if (grant.status !== 'dead') {
      await ctx.db.patch('xeroGrants', grantId, {
        status: 'dead',
        deadAt: now,
        refreshLease: undefined,
      })
    }
    // One Xero user's connections: a handful of organisations, each in the
    // businesses they were connected to.
    for await (const connection of ctx.db
      .query('xeroConnections')
      .withIndex('by_grant', (q) => q.eq('grantId', grantId))) {
      if (
        connection.status !== 'connected' &&
        connection.status !== 'pending'
      ) {
        continue
      }
      await ctx.db.patch('xeroConnections', connection._id, {
        status: 'needs_reconnect',
        problem: { code: 'reconnect', at: now },
      })
    }
    return { marked: true }
  },
})

/**
 * The nightly keep-alive (convex/crons.ts). A refresh token unused for 60
 * days dies at Xero, and a business that sends nothing to Xero for two months
 * — no client edits over a quiet winter, say — would otherwise find every
 * connection needing a reconnect. Refreshing anything idle for 30 days keeps
 * them all well inside that.
 *
 * Only a sign-in some live connection still uses is kept alive. One nothing
 * uses — a release at Xero that gave up, or died between its two calls; a
 * reconnect that moved its connection onto another Xero login — is retired
 * instead (`refreshGrant`): revoked at Xero and forgotten. Refreshing it would
 * keep PestM8 able to reach that person's organisations for good, after they
 * disconnected or left.
 *
 * Fifty a night, oldest first, two seconds apart; a grant not reached tonight
 * is reached tomorrow, a month before it would die. Returns how many it
 * scheduled.
 */
export const keepAlive = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const idle = await ctx.db
      .query('xeroGrants')
      .withIndex('by_status_and_refreshedAt', (q) =>
        q.eq('status', 'active').lt('refreshedAt', Date.now() - IDLE_MS),
      )
      .take(KEEP_ALIVE_BATCH)
    for (const [i, grant] of idle.entries()) {
      await ctx.scheduler.runAfter(
        i * KEEP_ALIVE_GAP_MS,
        internal.xeroTokens.refreshGrant,
        { grantId: grant._id },
      )
    }
    return idle.length
  },
})

/** How many live connections, in any business, use this grant. */
export const liveOnGrant = internalQuery({
  args: { grantId: v.id('xeroGrants') },
  handler: async (ctx, { grantId }): Promise<number> => {
    let count = 0
    for await (const row of ctx.db
      .query('xeroConnections')
      .withIndex('by_grant', (q) => q.eq('grantId', grantId))) {
      if (isLiveXero(row)) count += 1
    }
    return count
  },
})

/**
 * One keep-alive refresh — or, for a sign-in no live connection uses, its
 * retirement (`retireGrant`). A failure is logged, not thrown: a dead grant
 * is already marked (and its connections say so), and anything else is tried
 * again tomorrow night with a month to spare.
 */
export const refreshGrant = internalAction({
  args: { grantId: v.id('xeroGrants') },
  handler: async (ctx, { grantId }) => {
    try {
      const inUse: number = await ctx.runQuery(
        internal.xeroTokens.liveOnGrant,
        { grantId },
      )
      if (inUse === 0) {
        // Busy (tried again tomorrow) or unrevoked (forgotten all the same,
        // so its refresh token lapses at Xero) is worth a line in the log.
        const retired = await retireGrant(ctx, grantId)
        if (retired === 'busy' || retired === 'unrevoked') {
          console.warn(`[xero] retiring unused grant ${grantId}: ${retired}`)
        }
        return null
      }
      await accessTokenFor(ctx, grantId, { forceRefresh: true })
    } catch (error) {
      const code =
        error instanceof ConvexError && typeof error.data === 'string'
          ? error.data
          : error instanceof Error
            ? error.name
            : 'failed'
      console.error(`[xero] keep-alive for grant ${grantId}: ${code}`)
    }
    return null
  },
})

/**
 * A working access token for this grant, for an action about to call Xero.
 * Not a Convex function: every Xero-calling action awaits it directly.
 *
 * 1. A token with more than five minutes left is opened and returned.
 * 2. Otherwise this call takes the refresh lease, refreshes, stores both new
 *    tokens and returns the new access token.
 * 3. If someone else holds the lease, it looks again every 2 s, three times,
 *    for the token they store; then XERO_BUSY.
 *
 * `forceRefresh` (the keep-alive) refreshes even a fresh token, and while
 * waiting on someone else accepts only a token newer than the one it found.
 */
export async function accessTokenFor(
  ctx: ActionCtx,
  grantId: Id<'xeroGrants'>,
  opts: { forceRefresh?: boolean } = {},
): Promise<string> {
  const first = await usableGrant(ctx, grantId)
  if (!opts.forceRefresh && isFresh(first)) return await openAccess(first)

  const holder = crypto.randomUUID()
  for (let looks = 0; ; looks++) {
    const claim: RefreshClaim = await ctx.runMutation(
      internal.xeroTokens.claimRefresh,
      { grantId, holder },
    )
    if (claim.claimed) {
      return await refreshUnderLease(ctx, grantId, holder, claim)
    }
    if (claim.reason !== 'busy') throw new ConvexError('XERO_RECONNECT')
    if (looks === BUSY_LOOKS) throw new ConvexError('XERO_BUSY')

    await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS))
    const latest = await usableGrant(ctx, grantId)
    const newer =
      !opts.forceRefresh || latest.accessExpiresAt > first.accessExpiresAt
    if (isFresh(latest) && newer) return await openAccess(latest)
    // Not stored yet: try for the lease again, which a holder that failed
    // has handed back (or whose minute has run out).
  }
}

async function usableGrant(
  ctx: ActionCtx,
  grantId: Id<'xeroGrants'>,
): Promise<GrantForUse> {
  const grant: GrantForUse | null = await ctx.runQuery(
    internal.xeroTokens.grantForUse,
    { grantId },
  )
  if (!grant || grant.status === 'dead') throw new ConvexError('XERO_RECONNECT')
  return grant
}

function isFresh(grant: GrantForUse): boolean {
  return grant.accessExpiresAt > Date.now() + FRESH_MARGIN_MS
}

async function openAccess(grant: GrantForUse): Promise<string> {
  return await decryptToken(grant.accessCipher, accessAad(grant.xeroUserId))
}

/** The refresh itself, by the lease's holder. Every way out either stores
 * the new set, hands the lease back, or marks the grant dead — never leaves
 * the lease to time out when it need not. */
async function refreshUnderLease(
  ctx: ActionCtx,
  grantId: Id<'xeroGrants'>,
  holder: string,
  claim: { refreshCipher: string; xeroUserId: string },
): Promise<string> {
  const { xeroUserId } = claim
  // Expiry counts from before the call, so a slow answer errs early.
  const askedAt = Date.now()
  let fresh: XeroTokenSet
  try {
    const refreshToken = await decryptToken(
      claim.refreshCipher,
      refreshAad(xeroUserId),
    )
    fresh = await refreshTokens(refreshToken)
  } catch (error) {
    if (error instanceof XeroError && error.classified.kind === 'reconnect') {
      const { marked }: { marked: boolean } = await ctx.runMutation(
        internal.xeroTokens.markGrantDead,
        { grantId, holder },
      )
      // Not marked: a new consent replaced this set while the refresh was
      // out. That one works, so the caller's next try will too.
      throw new ConvexError(marked ? 'XERO_RECONNECT' : 'XERO_RETRY')
    }
    await ctx.runMutation(internal.xeroTokens.releaseRefresh, {
      grantId,
      holder,
    })
    // A token that will not open, or keys that will not parse, are ours to
    // fix (XERO_TOKEN_KEYS), not the person's: the grant is not marked dead,
    // so putting the key back brings every connection back as it was.
    if (error instanceof ConvexError) throw error
    const kind = error instanceof XeroError ? error.classified.kind : 'failed'
    console.error(`[xero] refresh for grant ${grantId}: ${kind}`)
    throw new ConvexError('XERO_RETRY')
  }

  let sealed: [string, string]
  try {
    sealed = await Promise.all([
      encryptToken(fresh.accessToken, accessAad(xeroUserId)),
      encryptToken(fresh.refreshToken, refreshAad(xeroUserId)),
    ])
  } catch (error) {
    // Xero has already rotated the token, but the one this grant holds stays
    // usable at Xero for 30 minutes: hand the lease back and let the next
    // caller refresh again.
    await ctx.runMutation(internal.xeroTokens.releaseRefresh, {
      grantId,
      holder,
    })
    throw error
  }
  const [accessCipher, refreshCipher] = sealed

  const { stored }: { stored: boolean } = await ctx.runMutation(
    internal.xeroTokens.storeRefreshed,
    {
      grantId,
      holder,
      accessCipher,
      accessExpiresAt: askedAt + fresh.expiresIn * 1000,
      refreshCipher,
      scopes: fresh.scopes,
    },
  )
  if (!stored) {
    // The lease passed to someone else, or a new consent replaced the set.
    // Theirs is kept; this access token is still good for the call at hand.
    console.warn(`[xero] refresh for grant ${grantId} not kept: superseded`)
  }
  return fresh.accessToken
}

/**
 * What `retireGrant` managed:
 * - `revoked`: forgotten here and revoked at Xero, which takes every
 *   connection this Xero login made with PestM8 out of Xero with it. Also
 *   when it was already gone: whoever got there first did the same.
 * - `unrevoked`: forgotten here, but not revoked — Xero had already refused
 *   the sign-in, or the revoke failed. Its refresh token lapses at Xero by
 *   itself; Xero may still list the connections it made.
 * - `in_use`: kept, because a live connection uses it again.
 * - `busy`: someone holds its refresh lease; try again later.
 */
export type Retired = 'revoked' | 'unrevoked' | 'in_use' | 'busy'

/**
 * Revokes a grant nothing uses, and forgets it.
 *
 * Under the refresh lease, so no refresh spends the token while it is being
 * revoked; and the row is deleted BEFORE the revoke, in the one transaction
 * that checks it is still unused (convex/xero.ts `dropGrant`) — a consent
 * arriving in between then finds no row and makes a fresh one, rather than
 * having its new tokens revoked along with the old. A revoke that fails after
 * that is logged and left: the row is gone, so nothing here can use or
 * refresh the token again, and it dies at Xero after 60 days.
 *
 * Not a Convex function: the release at Xero (convex/xero.ts) and the
 * keep-alive (`refreshGrant`) both await it.
 */
export async function retireGrant(
  ctx: ActionCtx,
  grantId: Id<'xeroGrants'>,
): Promise<Retired> {
  const holder = crypto.randomUUID()
  const claim: RefreshClaim = await ctx.runMutation(
    internal.xeroTokens.claimRefresh,
    { grantId, holder },
  )
  if (!claim.claimed) {
    if (claim.reason === 'busy') return 'busy'
    if (claim.reason === 'gone') return 'revoked'
    await ctx.runMutation(internal.xero.dropGrant, { grantId })
    return 'unrevoked'
  }

  const { dropped }: { dropped: boolean } = await ctx.runMutation(
    internal.xero.dropGrant,
    { grantId },
  )
  if (!dropped) {
    await ctx.runMutation(internal.xeroTokens.releaseRefresh, {
      grantId,
      holder,
    })
    return 'in_use'
  }

  try {
    await revokeRefreshToken(
      await decryptToken(claim.refreshCipher, refreshAad(claim.xeroUserId)),
    )
    return 'revoked'
  } catch (error) {
    const code =
      error instanceof XeroError
        ? `${error.message} (${JSON.stringify(error.classified)})`
        : error instanceof ConvexError
          ? String(error.data)
          : error instanceof Error
            ? error.message
            : 'failed'
    console.error(`[xero] revoking grant ${grantId} failed: ${code}`)
    return 'unrevoked'
  }
}
