import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { getAuthUserId, requireMembership, requireOwner } from './lib/access'
import { MEMBER_COLOURS } from './lib/colours'

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    const active = memberships.filter((m) => m.status === 'active')

    return Promise.all(
      active.map(async (m) => {
        const business = await ctx.db.get(m.businessId)
        return {
          membershipId: m._id,
          role: m.role,
          canViewAllJobs: m.canViewAllJobs,
          businessId: m.businessId,
          name: business?.name ?? '',
          slug: business?.slug ?? '',
        }
      }),
    )
  },
})

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const business = await ctx.db
      .query('businesses')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique()

    // Resolving the slug before membership would let a non-member probe which
    // slugs exist, so a miss and a non-membership return the same shape.
    if (!business) return null

    try {
      const membership = await requireMembership(ctx, business._id)
      return {
        _id: business._id,
        name: business.name,
        slug: business.slug,
        state: business.state,
        timezone: business.timezone,
        membership: {
          _id: membership._id,
          role: membership.role,
          canViewAllJobs: membership.canViewAllJobs,
          colour: membership.colour,
          licenceNumber: membership.licenceNumber,
        },
      }
    } catch {
      return null
    }
  },
})

export const create = mutation({
  args: {
    name: v.string(),
    state: v.string(),
    timezone: v.string(),
    abn: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx)

    const base = slugify(args.name)
    if (!base) throw new ConvexError('INVALID_NAME')

    let slug = base
    let n = 1
    while (
      await ctx.db
        .query('businesses')
        .withIndex('by_slug', (q) => q.eq('slug', slug))
        .unique()
    ) {
      slug = `${base}-${++n}`
    }

    const now = Date.now()
    const businessId = await ctx.db.insert('businesses', {
      name: args.name,
      slug,
      state: args.state,
      timezone: args.timezone,
      abn: args.abn,
      subscriptionStatus: 'trialing',
      createdAt: now,
    })

    await ctx.db.insert('memberships', {
      userId,
      businessId,
      role: 'owner',
      canViewAllJobs: true,
      colour: MEMBER_COLOURS[0],
      status: 'active',
      createdAt: now,
    })

    return { businessId, slug }
  },
})

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    name: v.optional(v.string()),
    state: v.optional(v.string()),
    timezone: v.optional(v.string()),
    abn: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, ...patch }) => {
    await requireOwner(ctx, businessId)

    const fields = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    )
    if (Object.keys(fields).length > 0) {
      await ctx.db.patch(businessId, fields)
    }
  },
})
