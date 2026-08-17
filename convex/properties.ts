import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { jobVisibility, requireMembership } from './lib/access'

export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)

    return ctx.db
      .query('properties')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
  },
})

export const search = query({
  args: { businessId: v.id('businesses'), q: v.string() },
  handler: async (ctx, { businessId, q }) => {
    await requireMembership(ctx, businessId)

    if (q.trim() === '') {
      return ctx.db
        .query('properties')
        .withIndex('by_business', (idx) => idx.eq('businessId', businessId))
        .take(50)
    }

    return ctx.db
      .query('properties')
      .withSearchIndex('search', (s) =>
        s.search('addressLine', q).eq('businessId', businessId),
      )
      .take(50)
  },
})

export const get = query({
  args: { businessId: v.id('businesses'), propertyId: v.id('properties') },
  handler: async (ctx, { businessId, propertyId }) => {
    await requireMembership(ctx, businessId)

    const property = await ctx.db.get(propertyId)
    // Checking the parent business prevents reading a property by id from
    // another tenant even with a valid membership somewhere.
    if (!property || property.businessId !== businessId) return null
    return property
  },
})

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    clientName: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    addressLine: v.string(),
    suburb: v.string(),
    state: v.string(),
    postcode: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.businessId)
    return ctx.db.insert('properties', { ...args, createdAt: Date.now() })
  },
})

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    propertyId: v.id('properties'),
    clientName: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    addressLine: v.optional(v.string()),
    suburb: v.optional(v.string()),
    state: v.optional(v.string()),
    postcode: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, propertyId, ...patch }) => {
    await requireMembership(ctx, businessId)

    const property = await ctx.db.get(propertyId)
    if (!property || property.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    const fields = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    )
    if (Object.keys(fields).length > 0) await ctx.db.patch(propertyId, fields)
  },
})

/**
 * Job history for a property. Read visibility still applies: a subcontractor
 * without canViewAllJobs sees only their own visits to this address.
 */
export const jobHistory = query({
  args: { businessId: v.id('businesses'), propertyId: v.id('properties') },
  handler: async (ctx, { businessId, propertyId }) => {
    const membership = await requireMembership(ctx, businessId)

    const property = await ctx.db.get(propertyId)
    if (!property || property.businessId !== businessId) return []

    const jobs = await ctx.db
      .query('jobs')
      .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
      .order('desc')
      .collect()

    const visibility = jobVisibility(membership)
    return visibility.scope === 'business'
      ? jobs
      : jobs.filter((j) => j.assignedMembershipId === visibility.membershipId)
  },
})
