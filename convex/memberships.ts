import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import {
  canViewAs,
  getAuthUserId,
  requireMembership,
  requireOwner,
} from './lib/access'
import { nextColour } from './lib/colours'
import { inviteState } from './lib/inviteTokens'
import { role } from './schema'
import { forSelf, recordAudit } from './lib/audit'

export const listForBusiness = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)

    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    const visible = members.filter((m) => m.status !== 'removed')

    return Promise.all(
      visible.map(async (m) => {
        // A team list showing user ids would be unusable; the auth component
        // owns identity, so the name and email are resolved from there.
        const user = await authComponent.getAnyUserById(ctx, m.userId)
        return {
          _id: m._id,
          userId: m.userId,
          name: user?.name ?? '',
          email: user?.email ?? '',
          role: m.role,
          canViewAllJobs: m.canViewAllJobs,
          canViewOtherAccounts: m.canViewOtherAccounts ?? false,
          licenceNumber: m.licenceNumber,
          phone: m.phone,
          colour: m.colour,
          status: m.status,
        }
      }),
    )
  },
})

/**
 * Superseded by `invitations.create`, which mints a single-use link.
 *
 * Kept as a loud failure rather than deleted: a stale PWA still has the old
 * Team screen, and an owner tapping Invite there must not believe an
 * invitation exists when nothing can redeem it. Deleted at CONTRACT.
 */
export const inviteByEmail = mutation({
  args: {
    businessId: v.id('businesses'),
    email: v.string(),
    role,
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.businessId)
    throw new ConvexError('APP_UPDATE_REQUIRED')
  },
})

/** Superseded by `invitations.listForBusiness`, which also reports each link's
 * state. Kept so a stale Team screen still renders; deleted at CONTRACT. */
export const listInvitations = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireOwner(ctx, businessId)

    const all = await ctx.db
      .query('invitations')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    const now = Date.now()
    return all
      .filter((i) => inviteState(i, now) === 'valid')
      .map((i) => ({ _id: i._id, email: i.email, role: i.role }))
  },
})

/** Superseded by `invitations.revoke`. Now a soft revoke: a hard delete left no
 * record that an invitation had ever been issued or withdrawn. */
export const revokeInvitation = mutation({
  args: {
    businessId: v.id('businesses'),
    invitationId: v.id('invitations'),
  },
  handler: async (ctx, { businessId, invitationId }) => {
    const actor = await requireOwner(ctx, businessId)

    const invitation = await ctx.db.get(invitationId)
    if (!invitation || invitation.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (invitation.claimedAt !== undefined) {
      throw new ConvexError('ALREADY_MEMBER')
    }

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
 * Retired. This used to create an active membership for any invitation whose
 * email matched the signed-in user's — with email verification off and sign-up
 * open, that meant whoever registered an invited address first joined the
 * business, and it ran automatically on every visit to "/".
 *
 * Joining now requires redeeming a single-use link (`invitations.redeem`).
 *
 * The signature is preserved and the body made a no-op on purpose: a PWA still
 * running the old bundle calls this in its `/` beforeLoad, and an argument or
 * name change there would turn every sign-in on that device into a bare
 * "Server Error". Deleted at CONTRACT, once no client calls it.
 */
export const claimInvitations = mutation({
  args: {},
  handler: async (): Promise<Array<string>> => [],
})

export const invite = mutation({
  args: {
    businessId: v.id('businesses'),
    userId: v.string(),
    role,
  },
  handler: async (ctx, args) => {
    const actor = await requireOwner(ctx, args.businessId)
    // The owner account is the key to the business; it is never handed out
    // through an invitation, only by the bootstrap runbook.
    if (args.role === 'owner') throw new ConvexError('OWNER_INVITE_FORBIDDEN')

    const existing = await ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', args.userId).eq('businessId', args.businessId),
      )
      .unique()

    if (existing && existing.status !== 'removed') {
      throw new ConvexError('ALREADY_MEMBER')
    }

    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', args.businessId))
      .collect()
    const colour = nextColour(members.map((m) => m.colour))

    const membershipId = existing
      ? (await ctx.db.patch(existing._id, {
          role: args.role,
          status: 'invited',
          canViewAllJobs: false,
        }),
        existing._id)
      : await ctx.db.insert('memberships', {
          userId: args.userId,
          businessId: args.businessId,
          role: args.role,
          canViewAllJobs: false,
          colour,
          status: 'invited',
          createdAt: Date.now(),
        })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'membership.invite',
      entityType: 'memberships',
      entityId: membershipId,
      meta: { role: args.role },
      at: Date.now(),
    })

    return membershipId
  },
})

/**
 * An invited person activates their own membership. Deliberately not an owner
 * action: joining a business is the subcontractor's decision, which is also the
 * posture that keeps the arrangement looking like genuine contracting (§1.4).
 *
 * Cannot use requireMembership — that demands an already-active membership.
 */
export const accept = mutation({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const userId = await getAuthUserId(ctx)

    const membership = await ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', userId).eq('businessId', businessId),
      )
      .unique()

    if (!membership || membership.status !== 'invited') {
      throw new ConvexError('NOT_FOUND')
    }
    // An 'invited' row created before owner invites were blocked would
    // otherwise still activate into a second owner account here.
    if (membership.role === 'owner') {
      throw new ConvexError('OWNER_INVITE_FORBIDDEN')
    }

    await ctx.db.patch(membership._id, { status: 'active' })

    await recordAudit(ctx, forSelf(membership._id), {
      businessId,
      action: 'membership.accept',
      entityType: 'memberships',
      entityId: membership._id,
      at: Date.now(),
    })

    return membership._id
  },
})

