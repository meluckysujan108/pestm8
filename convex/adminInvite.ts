import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { internalAction, internalMutation } from './_generated/server'
import { authComponent } from './auth'
import { forSelf, recordAudit } from './lib/audit'
import { requireAssignableRole, writeEnvelopeForMember } from './lib/actor'
import { canManageMember, clampGrants } from './lib/capabilities'
import { factsFromMembership } from './lib/membershipFacts'
import { isValidEmail } from './lib/email'
import {
  INVITE_TTL_MS,
  hashInviteToken,
  inviteState,
  newInviteToken,
} from './lib/inviteTokens'
import { role } from './schema'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

/**
 * A CLI-only stand-in for `invitations.create`, for when nobody can sign in
 * to run the real one: the owner exists in the database but nobody at hand
 * knows their password, and this app has no password-reset flow (no email
 * provider is configured on any deployment — CLAUDE.md).
 *
 * Everything else about it is the real invite: a random token, hashed and
 * stored, redeemed at `/join/<token>` through the ordinary sign-up-or-sign-in
 * flow (`invitations.redeemByHash`), bound to the exact email address it was
 * issued to. The plain token is only ever returned once, here.
 *
 * `actorMembershipId` stands in for the authenticated caller `store` would
 * have from `requireActor` + `team.manage` — supply an ACTIVE owner or
 * contractor of the target business. Not exposed to any client; reachable
 * only by `npx convex run` with deploy-key access, the same trust level as
 * every other one-off in `convex/migrations`.
 */
export const invite = internalAction({
  args: {
    businessId: v.id('businesses'),
    email: v.string(),
    role,
    actorMembershipId: v.id('memberships'),
  },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const token = newInviteToken()
    await ctx.runMutation(internal.adminInvite.store, {
      ...args,
      tokenHash: await hashInviteToken(token),
    })
    const base = (process.env.SITE_URL ?? '').replace(/\/+$/, '')
    return { url: `${base}/join/${token}` }
  },
})

export const store = internalMutation({
  args: {
    businessId: v.id('businesses'),
    email: v.string(),
    role,
    actorMembershipId: v.id('memberships'),
    tokenHash: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    {
      businessId,
      email: rawEmail,
      role: wantedRole,
      actorMembershipId,
      tokenHash,
    },
  ) => {
    const actor = await ctx.db.get(actorMembershipId)
    if (
      !actor ||
      actor.businessId !== businessId ||
      actor.status !== 'active' ||
      (actor.role !== 'owner' && actor.role !== 'contractor')
    ) {
      throw new ConvexError('NOT_ALLOWED')
    }
    requireAssignableRole(wantedRole)

    // As `invitations.store`: lower-cased whole, and the app's one rule for
    // an address rather than a second, looser copy of it.
    const email = rawEmail.trim().toLowerCase()
    if (!isValidEmail(email)) throw new ConvexError('INVALID_EMAIL')

    for (const member of await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()) {
      if (member.status !== 'active') continue
      const user = await authComponent.getAnyUserById(ctx, member.userId)
      if (String(user?.email ?? '').toLowerCase() === email) {
        throw new ConvexError('ALREADY_MEMBER')
      }
    }

    const now = Date.now()
    for (const existing of await ctx.db
      .query('invitations')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()) {
      if (existing.businessId !== businessId) continue
      if (inviteState(existing, now) !== 'valid') continue
      await ctx.db.patch(existing._id, { revokedAt: now })
    }

    const invitationId: Id<'invitations'> = await ctx.db.insert('invitations', {
      businessId,
      email,
      role: wantedRole,
      invitedByMembershipId: actor._id,
      createdAt: now,
      tokenHash,
      expiresAt: now + INVITE_TTL_MS,
    })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId,
      action: 'invitation.create',
      entityType: 'invitations',
      entityId: invitationId,
      meta: { email, role: wantedRole },
      at: now,
    })
  },
})

/**
 * CLI-only stand-in for `memberships.setGrants({ otherSchedules: true })`
 * (its own write path, same clamp, same audit row) — for the same reason
 * `invite` exists: no session to call the real mutation with. Give
 * `actorMembershipId` the demo/business owner acting, and `membershipId` the
 * row `invitations.redeemByHash` just created.
 */
export const grantFullVisibility = internalMutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    actorMembershipId: v.id('memberships'),
  },
  handler: async (
    ctx: MutationCtx,
    { businessId, membershipId, actorMembershipId },
  ) => {
    const env = await writeEnvelopeForMember(ctx, actorMembershipId)
    if (env.actor.real.businessId !== businessId) {
      throw new ConvexError('NOT_ALLOWED')
    }

    const target = await ctx.db.get(membershipId)
    if (!target || target.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    const facts = factsFromMembership(target)
    if (!canManageMember(env.actor, facts)) throw new ConvexError('NO_ACCESS')

    const clamped = clampGrants(env.actor, facts, {
      ...facts.grants,
      otherSchedules: true,
    })
    await ctx.db.patch(membershipId, {
      grants: clamped,
      canViewAllJobs: clamped.otherSchedules,
    })

    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId,
      action: 'membership.setGrants',
      entityType: 'memberships',
      entityId: membershipId,
      meta: { grants: clamped },
      at: Date.now(),
    })

    return clamped
  },
})
