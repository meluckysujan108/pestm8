import { ConvexError, v } from 'convex/values'
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { authComponent } from './auth'
import { getAuthUserId, requireAuthUser, requireMembership } from './lib/access'
import { isMemberColour, nextColour, normaliseColour } from './lib/colours'
import { isValidEmail } from './lib/email'
import {
  INVITE_TTL_MS,
  hashInviteToken,
  inviteState,
  maskEmail,
  newInviteToken,
} from './lib/inviteTokens'
import { role } from './schema'
import { forSelf, recordAudit } from './lib/audit'
import type { Id } from './_generated/dataModel'
import {
  requireActor,
  requireAssignableRole,
  requireCapability,
} from './lib/actor'
import { NO_GRANTS } from './lib/capabilities'
import type { Role } from './lib/capabilities'

/**
 * Joining a business, rebuilt around a link the owner shares.
 *
 * The rule that matters: a membership is only ever created by redeeming a
 * token. Knowing (or guessing) someone's email address is not enough, which is
 * exactly what it used to be — see `memberships.claimInvitations`.
 *
 * Nobody is invited as an owner. The owner account is the key to the business;
 * it is created by the bootstrap runbook, not handed out over SMS.
 */

function assertInvitableRole(value: Role) {
  requireAssignableRole(value)
}

/** Built from SITE_URL, never from a request header — a Host-header-derived
 * link is a phishing primitive. */
function joinUrl(token: string): string {
  const base = process.env.SITE_URL ?? ''
  return `${base.replace(/\/+$/, '')}/join/${token}`
}

// ---------------------------------------------------------------- create

export const create = action({
  args: {
    businessId: v.id('businesses'),
    email: v.string(),
    role,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ invitationId: Id<'invitations'>; url: string }> => {
    assertInvitableRole(args.role)

    const token = newInviteToken()
    const invitationId: Id<'invitations'> = await ctx.runMutation(
      internal.invitations.store,
      {
        businessId: args.businessId,
        email: args.email,
        role: args.role,
        tokenHash: await hashInviteToken(token),
      },
    )

    // Returned exactly once. The plain token is never stored, so an owner who
    // loses the link regenerates rather than looks it up.
    return { invitationId, url: joinUrl(token) }
  },
})

export const store = internalMutation({
  args: {
    businessId: v.id('businesses'),
    email: v.string(),
    role,
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const env = await requireActor(ctx, args.businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real
    assertInvitableRole(args.role)

    // Lower-cased whole, not just the domain as a client's email is: the
    // invitation is matched to the account that redeems it, and sign-in
    // addresses are compared case-insensitively.
    const email = args.email.trim().toLowerCase()
    // The app's one rule for an address (lib/email.ts), which refuses only
    // what can never be delivered to — "kevin@gmail..com", "kevin@kp.c". Still
    // loose on purpose: the binding is what matters, and an unusual but real
    // address must not be turned away.
    if (!isValidEmail(email)) throw new ConvexError('INVALID_EMAIL')

    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', args.businessId))
      .collect()

    // Inviting someone who is already here produces a link that can never be
    // redeemed, and a pending row the owner has to work out the meaning of.
    for (const member of members) {
      if (member.status !== 'active') continue
      const user = await authComponent.getAnyUserById(ctx, member.userId)
      if (String(user?.email ?? '').toLowerCase() === email) {
        throw new ConvexError('ALREADY_MEMBER')
      }
    }

    const now = Date.now()

    // Re-inviting the same address replaces the outstanding link rather than
    // leaving two live tokens for one seat.
    const existing = await ctx.db
      .query('invitations')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()
    for (const invitation of existing) {
      if (invitation.businessId !== args.businessId) continue
      if (inviteState(invitation, now) !== 'valid') continue
      await ctx.db.patch(invitation._id, { revokedAt: now })
    }

    const invitationId = await ctx.db.insert('invitations', {
      businessId: args.businessId,
      email,
      role: args.role,
      invitedByMembershipId: actor._id,
      createdAt: now,
      tokenHash: args.tokenHash,
      expiresAt: now + INVITE_TTL_MS,
    })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'invitation.create',
      entityType: 'invitations',
      entityId: invitationId,
      meta: { email, role: args.role },
      at: now,
    })

    return invitationId
  },
})

/** A new token on the same row: the old link dies immediately. */
export const regenerate = action({
  args: {
    businessId: v.id('businesses'),
    invitationId: v.id('invitations'),
  },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const token = newInviteToken()
    await ctx.runMutation(internal.invitations.applyNewToken, {
      businessId: args.businessId,
      invitationId: args.invitationId,
      tokenHash: await hashInviteToken(token),
    })
    return { url: joinUrl(token) }
  },
})

