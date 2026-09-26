import { ConvexError, v } from 'convex/values'
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { requireAuthUser } from './lib/access'
import { isValidEmail } from './lib/email'
import { isInviteOnly } from './lib/inviteOnly'
import { hashInviteToken, maskEmail, newInviteToken } from './lib/inviteTokens'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'

/**
 * Links that START a business — the way a new pest control company gets into
 * PestM8 while sign-up is invitation-only (`AUTH_INVITE_ONLY=on`).
 *
 * A team invitation (`invitations`) joins someone to a business that exists.
 * This is the other door: whoever runs PestM8 issues one from the CLI to the
 * owner-to-be's address, they open it at `/start/<token>`, create an account
 * (or sign in to the one they have), and go on to set up their business.
 *
 *     npx convex run businessInvites:issue '{"email":"jo@jospest.com.au","note":"Jo, Bunbury"}'
 *     npx convex run businessInvites:list
 *     npx convex run businessInvites:revoke '{"email":"jo@jospest.com.au"}'
 *
 * Built like a team invitation, and for the same reasons: a random token of
 * which only the hash is stored, bound to one address, single use. It differs
 * in being spent in two steps — CLAIMED when a signed-in account opens it,
 * USED when that account creates the business (`useBusinessAllowance`) —
 * because between the two there may be a two-step sign-in set-up, a reload,
 * or a night's sleep, and a claim held server-side survives all of them where
 * a token carried in the page would not.
 */

/** Long enough for an owner to find a quiet evening; the link is bound to
 * their address and single use, so a forwarded copy opens nothing. */
export const BUSINESS_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export type BusinessInviteState =
  'valid' | 'claimed' | 'used' | 'revoked' | 'expired' | 'invalid'

/**
 * One rule for every reader. Once claimed, the link's expiry no longer
 * matters: it is bound to that account, and set-up may take them a while.
 */
export function businessInviteState(
  invite: Doc<'businessInvites'> | null,
  now: number,
): BusinessInviteState {
  if (!invite) return 'invalid'
  if (invite.revokedAt !== undefined) return 'revoked'
  if (invite.businessId !== undefined) return 'used'
  if (invite.claimedAt !== undefined) return 'claimed'
  if (invite.expiresAt <= now) return 'expired'
  return 'valid'
}

/** The error a dead link answers with — the team invitation's words, so the
 * pages that show them need one list. */
function refusal(state: BusinessInviteState): string {
  switch (state) {
    case 'claimed':
    case 'used':
      return 'INVITE_ALREADY_USED'
    case 'expired':
      return 'INVITE_EXPIRED'
    case 'revoked':
      return 'INVITE_REVOKED'
    default:
      return 'INVITE_INVALID'
  }
}

/** Built from SITE_URL, never a request header (as `invitations.joinUrl`). */
function startUrl(token: string): string {
  const base = process.env.SITE_URL ?? ''
  return `${base.replace(/\/+$/, '')}/start/${token}`
}

async function byHash(
  ctx: QueryCtx | MutationCtx,
  tokenHash: string,
): Promise<Doc<'businessInvites'> | null> {
  return ctx.db
    .query('businessInvites')
    .withIndex('by_token_hash', (q) => q.eq('tokenHash', tokenHash))
    .unique()
}

/**
 * The claim this account holds and has not yet spent on a business, if any.
 * A handful at most per person, so the read is bounded.
 */
async function openClaim(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<Doc<'businessInvites'> | null> {
  const claims = await ctx.db
    .query('businessInvites')
    .withIndex('by_claimed_by_user_id', (q) => q.eq('claimedByUserId', userId))
    .take(20)
  return (
    claims.find(
      (row) => row.revokedAt === undefined && row.businessId === undefined,
    ) ?? null
  )
}

/**
 * The gate `businesses.create` goes through, split so nothing is written
 * before it answers: `check` refuses an invitation-only deployment's caller
 * with no open claim, and hands back a `spend` for once the business exists.
 * Off invitation-only, anyone may create a business — and a claim they happen
 * to hold is still spent on it, so the issuer's list stays true.
 */
export async function businessAllowance(
  ctx: MutationCtx,
  userId: string,
): Promise<{
  spend: (businessId: Id<'businesses'>, now: number) => Promise<void>
}> {
  const claim = await openClaim(ctx, userId)
  if (!claim && isInviteOnly()) {
    throw new ConvexError('BUSINESS_INVITE_REQUIRED')
  }
  return {
    spend: async (businessId, now) => {
      if (claim) await ctx.db.patch(claim._id, { businessId, usedAt: now })
    },
  }
}

// ---------------------------------------------------------------- issue (CLI)

export const issue = internalAction({
  args: { email: v.string(), note: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; email: string; expires: string }> => {
    const token = newInviteToken()
    const { email, expiresAt } = await ctx.runMutation(
      internal.businessInvites.store,
      {
        email: args.email,
        note: args.note,
        tokenHash: await hashInviteToken(token),
      },
    )
    // Returned once. Only the hash is kept, so a lost link is reissued.
    return {
      url: startUrl(token),
      email,
      expires: new Date(expiresAt).toISOString(),
    }
  },
})

export const store = internalMutation({
  args: {
    email: v.string(),
    note: v.optional(v.string()),
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase()
    if (!isValidEmail(email)) throw new ConvexError('INVALID_EMAIL')

    const now = Date.now()
    // Reissuing replaces the address's open link rather than leaving two.
    // A claimed one is left be: it belongs to an account now, and its owner
    // may be half-way through set-up.
    for (const row of await ctx.db
      .query('businessInvites')
      .withIndex('by_email', (q) => q.eq('email', email))
      .take(50)) {
      if (businessInviteState(row, now) === 'valid') {
        await ctx.db.patch(row._id, { revokedAt: now })
      }
    }

    const expiresAt = now + BUSINESS_INVITE_TTL_MS
    const note = args.note?.trim().slice(0, 200)
    await ctx.db.insert('businessInvites', {
      email,
      tokenHash: args.tokenHash,
      createdAt: now,
      expiresAt,
      ...(note ? { note } : {}),
    })
    return { email, expiresAt }
  },
})

/** Withdraws every link for an address that has not yet made a business —
 * an open link, and a claim not yet spent. */
export const revoke = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase()
    const now = Date.now()
    let revoked = 0
    for (const row of await ctx.db
      .query('businessInvites')
      .withIndex('by_email', (q) => q.eq('email', email))
      .take(50)) {
      const state = businessInviteState(row, now)
      if (state === 'valid' || state === 'claimed') {
        await ctx.db.patch(row._id, { revokedAt: now })
        revoked++
      }
    }
    return { revoked }
  },
})

