import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import { canViewAs, getAuthUserId, requireMembership, requireOwner } from './lib/access'
import { nextColour } from './lib/colours'
import { role } from './schema'

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
          name: (user?.name as string | undefined) ?? '',
          email: (user?.email as string | undefined) ?? '',
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
 * Invite by email. The owner knows an email address, not a Convex user id, and
 * the person may not have signed up yet — so this records an invitation the
 * recipient claims later rather than reaching into the auth tables.
 */
export const inviteByEmail = mutation({
  args: {
    businessId: v.id('businesses'),
    email: v.string(),
    role,
  },
  handler: async (ctx, args) => {
    const actor = await requireOwner(ctx, args.businessId)
    const email = args.email.trim().toLowerCase()
    if (!email.includes('@')) throw new ConvexError('INVALID_EMAIL')

    const existing = await ctx.db
      .query('invitations')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()

    const outstanding = existing.find(
      (i) => i.businessId === args.businessId && i.claimedAt === undefined,
    )
    if (outstanding) return outstanding._id

    const invitationId = await ctx.db.insert('invitations', {
      businessId: args.businessId,
      email,
      role: args.role,
      invitedByMembershipId: actor._id,
      createdAt: Date.now(),
    })

    await ctx.db.insert('auditLog', {
      businessId: args.businessId,
      actorMembershipId: actor._id,
      action: 'invitation.create',
      entityType: 'invitations',
      entityId: invitationId,
      meta: { email, role: args.role },
      at: Date.now(),
    })

    return invitationId
  },
})

export const listInvitations = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireOwner(ctx, businessId)

    const all = await ctx.db
      .query('invitations')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    return all
      .filter((i) => i.claimedAt === undefined)
      .map((i) => ({ _id: i._id, email: i.email, role: i.role }))
  },
})

export const revokeInvitation = mutation({
  args: {
    businessId: v.id('businesses'),
    invitationId: v.id('invitations'),
  },
  handler: async (ctx, { businessId, invitationId }) => {
    await requireOwner(ctx, businessId)

    const invitation = await ctx.db.get(invitationId)
    if (!invitation || invitation.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    await ctx.db.delete(invitationId)
  },
})

/**
 * Claims every outstanding invitation matching the signed-in user's email.
 * Joining is deliberately the subcontractor's own action rather than something
 * an owner does to them — the same principle as memberships.accept (§1.4).
 */
export const claimInvitations = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx)
    if (!user) throw new ConvexError('UNAUTHENTICATED')

    const email = String(user.email ?? '').toLowerCase()
    if (!email) return []

    const invitations = await ctx.db
      .query('invitations')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()

    const claimed: Array<string> = []

    for (const invitation of invitations) {
      if (invitation.claimedAt !== undefined) continue

      const already = await ctx.db
        .query('memberships')
        .withIndex('by_user_business', (q) =>
          q.eq('userId', user._id).eq('businessId', invitation.businessId),
        )
        .unique()

      if (!already) {
        const members = await ctx.db
          .query('memberships')
          .withIndex('by_business', (q) =>
            q.eq('businessId', invitation.businessId),
          )
          .collect()

        await ctx.db.insert('memberships', {
          userId: user._id,
          businessId: invitation.businessId,
          role: invitation.role,
          canViewAllJobs: false,
          colour: nextColour(members.map((m) => m.colour)),
          status: 'active',
          createdAt: Date.now(),
        })
      } else if (already.status !== 'active') {
        await ctx.db.patch(already._id, { status: 'active' })
      }

      await ctx.db.patch(invitation._id, { claimedAt: Date.now() })
      claimed.push(invitation.businessId)
    }

    return claimed
  },
})

export const invite = mutation({
  args: {
    businessId: v.id('businesses'),
    userId: v.string(),
    role,
  },
  handler: async (ctx, args) => {
    const actor = await requireOwner(ctx, args.businessId)

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

    await ctx.db.insert('auditLog', {
      businessId: args.businessId,
      actorMembershipId: actor._id,
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

    await ctx.db.patch(membership._id, { status: 'active' })

    await ctx.db.insert('auditLog', {
      businessId,
      actorMembershipId: membership._id,
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

    await ctx.db.insert('auditLog', {
      businessId: args.businessId,
      actorMembershipId: actor._id,
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

    await ctx.db.insert('auditLog', {
      businessId: args.businessId,
      actorMembershipId: actor._id,
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

    await ctx.db.insert('auditLog', {
      businessId: args.businessId,
      actorMembershipId: actor._id,
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

    await ctx.db.patch(args.membershipId, {
      licenceNumber: args.licenceNumber,
    })
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

    await ctx.db.patch(actor._id, { viewingAsMembershipId: args.targetMembershipId })
  },
})