export const applyNewToken = internalMutation({
  args: {
    businessId: v.id('businesses'),
    invitationId: v.id('invitations'),
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const env = await requireActor(ctx, args.businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real
    const invitation = await ctx.db.get(args.invitationId)
    if (!invitation || invitation.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (invitation.claimedAt !== undefined)
      throw new ConvexError('ALREADY_MEMBER')

    const now = Date.now()
    await ctx.db.patch(args.invitationId, {
      tokenHash: args.tokenHash,
      expiresAt: now + INVITE_TTL_MS,
      revokedAt: undefined,
    })
    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'invitation.regenerate',
      entityType: 'invitations',
      entityId: args.invitationId,
      at: now,
    })
  },
})

// ---------------------------------------------------------------- redeem

/**
 * What the join page shows before anyone signs in. Deliberately thin: the
 * business name so the invitee knows who is asking, the role so they know what
 * they are agreeing to, and a masked email so they can tell whether this link
 * was meant for them. Never the inviter, and never the full address.
 */
export const preview = action({
  args: { token: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    state: string
    businessName: string | null
    roleLabel: string | null
    emailHint: string | null
  }> =>
    ctx.runQuery(internal.invitations.previewByHash, {
      tokenHash: await hashInviteToken(args.token),
    }),
})

export const previewByHash = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const invitation = await ctx.db
      .query('invitations')
      .withIndex('by_token_hash', (q) => q.eq('tokenHash', tokenHash))
      .unique()

    const state = inviteState(invitation, Date.now())
    if (!invitation || state !== 'valid') {
      // One shape for every failure: an expired link and a made-up one look
      // the same from outside.
      return { state, businessName: null, roleLabel: null, emailHint: null }
    }

    const business = await ctx.db.get(invitation.businessId)
    return {
      state,
      businessName: business?.name ?? null,
      roleLabel: invitation.role === 'owner' ? 'Owner' : 'Subcontractor',
      emailHint: maskEmail(invitation.email),
    }
  },
})

/**
 * Turns a token into a membership. The caller must already be signed in as the
 * invited address — the token proves they hold the link, the email match stops
 * a forwarded link from quietly enrolling somebody else.
 */
export const redeem = action({
  args: { token: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ businessId: Id<'businesses'>; slug: string }> =>
    ctx.runMutation(internal.invitations.redeemByHash, {
      tokenHash: await hashInviteToken(args.token),
    }),
})

export const redeemByHash = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    // requireAuthUser throws ConvexError('Unauthenticated') itself when there
    // is no live session, so there is nothing to null-check here. It also
    // refuses an account that has not set up two-step sign-in: joining comes
    // after enrolment, never before (see `requireAuthUser`).
    const user = await requireAuthUser(ctx)

    const invitation = await ctx.db
      .query('invitations')
      .withIndex('by_token_hash', (q) => q.eq('tokenHash', tokenHash))
      .unique()

    const now = Date.now()
    const state = inviteState(invitation, now)
    if (!invitation || state !== 'valid') {
      throw new ConvexError(
        state === 'claimed'
          ? 'INVITE_ALREADY_USED'
          : state === 'expired'
            ? 'INVITE_EXPIRED'
            : state === 'revoked'
              ? 'INVITE_REVOKED'
              : 'INVITE_INVALID',
      )
    }

    const email = user.email.toLowerCase()
    if (email !== invitation.email)
      throw new ConvexError('INVITE_EMAIL_MISMATCH')

    const business = await ctx.db.get(invitation.businessId)
    if (!business) throw new ConvexError('NOT_FOUND')

    const existing = await ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', user._id).eq('businessId', invitation.businessId),
      )
      .unique()

    let membershipId: Id<'memberships'>
    if (existing) {
      if (existing.status === 'active') throw new ConvexError('ALREADY_MEMBER')
      // Rejoining starts from the invitation, not from whatever this person
      // held last time: a former owner re-invited as a subcontractor must come
      // back as a subcontractor, with no grants carried over. Their colour
      // comes back too, when it still can: it must be one the palette offers
      // (not a colour from before Phase 4.2's), and nobody active may have
      // been dealt it while they were away — two people with one colour are
      // two jobs nobody can tell apart on the schedule. Otherwise they are
      // dealt afresh, like anyone joining.
      const others = (
        await ctx.db
          .query('memberships')
          .withIndex('by_business', (q) =>
            q.eq('businessId', invitation.businessId),
          )
          .collect()
      ).filter((m) => m._id !== existing._id && m.status !== 'removed')
      const keptColour = normaliseColour(existing.colour)
      const colour =
        keptColour &&
        isMemberColour(keptColour) &&
        !others.some((m) => normaliseColour(m.colour) === keptColour)
          ? keptColour
          : nextColour(others.map((m) => m.colour))
      await ctx.db.patch(existing._id, {
        status: 'active',
        role: invitation.role,
        canViewAllJobs: false,
        canViewOtherAccounts: false,
        viewingAsMembershipId: undefined,
        colour,
      })
      membershipId = existing._id
    } else {
      const members = await ctx.db
        .query('memberships')
        .withIndex('by_business', (q) =>
          q.eq('businessId', invitation.businessId),
        )
        .collect()
      membershipId = await ctx.db.insert('memberships', {
        userId: user._id,
        businessId: invitation.businessId,
        role: invitation.role,
        canViewAllJobs: false,
        // Nothing, until somebody grants it. A new joiner arrives with no
        // access to anyone else's work, which is what NO_GRANTS means and what
        // `canViewAllJobs: false` beside it has always meant.
        grants: NO_GRANTS,
        // Frozen now so that leaving and renaming the login later cannot
        // rewrite their name on reports they are about to sign.
        displayName: user.name.trim() || undefined,
        colour: nextColour(
          members.filter((m) => m.status !== 'removed').map((m) => m.colour),
        ),
        status: 'active',
        createdAt: now,
      })
    }

    // Single use. Inside this mutation, so two people opening the same link at
    // once cannot both get in — the second transaction sees `claimedAt` set.
    await ctx.db.patch(invitation._id, {
      claimedAt: now,
      claimedByUserId: user._id,
      claimedMembershipId: membershipId,
    })

    await recordAudit(ctx, forSelf(membershipId), {
      businessId: invitation.businessId,
      action: 'invitation.redeem',
      entityType: 'invitations',
      entityId: invitation._id,
      meta: { email, role: invitation.role },
      at: now,
    })

    return { businessId: invitation.businessId, slug: business.slug }
  },
})

