import { v } from 'convex/values'
import { query } from './_generated/server'
import { authComponent } from './auth'
import { canViewAs, requireMembership } from './lib/access'

/**
 * Every account the caller is allowed to switch their own view to, per
 * `canViewAs`'s rule — drives the header account menu. Always includes the
 * caller's own account first.
 */
export const listSwitchable = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const caller = await requireMembership(ctx, businessId)

    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    const switchable = [
      caller,
      ...members.filter((m) => m._id !== caller._id && canViewAs(caller, m)),
    ]

    return Promise.all(
      switchable.map(async (m) => {
        const user = await authComponent.getAnyUserById(ctx, m.userId)
        return {
          membershipId: m._id,
          name: user?.name ?? '',
          email: user?.email ?? '',
          role: m.role,
          colour: m.colour,
          isSelf: m._id === caller._id,
        }
      }),
    )
  },
})

/** The caller's own current "view as" selection, if any and still valid —
 * feeds the persistent "Viewing as X" banner. */
export const getViewScope = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const caller = await requireMembership(ctx, businessId)
    if (!caller.viewingAsMembershipId) return { viewingAs: null }

    const target = await ctx.db.get(caller.viewingAsMembershipId)
    if (!target || !canViewAs(caller, target)) return { viewingAs: null }

    const user = await authComponent.getAnyUserById(ctx, target.userId)
    return {
      viewingAs: {
        membershipId: target._id,
        name: user?.name ?? '',
      },
    }
  },
})
