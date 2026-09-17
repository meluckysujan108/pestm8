import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { getAuthUserId, requireMembership } from './lib/access'
import { DEFAULT_GRANTS } from './lib/capabilities'
import { MEMBER_COLOURS } from './lib/colours'
import { forSelf, recordAudit } from './lib/audit'
import { requireActor, requireCapability } from './lib/actor'

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
      const logoUrl = business.logoStorageId
        ? await ctx.storage.getUrl(business.logoStorageId)
        : null
      return {
        _id: business._id,
        name: business.name,
        slug: business.slug,
        state: business.state,
        timezone: business.timezone,
        abn: business.abn,
        addressLine: business.addressLine,
        suburb: business.suburb,
        postcode: business.postcode,
        phone: business.phone,
        email: business.email,
        licenceNumber: business.licenceNumber,
        logoUrl,
        membership: {
          _id: membership._id,
          role: membership.role,
          canViewAllJobs: membership.canViewAllJobs,
          colour: membership.colour,
          licenceNumber: membership.licenceNumber,
          phone: membership.phone,
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
      // Written rather than left to be derived. `grantsFromMembership` would
      // fill these in from `canViewAllJobs`, which is the fallback the
      // migration exists to stop needing — a row created after it ran would
      // otherwise put the deployment straight back into the state it just
      // left, and the legacy column could never be dropped.
      grants: DEFAULT_GRANTS.owner,
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
    logoStorageId: v.optional(v.id('_storage')),
    addressLine: v.optional(v.string()),
    suburb: v.optional(v.string()),
    postcode: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    licenceNumber: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, ...patch }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'business.manage')
    const actor = env.actor.real

    const fields = Object.fromEntries(
      Object.entries(patch as Record<string, unknown>).filter(
        ([, value]) => value !== undefined,
      ),
    )
    if (Object.keys(fields).length > 0) {
      await ctx.db.patch(businessId, fields)

      // ABN, licence number and trading name are printed on compliance
      // documents. Who changed them, and when, is part of the record.
      await recordAudit(ctx, forSelf(actor._id), {
        businessId,
        action: 'business.update',
        entityType: 'businesses',
        entityId: businessId,
        meta: { fields: Object.keys(fields) },
        at: Date.now(),
      })
    }
  },
})

/** Short-lived upload URL for the business logo — owner-gated, since only the
 * owner can change branding via `update` above. */
export const generateUploadUrl = mutation({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    requireCapability(await requireActor(ctx, businessId), 'business.manage')
    return ctx.storage.generateUploadUrl()
  },
})
