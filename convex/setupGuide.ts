import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireActor, requireCapability } from './lib/actor'

/**
 * The set-up guide: what a new business still has to do before PestM8 is
 * doing its job, shown to its owner at the top of the schedule.
 *
 * Every item is read off the business as it stands, never ticked by hand, so
 * it cannot drift: the logo is there or it is not, a job has been booked or
 * it has not. The first item is always done — the business exists — which is
 * a head start people finish more often from than a list at zero.
 *
 * Only a business made by the set-up flow (`businesses.setup`) has a guide.
 * One that was running before it has nothing to be guided through.
 */

export type SetupGuideItem =
  | 'business'
  | 'letterhead'
  | 'licence'
  | 'clients'
  | 'firstJob'
  | 'firstReport'
  | 'team'

export const progress = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    // The owner's to do, and not while switched into someone else's account.
    // Everyone else gets nothing, rather than a refusal on the schedule.
    if (!env.caps['business.manage']) return null

    const business = await ctx.db.get(businessId)
    const setup = business?.setup
    if (!business || !setup) return null

    const owner = await ctx.db.get(env.actor.real._id)

    const client = await ctx.db
      .query('clients')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .first()
    const job = await ctx.db
      .query('jobs')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .first()
    const finalised = await ctx.db
      .query('reports')
      .withIndex('by_business_status_template', (q) =>
        q.eq('businessId', businessId).eq('status', 'finalised'),
      )
      .first()

    const items: Array<{ key: SetupGuideItem; done: boolean }> = [
      { key: 'business', done: true },
      {
        key: 'letterhead',
        // The two things a client reads first at the top of the page.
        done:
          business.logoStorageId !== undefined &&
          Boolean(business.phone?.trim() || business.email?.trim()),
      },
      { key: 'licence', done: Boolean(owner?.licenceNumber?.trim()) },
      // Before the first job, which needs someone to book it for. Brought
      // across from the old app or added one at a time, either way counts.
      { key: 'clients', done: client !== null },
      { key: 'firstJob', done: job !== null },
      { key: 'firstReport', done: finalised !== null },
    ]

    // Only for an owner who said others work with them. Done once anyone is
    // asked: an invitation sent is the owner's part, whether or not it has
    // been taken up yet — but not one they have since withdrawn.
    if (setup.team === 'team') {
      const invitations = await ctx.db
        .query('invitations')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .take(20)
      const invited = invitations.some((row) => row.revokedAt === undefined)
      const members = await ctx.db
        .query('memberships')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .take(10)
      const someoneElse = members.some(
        (m) => m._id !== env.actor.real._id && m.status !== 'removed',
      )
      items.push({ key: 'team', done: invited || someoneElse })
    }

    return { items, hidden: setup.guideHiddenAt !== undefined }
  },
})

/** Puts the guide away, or brings it back from Settings. */
export const setHidden = mutation({
  args: { businessId: v.id('businesses'), hidden: v.boolean() },
  handler: async (ctx, { businessId, hidden }) => {
    requireCapability(await requireActor(ctx, businessId), 'business.manage')
    const business = await ctx.db.get(businessId)
    if (!business) throw new ConvexError('NOT_FOUND')
    if (!business.setup) return

    const { guideHiddenAt: _was, ...rest } = business.setup
    await ctx.db.patch(businessId, {
      setup: hidden ? { ...rest, guideHiddenAt: Date.now() } : rest,
    })
  },
})
