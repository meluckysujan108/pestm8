import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { jobVisibility, requireMembership } from './lib/access'

export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const membership = await requireMembership(ctx, businessId)

    const notes = await ctx.db
      .query('notes')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .collect()

    const visibility = jobVisibility(membership)
    const visible =
      visibility.scope === 'business'
        ? notes
        : notes.filter((n) => n.authorMembershipId === visibility.membershipId)

    return Promise.all(
      visible.map(async (note) => {
        const property = note.propertyId
          ? await ctx.db.get(note.propertyId)
          : null
        const author = await ctx.db.get(note.authorMembershipId)
        return {
          ...note,
          clientName: property?.clientName,
          suburb: property?.suburb,
          authorColour: author?.colour ?? '#8E8E93',
          mine: note.authorMembershipId === membership._id,
        }
      }),
    )
  },
})

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    text: v.string(),
    jobId: v.optional(v.id('jobs')),
    propertyId: v.optional(v.id('properties')),
  },
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.businessId)

    if (args.text.trim() === '') throw new ConvexError('EMPTY_NOTE')

    if (args.propertyId) {
      const property = await ctx.db.get(args.propertyId)
      if (!property || property.businessId !== args.businessId) {
        throw new ConvexError('NOT_FOUND')
      }
    }

    return ctx.db.insert('notes', {
      businessId: args.businessId,
      authorMembershipId: membership._id,
      jobId: args.jobId,
      propertyId: args.propertyId,
      text: args.text.trim(),
      createdAt: Date.now(),
    })
  },
})

export const remove = mutation({
  args: { businessId: v.id('businesses'), noteId: v.id('notes') },
  handler: async (ctx, { businessId, noteId }) => {
    const membership = await requireMembership(ctx, businessId)

    const note = await ctx.db.get(noteId)
    if (!note || note.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    // Owners tidy the board; everyone else only removes what they wrote.
    if (
      membership.role !== 'owner' &&
      note.authorMembershipId !== membership._id
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    await ctx.db.delete(noteId)
  },
})