/** The issuer's own view: newest first, full addresses (CLI only). */
export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const rows = await ctx.db.query('businessInvites').order('desc').take(50)
    return Promise.all(
      rows.map(async (row) => {
        const business = row.businessId
          ? await ctx.db.get(row.businessId)
          : null
        return {
          email: row.email,
          note: row.note ?? null,
          state: businessInviteState(row, now),
          issued: new Date(row.createdAt).toISOString(),
          expires: new Date(row.expiresAt).toISOString(),
          business: business ? `${business.name} (/${business.slug})` : null,
        }
      }),
    )
  },
})

// ---------------------------------------------------------------- the link

/**
 * What `/start/<token>` shows before anyone signs in: whether the link is
 * alive, and a masked address so its owner can tell it is theirs. Nothing
 * else — a link sent by text ends up on lock screens.
 */
export const preview = action({
  args: { token: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ state: BusinessInviteState; emailHint: string | null }> =>
    ctx.runQuery(internal.businessInvites.previewByHash, {
      tokenHash: await hashInviteToken(args.token),
    }),
})

export const previewByHash = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const invite = await byHash(ctx, tokenHash)
    const state = businessInviteState(invite, Date.now())
    // A claimed link still names its address, so its owner opening it again
    // on another device can be told to sign in rather than that it is dead.
    const shows = state === 'valid' || state === 'claimed' || state === 'used'
    return {
      state,
      emailHint: invite && shows ? maskEmail(invite.email) : null,
    }
  },
})

/**
 * Binds the link to the signed-in account. Idempotent for that account, so
 * opening it again — after a two-step set-up, on the office computer, after
 * the app reloaded — carries on instead of calling it used. Answers where to
 * go next: set-up, or the business the claim already made.
 */
export const claim = action({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ slug: string | null }> =>
    ctx.runMutation(internal.businessInvites.claimByHash, {
      tokenHash: await hashInviteToken(args.token),
    }),
})

export const claimByHash = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }): Promise<{ slug: string | null }> => {
    // Gated like everything else: an account without two-step sign-in, where
    // it is compulsory, sets that up first (lib/access.ts).
    const user = await requireAuthUser(ctx)
    const invite = await byHash(ctx, tokenHash)
    const now = Date.now()
    const state = businessInviteState(invite, now)

    if (invite && invite.claimedByUserId === user._id) {
      if (state === 'claimed') return { slug: null }
      if (state === 'used' && invite.businessId) {
        const business = await ctx.db.get(invite.businessId)
        return { slug: business?.slug ?? null }
      }
    }
    if (!invite || state !== 'valid') throw new ConvexError(refusal(state))
    if (user.email.toLowerCase() !== invite.email) {
      throw new ConvexError('INVITE_EMAIL_MISMATCH')
    }

    await ctx.db.patch(invite._id, {
      claimedAt: now,
      claimedByUserId: user._id,
    })
    return { slug: null }
  },
})

/**
 * Whether this account may set up a business — what `/onboarding` asks
 * before offering the form, so someone with no business and no link (a
 * technician the team has let go) is told so instead of being handed a form
 * the server will refuse.
 */
export const setupAccess = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAuthUser(ctx)
    return {
      canCreate: !isInviteOnly() || (await openClaim(ctx, user._id)) !== null,
    }
  },
})

/**
 * The half of the invite-only sign-up gate (`convex/auth.ts`) for these
 * links, beside `invitations.checkForSignUp` for team ones. Advisory, as that
 * one is: it only stops an account being created without a live link. The
 * claim itself happens signed in, in one mutation.
 */
export const checkForSignUp = internalQuery({
  args: { tokenHash: v.string(), email: v.string() },
  handler: async (ctx, { tokenHash, email }) => {
    const invite = await byHash(ctx, tokenHash)
    const state = businessInviteState(invite, Date.now())
    if (!invite || state !== 'valid') {
      return { ok: false as const, code: refusal(state) }
    }
    if (invite.email !== email.trim().toLowerCase()) {
      return { ok: false as const, code: 'INVITE_EMAIL_MISMATCH' }
    }
    return { ok: true as const, code: '' }
  },
})
