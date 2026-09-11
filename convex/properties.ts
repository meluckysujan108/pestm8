import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { jobVisibility, requireMembership, resolveViewScope } from './lib/access'
import { clientKind } from './schema'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'

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

/** The shape every "create a brand-new client" entry point needs — the
 * client-facing counterpart of `properties.create`'s own args, minus
 * `businessId` (the caller already has it). Reused by
 * `jobs.create`/`recurrences.create` so booking a job for a client that
 * doesn't exist yet needs one submit, not a trip to the Clients page first. */
export const newClientFields = v.object({
  clientName: v.string(),
  // Defaults to 'person' so every existing caller (which never passes this)
  // behaves exactly as before.
  kind: v.optional(clientKind),
  phone: v.optional(v.string()),
  email: v.optional(v.string()),
  addressLine: v.string(),
  suburb: v.string(),
  state: v.string(),
  postcode: v.string(),
})

async function insertClientAndProperty(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  input: {
    clientName: string
    kind?: 'person' | 'business'
    phone?: string
    email?: string
    addressLine: string
    suburb: string
    state: string
    postcode: string
  },
): Promise<Id<'properties'>> {
  const now = Date.now()
  const clientId = await ctx.db.insert('clients', {
    businessId,
    kind: input.kind ?? 'person',
    name: input.clientName,
    phone: input.phone,
    email: input.email,
    createdAt: now,
    updatedAt: now,
  })
  return ctx.db.insert('properties', {
    businessId,
    clientId,
    addressLine: input.addressLine,
    suburb: input.suburb,
    state: input.state,
    postcode: input.postcode,
    createdAt: now,
  })
}

/**
 * Resolves a job/recurrence's property from either an existing id or inline
 * new-client fields, inserting the client+property in the same mutation when
 * it's the latter — Convex mutations are transactional, so this can never
 * leave an orphaned client behind if the rest of the caller's insert fails.
 */
export async function resolvePropertyId(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  input: {
    propertyId?: Id<'properties'>
    newClient?: {
      clientName: string
      kind?: 'person' | 'business'
      phone?: string
      email?: string
      addressLine: string
      suburb: string
      state: string
      postcode: string
    }
  },
): Promise<Id<'properties'>> {
  if (input.propertyId !== undefined) {
    const property = await ctx.db.get(input.propertyId)
    if (!property || property.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    return input.propertyId
  }

  if (!input.newClient) throw new ConvexError('MISSING_PROPERTY')
  return insertClientAndProperty(ctx, businessId, input.newClient)
}

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    clientName: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    kind: v.optional(clientKind),
    addressLine: v.string(),
    suburb: v.string(),
    state: v.string(),
    postcode: v.string(),
  },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.businessId)
    return insertClientAndProperty(ctx, args.businessId, args)
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
    const membership = await resolveViewScope(ctx, businessId)

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
