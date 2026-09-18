import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import { INLINE_LIMIT, decorate as decorateReports } from './reports'
import { isInScope, reportScope } from './lib/capabilities'
import { clientKind } from './schema'
import type { Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { requireActor, requireCapability } from './lib/actor'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { redactJobs } from './lib/prices'

async function requireClient(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
) {
  const client = await ctx.db.get(clientId)
  if (!client || client.businessId !== businessId) {
    throw new ConvexError('NOT_FOUND')
  }
  return client
}

export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    const visible = await visibleClientIds(ctx, env)

    const clients = await ctx.db
      .query('clients')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    return clients
      .filter((c) => c.archivedAt === undefined)
      .filter((c) => inClientScope(visible, c._id))
  },
})

export const get = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireActor(ctx, businessId)

    const client = await ctx.db.get(clientId)
    if (!client || client.businessId !== businessId) return null
    // Null, not an error: a client they may not see must be indistinguishable
    // from one that is not there.
    const visible = await visibleClientIds(ctx, env)
    return inClientScope(visible, client._id) ? client : null
  },
})

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    clientId: v.id('clients'),
    kind: v.optional(clientKind),
    name: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    addressLine: v.optional(v.string()),
    suburb: v.optional(v.string()),
    state: v.optional(v.string()),
    postcode: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, clientId, ...patch }) => {
    await requireMembership(ctx, businessId)
    await requireClient(ctx, businessId, clientId)

    // Typed explicitly: the optional args really can arrive absent, but
    // `Object.entries` infers them away, which made the filter below read as
    // dead code to the linter while doing necessary work at runtime.
    const fields = Object.fromEntries(
      Object.entries<string | undefined>(patch).filter(
        ([, value]) => value !== undefined,
      ),
    )
    if (Object.keys(fields).length > 0) {
      await ctx.db.patch(clientId, { ...fields, updatedAt: Date.now() })
    }
  },
})

/**
 * Soft-delete, mirroring `customReportTemplates.archivedAt` exactly: removes
 * a client from the "new job"/"new property" pickers only, with zero effect
 * on any property/job/report that already references it.
 */
export const archive = mutation({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    requireCapability(await requireActor(ctx, businessId), 'clients.manage')
    await requireClient(ctx, businessId, clientId)
    await ctx.db.patch(clientId, { archivedAt: Date.now() })
  },
})

export const unarchive = mutation({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    requireCapability(await requireActor(ctx, businessId), 'clients.manage')
    await requireClient(ctx, businessId, clientId)
    await ctx.db.patch(clientId, { archivedAt: undefined })
  },
})

/**
 * Job history across every property this client owns — the fan-out
 * `properties.jobHistory` does for one property, generalised to a client's
 * whole portfolio. Read visibility still applies: a subcontractor without
 * canViewAllJobs sees only their own visits.
 */
export const jobHistory = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const { scope, caps } = await requireActor(ctx, businessId)
    await requireClient(ctx, businessId, clientId)

    const properties = await ctx.db
      .query('properties')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect()

    const jobsByProperty = await Promise.all(
      properties.map((property) =>
        ctx.db
          .query('jobs')
          .withIndex('by_property', (q) => q.eq('propertyId', property._id))
          .collect(),
      ),
    )
    const jobs = jobsByProperty.flat()

    // Redacted like every other job read. These went out raw, so anyone who
    // could open a client could read what each of their own visits was
    // charged at whether or not they may see prices — and with the client
    // book open to everyone, that is anyone.
    return redactJobs(
      caps,
      jobs
        .filter((j) => isInScope(scope, j))
        .sort((a, b) => b.scheduledAt - a.scheduledAt),
    )
  },
})

/**
 * Reports across every property this client owns, through the same
 * `reportScope` gate and `decorate()` row shape `reports.listByProperty` uses
 * for one property — so the client sheet and the property sheet can never
 * disagree about which reports someone may see.
 */
export const reports = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const { scope } = await requireActor(ctx, businessId)
    await requireClient(ctx, businessId, clientId)

    const properties = await ctx.db
      .query('properties')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect()

    const reportsByProperty = await Promise.all(
      properties.map((property) =>
        ctx.db
          .query('reports')
          .withIndex('by_property', (q) => q.eq('propertyId', property._id))
          .collect(),
      ),
    )

    const visible = reportsByProperty
      .flat()
      .filter(
        (r) =>
          r.businessId === businessId &&
          r.deletedAt === undefined &&
          reportScope(scope, r),
      )
      .sort((a, b) => (b.finalisedAt ?? b.createdAt) - (a.finalisedAt ?? a.createdAt))
      // Bounded: this is a section inside a sheet. The library holds the rest.
      .slice(0, INLINE_LIMIT)

    // The same decoration the library gives a row, so a report is named the
    // same thing wherever it is listed.
    return decorateReports(ctx, visible)
  },
})
