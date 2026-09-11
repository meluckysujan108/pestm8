import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import {
  jobVisibility,
  requireMembership,
  resolveViewScope,
} from './lib/access'
import { clientNameOf } from './properties'

export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const real = await requireMembership(ctx, businessId)
    const viewScope = await resolveViewScope(ctx, businessId)

    const notes = await ctx.db
      .query('notes')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .collect()

    const visibility = jobVisibility(viewScope)
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
          clientName: await clientNameOf(ctx, property),
          suburb: property?.suburb,
          authorColour: author?.colour ?? '#8E8E93',
          // Always the REAL caller — read access granted by "view as" never
          // implies "this is something you wrote" or can delete.
          mine: note.authorMembershipId === real._id,
        }
      }),
    )
  },
})

/**
 * Notes attached to one job, newest first — with the author's actual name
 * resolved, not just their colour. Two different technicians (or an owner)
 * leaving notes on the same job need to be told apart by who they are, the
 * same name-resolution `memberships.listForBusiness` already does.
 */
export const listForJob = query({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const real = await requireMembership(ctx, businessId)
    const viewScope = await resolveViewScope(ctx, businessId)

    const notes = await ctx.db
      .query('notes')
      .withIndex('by_job', (q) => q.eq('jobId', jobId))
      .order('desc')
      .collect()

    const visible = notes.filter((n) => n.businessId === businessId)
    const visibility = jobVisibility(viewScope)
    const scoped =
      visibility.scope === 'business'
        ? visible
        : visible.filter(
            (n) => n.authorMembershipId === visibility.membershipId,
          )

    return Promise.all(
      scoped.map(async (note) => {
        const author = await ctx.db.get(note.authorMembershipId)
        const user = author
          ? await authComponent.getAnyUserById(ctx, author.userId)
          : null
        return {
          ...note,
          authorName: user?.name ?? 'Unknown',
          authorRole: author?.role,
          authorColour: author?.colour ?? '#8E8E93',
          mine: note.authorMembershipId === real._id,
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
