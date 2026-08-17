import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'

export const listOpen = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const membership = await requireMembership(ctx, businessId)

    const open = await ctx.db
      .query('tasks')
      .withIndex('by_business_done', (q) =>
        q.eq('businessId', businessId).eq('done', false),
      )
      .collect()

    // Owners see every outstanding follow-up; everyone else sees their own.
    return membership.role === 'owner'
      ? open
      : open.filter((t) => t.assignedMembershipId === membership._id)
  },
})

export const complete = mutation({
  args: { businessId: v.id('businesses'), taskId: v.id('tasks') },
  handler: async (ctx, { businessId, taskId }) => {
    const membership = await requireMembership(ctx, businessId)

    const task = await ctx.db.get(taskId)
    if (!task || task.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (
      membership.role !== 'owner' &&
      task.assignedMembershipId !== membership._id
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    await ctx.db.patch(taskId, { done: true, doneAt: Date.now() })
  },
})