/** Invitations a signed-in user has not yet accepted. */
export const myInvitations = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    return Promise.all(
      memberships
        .filter((m) => m.status === 'invited')
        .map(async (m) => {
          const business = await ctx.db.get(m.businessId)
          return {
            businessId: m.businessId,
            role: m.role,
            name: business?.name ?? '',
            slug: business?.slug ?? '',
          }
        }),
    )
  },
})

export const setCanViewAllJobs = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    canViewAllJobs: v.boolean(),
  },
  handler: async (ctx, args) => {
    const actor = await requireOwner(ctx, args.businessId)

    const target = await ctx.db.get(args.membershipId)
    if (!target || target.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    await ctx.db.patch(args.membershipId, {
      canViewAllJobs: args.canViewAllJobs,
    })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'membership.setCanViewAllJobs',
      entityType: 'memberships',
      entityId: args.membershipId,
      meta: { canViewAllJobs: args.canViewAllJobs },
      at: Date.now(),
    })
  },
})

/**
 * Distinct from setCanViewAllJobs (a data-scope grant): this governs whether
 * a subcontractor can also view the app through OTHER members' eyes via the
 * header account menu's "view as" — never grantable for viewing the owner,
 * even when on (enforced again, unconditionally, in lib/access.ts's own
 * canViewAs check — this guard here just fails loud and early).
 */
export const setCanViewOtherAccounts = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    canViewOtherAccounts: v.boolean(),
  },
  handler: async (ctx, args) => {
    const actor = await requireOwner(ctx, args.businessId)

    const target = await ctx.db.get(args.membershipId)
    if (!target || target.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (target.role === 'owner') throw new ConvexError('NO_ACCESS')

    await ctx.db.patch(args.membershipId, {
      canViewOtherAccounts: args.canViewOtherAccounts,
    })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'membership.setCanViewOtherAccounts',
      entityType: 'memberships',
      entityId: args.membershipId,
      meta: { canViewOtherAccounts: args.canViewOtherAccounts },
      at: Date.now(),
    })
  },
})

export const setRole = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    role,
  },
  handler: async (ctx, args) => {
    const actor = await requireOwner(ctx, args.businessId)

    const target = await ctx.db.get(args.membershipId)
    if (!target || target.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    if (target.role === 'owner' && args.role !== 'owner') {
      const owners = await ctx.db
        .query('memberships')
        .withIndex('by_business', (q) => q.eq('businessId', args.businessId))
        .collect()
      const activeOwners = owners.filter(
        (m) => m.role === 'owner' && m.status === 'active',
      )
      if (activeOwners.length <= 1) throw new ConvexError('LAST_OWNER')
    }

    await ctx.db.patch(args.membershipId, { role: args.role })

    await recordAudit(ctx, forSelf(actor._id), {
      businessId: args.businessId,
      action: 'membership.setRole',
      entityType: 'memberships',
      entityId: args.membershipId,
      meta: { role: args.role },
      at: Date.now(),
    })
  },
})

export const setLicence = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    licenceNumber: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireMembership(ctx, args.businessId)

    const target = await ctx.db.get(args.membershipId)
    if (!target || target.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    // A licence belongs to the person who holds it: owners maintain the team
    // roster, but everyone else may only set their own.
    if (actor.role !== 'owner' && actor._id !== args.membershipId) {
      throw new ConvexError('NO_ACCESS')
    }

    const licenceNumber = args.licenceNumber.trim().slice(0, 64)
    const previous = target.licenceNumber

    await ctx.db.patch(args.membershipId, { licenceNumber })

    // This number is printed on every certificate that person signs. Changing
    // it silently — particularly an owner changing someone else's — left no
    // trace at all, which is the opposite of what a compliance dispute needs.
    if (previous !== licenceNumber) {
      await recordAudit(ctx, forSelf(actor._id), {
        businessId: args.businessId,
        action: 'membership.setLicence',
        entityType: 'memberships',
        entityId: args.membershipId,
        meta: { from: previous ?? '', to: licenceNumber },
        at: Date.now(),
      })
    }
  },
})

/**
 * Self-service only — no owner-on-behalf override, unlike setLicence. Name
 * and email live in the Better Auth user record and are edited directly via
 * authClient's own update methods; phone has no home there, so it lives on
 * the membership (a work number may reasonably differ per business).
 */
export const setProfile = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireMembership(ctx, args.businessId)
    if (actor._id !== args.membershipId) throw new ConvexError('NO_ACCESS')

    await ctx.db.patch(args.membershipId, { phone: args.phone })
  },
})

/**
 * Always self-only to write (the caller's own membership, never an
 * argument-supplied one) — "view as" can only ever change what YOU see.
 * Validated here too (not just read-side in resolveViewScope) so a rejected
 * attempt fails immediately with a clear error rather than silently no-op.
 */
export const setViewingAs = mutation({
  args: {
    businessId: v.id('businesses'),
    targetMembershipId: v.optional(v.id('memberships')),
  },
  handler: async (ctx, args) => {
    const actor = await requireMembership(ctx, args.businessId)

    if (args.targetMembershipId === undefined) {
      await ctx.db.patch(actor._id, { viewingAsMembershipId: undefined })
      return
    }

    const target = await ctx.db.get(args.targetMembershipId)
    if (!target) throw new ConvexError('NOT_FOUND')
    if (!canViewAs(actor, target)) throw new ConvexError('NO_ACCESS')

    await ctx.db.patch(actor._id, {
      viewingAsMembershipId: args.targetMembershipId,
    })
  },
})
