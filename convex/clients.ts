import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import { normaliseAbn } from './lib/abn'
import { normaliseEmail } from './lib/email'
import { normalisePhone } from './lib/phone'
import { edited, setContactPerson } from './clientContacts'
import { INLINE_LIMIT, decorate as decorateReports } from './reports'
import { isInScope, reportReadable } from './lib/capabilities'
import { clientKind, clientStatus } from './schema'
import {
  clientWithNumber,
  isClientNumber,
  normaliseTags,
} from './lib/clientRecord'
import type { Doc, Id } from './_generated/dataModel'
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

const CLEARABLE = [
  'phone',
  'email',
  'addressLine',
  'suburb',
  'state',
  'postcode',
] as const

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
    // Prompt 6.1. A blank string clears it; leaving it out leaves it alone.
    // Validated whatever the kind: the form sends it only for a business, and
    // a flipped client keeps it hidden rather than losing it.
    abn: v.optional(v.string()),
    // The name to make this client's primary contact — see
    // `setContactPerson`. Blank takes the star off; nobody is deleted.
    contactPerson: v.optional(v.string()),
    // Each left alone when left out. An empty list clears the tags.
    status: v.optional(clientStatus),
    tags: v.optional(v.array(v.string())),
    // Unique within the business: another client's is refused
    // (CLIENT_NUMBER_TAKEN) rather than silently swapped.
    clientNumber: v.optional(v.number()),
  },
  handler: async (
    ctx,
    {
      businessId,
      clientId,
      abn: rawAbn,
      contactPerson,
      status,
      tags: rawTags,
      clientNumber,
      ...patch
    },
  ) => {
    await requireMembership(ctx, businessId)
    const client = await requireClient(ctx, businessId, clientId)

    // Typed explicitly: the optional args really can arrive absent, but
    // `Object.entries` infers them away, which made the filter below read as
    // dead code to the linter while doing necessary work at runtime.
    const fields: Record<string, string | undefined> = Object.fromEntries(
      Object.entries<string | undefined>(patch).filter(
        ([, value]) => value !== undefined,
      ),
    )
    // A blank contact detail or head-office line clears it: written as
    // `undefined`, which is how a patch removes a field. The edit form used to
    // have no way to take a number or an address off at all, and saved as if
    // it had. (Earlier frontends never send a blank: they leave a field out.)
    for (const key of CLEARABLE) {
      if (fields[key]?.trim() === '') fields[key] = undefined
    }
    // Checked only when this save changes it: the edit form sends every
    // field, and a client saved before these rules must stay editable without
    // first having an old address or number fixed. A new email is also
    // stored the one way (`normaliseEmail`), since it becomes a report
    // recipient.
    if (fields.email !== undefined && edited(fields.email, client.email)) {
      fields.email = normaliseEmail(fields.email)
    }
    if (fields.phone !== undefined && edited(fields.phone, client.phone)) {
      fields.phone = normalisePhone(fields.phone)
    }
    // Refused before anything is written. Stored as `undefined` when cleared —
    // how a patch removes a field — and left out when unchanged.
    if (rawAbn !== undefined) {
      const abn = normaliseAbn(rawAbn)
      if (abn !== client.abn) fields.abn = abn
    }
    const record: {
      status?: Doc<'clients'>['status']
      tags?: Array<string>
      clientNumber?: number
    } = {}
    if (status !== undefined && status !== (client.status ?? 'active')) {
      record.status = status
    }
    if (rawTags !== undefined) {
      const tags = normaliseTags(rawTags)
      if (tags.join('\n') !== (client.tags ?? []).join('\n')) {
        // Empty is none: written as `undefined`, which removes the field.
        record.tags = tags.length > 0 ? tags : undefined
      }
    }
    if (clientNumber !== undefined && clientNumber !== client.clientNumber) {
      if (!isClientNumber(clientNumber)) {
        throw new ConvexError('INVALID_CLIENT_NUMBER')
      }
      const holder = await clientWithNumber(ctx, businessId, clientNumber)
      if (holder && holder._id !== clientId) {
        throw new ConvexError('CLIENT_NUMBER_TAKEN')
      }
      record.clientNumber = clientNumber
    }
    if (Object.keys(fields).length > 0 || Object.keys(record).length > 0) {
      await ctx.db.patch(clientId, {
        ...fields,
        ...record,
        updatedAt: Date.now(),
      })
    }
    if (contactPerson !== undefined) {
      await setContactPerson(ctx, businessId, clientId, contactPerson)
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
 * `reportReadable` gate and `decorate()` row shape `reports.listByProperty` uses
 * for one property — so the client sheet and the property sheet can never
 * disagree about which reports someone may see.
 */
export const reports = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const { actor, scope } = await requireActor(ctx, businessId)
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
          reportReadable(scope, actor.real._id, r),
      )
      .sort((a, b) => (b.finalisedAt ?? b.createdAt) - (a.finalisedAt ?? a.createdAt))
      // Bounded: this is a section inside a sheet. The library holds the rest.
      .slice(0, INLINE_LIMIT)

    // The same decoration the library gives a row, so a report is named the
    // same thing wherever it is listed.
    return decorateReports(ctx, visible)
  },
})
