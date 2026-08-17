import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership, requireOwner } from './lib/access'
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

    return members
      .filter((m) => m.status !== 'removed')
      .map((m) => ({
        _id: m._id,
        userId: m.userId,
        role: m.role,
        canViewAllJobs: m.canViewAllJobs,
        licenceNumber: m.licenceNumber,
        colour: m.colour,
        status: m.status,
      }))
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
