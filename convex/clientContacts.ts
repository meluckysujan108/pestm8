import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'

export const list = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    await requireMembership(ctx, businessId)

    const client = await ctx.db.get(clientId)
    if (!client || client.businessId !== businessId) return []

    return ctx.db
      .query('clientContacts')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect()
  },
})

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    clientId: v.id('clients'),
    name: v.string(),
    role: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, clientId, ...rest }) => {
    await requireMembership(ctx, businessId)

    const client = await ctx.db.get(clientId)
    if (!client || client.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    return ctx.db.insert('clientContacts', {
      businessId,
      clientId,
      ...rest,
      createdAt: Date.now(),
    })
  },
})

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    contactId: v.id('clientContacts'),
    name: v.optional(v.string()),
    role: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, contactId, ...patch }) => {
    await requireMembership(ctx, businessId)

    const contact = await ctx.db.get(contactId)
    if (!contact || contact.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    const fields = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    )
    if (Object.keys(fields).length > 0) await ctx.db.patch(contactId, fields)
  },
})

export const remove = mutation({
  args: { businessId: v.id('businesses'), contactId: v.id('clientContacts') },
  handler: async (ctx, { businessId, contactId }) => {
    await requireMembership(ctx, businessId)

    const contact = await ctx.db.get(contactId)
    if (!contact || contact.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    await ctx.db.delete(contactId)
  },
})