/**
 * The check behind the invite-only sign-up gate (`convex/auth.ts`).
 *
 * Advisory only — it runs before Better Auth creates the user, and Convex's
 * auth adapter has no transactions, so it cannot also consume the invitation.
 * Redeeming stays where it belongs: one mutation, single-use, atomic. This just
 * stops an account being created at all without a live link.
 */
export const checkForSignUp = internalQuery({
  args: { tokenHash: v.string(), email: v.string() },
  handler: async (ctx, { tokenHash, email }) => {
    const invitation = await ctx.db
      .query('invitations')
      .withIndex('by_token_hash', (q) => q.eq('tokenHash', tokenHash))
      .unique()

    const state = inviteState(invitation, Date.now())
    if (!invitation || state !== 'valid') {
      return { ok: false as const, code: `INVITE_${state.toUpperCase()}` }
    }
    if (invitation.email !== email.trim().toLowerCase()) {
      return { ok: false as const, code: 'INVITE_EMAIL_MISMATCH' }
    }
    return { ok: true as const, code: '' }
  },
})

// ---------------------------------------------------------------- manage

export const listForBusiness = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    requireCapability(await requireActor(ctx, businessId), 'team.manage')
    const now = Date.now()

    const rows = await ctx.db
      .query('invitations')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    return rows
      .map((invitation) => ({
        _id: invitation._id,
        email: invitation.email,
        role: invitation.role,
        createdAt: invitation.createdAt,
        expiresAt: invitation.expiresAt,
        state: inviteState(invitation, now),
      }))
      .filter((row) => row.state === 'valid' || row.state === 'legacy')
      .sort((a, b) => b.createdAt - a.createdAt)
  },
})

export const revoke = mutation({
  args: {
    businessId: v.id('businesses'),
    invitationId: v.id('invitations'),
  },
  handler: async (ctx, { businessId, invitationId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'team.manage')
    const actor = env.actor.real
    const invitation = await ctx.db.get(invitationId)
    if (!invitation || invitation.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    // A claimed invitation is the record of how someone joined. Revoking it
    // would erase that; removing their access is a membership action.
    if (invitation.claimedAt !== undefined)
      throw new ConvexError('ALREADY_MEMBER')

    const now = Date.now()
    await ctx.db.patch(invitationId, { revokedAt: now })
    await recordAudit(ctx, forSelf(actor._id), {
      businessId,
      action: 'invitation.revoke',
      entityType: 'invitations',
      entityId: invitationId,
      meta: { email: invitation.email },
      at: now,
    })
  },
})

/**
 * Whether this signed-in user has an unredeemed invitation waiting — so a
 * person who signed up before opening their link, or who lost it, gets told
 * what to do instead of an empty "no access" screen.
 *
 * Says nothing about which business, and hands out no token.
 */
export const mineExists = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)
    const user = await authComponent.getAnyUserById(ctx, userId)
    const email = String(user?.email ?? '').toLowerCase()
    if (!email) return false

    const now = Date.now()
    const rows = await ctx.db
      .query('invitations')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()
    return rows.some((row) => inviteState(row, now) === 'valid')
  },
})

/** Used by the Team screen to show who is still outstanding. */
export const countOutstanding = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    const now = Date.now()
    const rows = await ctx.db
      .query('invitations')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    return rows.filter((row) => inviteState(row, now) === 'valid').length
  },
})
