import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import { requireActor, requireCapability } from './lib/actor'

/**
 * "Kevin joined your team" — told to the owner on the schedule, where the
 * next thing to do about it is: give Kevin a job.
 *
 * A join is the moment a business's second person is ready to work, and it
 * happens on someone else's phone, so the owner otherwise finds out only by
 * looking at the Team page. Shown until the owner puts it away (`dismiss`),
 * and only for the last fortnight: an old join is not news.
 */

/**
 * Joins from before these notices existed are not news: every membership
 * already on file starts with no `joinSeenAt`, and without this floor a
 * release would greet owners with "joined" notices for people they have
 * worked with for a week — the demo business's seeded team among them. It
 * stops mattering a fortnight after release, when the window passes it.
 */
const NOTICES_FROM = Date.UTC(2026, 8, 26, 6, 0) // 26 Sep 2026, 2 pm Perth

/**
 * A rejoin is not news either: a returning member's row is made active again
 * with its original `createdAt` (invitations.redeemByHash), so it falls
 * outside the window — accepted, as the owner re-invited them themselves.
 *
 * `since` is the start of the window, worked out by the caller — a query does
 * not read the clock — as the start of the UTC day a fortnight ago
 * (`joinWindowStart` in src/lib/routeQueries.ts), so a page's loader and its
 * render share one answer all day.
 */
export const recent = query({
  args: { businessId: v.id('businesses'), since: v.number() },
  handler: async (ctx, { businessId, since }) => {
    const env = await requireActor(ctx, businessId)
    // The owner's news; nobody else is asked, and nobody else is refused.
    if (!env.caps['business.manage']) return []

    // Newest first: a business that has had many people (the removed stay
    // on the table) must still find this week's.
    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .take(200)
    const from = Math.max(since, NOTICES_FROM)

    const joined = members
      .filter(
        (m) =>
          m.status === 'active' &&
          m.role !== 'owner' &&
          m.createdAt >= from &&
          m.joinSeenAt === undefined,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 3)

    return Promise.all(
      joined.map(async (m) => {
        const user = await authComponent.getAnyUserById(ctx, m.userId)
        return {
          membershipId: m._id,
          name: m.displayName || user?.name || user?.email || 'Someone',
          role: m.role,
          colour: m.colour,
          joinedAt: m.createdAt,
        }
      }),
    )
  },
})

/** Puts one join notice away, on every device. */
export const dismiss = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
  },
  handler: async (ctx, { businessId, membershipId }) => {
    requireCapability(await requireActor(ctx, businessId), 'business.manage')
    const member = await ctx.db.get(membershipId)
    if (!member || member.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (member.joinSeenAt !== undefined) return
    await ctx.db.patch(membershipId, { joinSeenAt: Date.now() })
  },
})
