import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { jobVisibility, requireMembership } from './lib/access'
import { clientKind } from './schema'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'

/** Embeds the owning client alongside a property — the detail-view shape
 * (mirrors how `jobs.get` embeds `assignee`/`property` wholesale). */
export async function withClient<T extends Doc<'properties'>>(ctx: QueryCtx, property: T) {
  const client = await ctx.db.get(property.clientId)
  return { ...property, client }
}

/** A property's owning client's name only, for list rows that flatten to a
 * summary string rather than embedding a whole nested object (mirrors how
 * `jobs.ts`'s `decorate()` flattens `assignee` down to `assigneeColour`). */
export async function clientNameOf(
  ctx: QueryCtx,
  property: Doc<'properties'> | null | undefined,
): Promise<string> {
  if (!property) return ''
  const client = await ctx.db.get(property.clientId)
  return client?.name ?? ''
}

export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)

    const properties = await ctx.db
      .query('properties')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    return Promise.all(properties.map((p) => withClient(ctx, p)))
  },
})

export const search = query({
  args: { businessId: v.id('businesses'), q: v.string() },
  handler: async (ctx, { businessId, q }) => {
    await requireMembership(ctx, businessId)

    const properties =
      q.trim() === ''
        ? await ctx.db
            .query('properties')
            .withIndex('by_business', (idx) => idx.eq('businessId', businessId))
            .take(50)
        : await ctx.db
            .query('properties')
            .withSearchIndex('search', (s) =>
              s.search('addressLine', q).eq('businessId', businessId),
            )
            .take(50)
    return Promise.all(properties.map((p) => withClient(ctx, p)))
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
    return withClient(ctx, property)
  },
})

/** Every property a given client owns — used by the client detail sheet's
 * Properties section and by `createForClient` callers that need the
 * up-to-date list after adding one. */
export const listByClient = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    await requireMembership(ctx, businessId)

    const client = await ctx.db.get(clientId)
    if (!client || client.businessId !== businessId) return []

    return ctx.db
      .query('properties')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect()
  },
})

/** Adds another property to an existing client — the client detail sheet's
 * "add another property" action, distinct from `create` which makes a new
 * client and its first property together in one step. */
export const createForClient = mutation({
  args: {
    businessId: v.id('businesses'),
    clientId: v.id('clients'),
    addressLine: v.string(),
    suburb: v.string(),
    state: v.string(),
    postcode: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, clientId, ...address }) => {
    await requireMembership(ctx, businessId)

    const client = await ctx.db.get(clientId)
    if (!client || client.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    return ctx.db.insert('properties', {
      businessId,
      clientId,
      ...address,
      createdAt: Date.now(),
    })
  },
})

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    clientName: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    // Defaults to 'person' so every existing caller (which never passes this)
    // behaves exactly as before.
    kind: v.optional(clientKind),
    addressLine: v.string(),
    suburb: v.string(),
    state: v.string(),
    postcode: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.businessId)
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId: args.businessId,
      kind: args.kind ?? 'person',
      name: args.clientName,
      phone: args.phone,
      email: args.email,
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId: args.businessId,
      clientId,
      addressLine: args.addressLine,
      suburb: args.suburb,
      state: args.state,
      postcode: args.postcode,
      notes: args.notes,
      createdAt: now,
    })
  },
})

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    propertyId: v.id('properties'),
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
