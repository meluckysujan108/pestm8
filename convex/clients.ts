import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import { normaliseAbn } from './lib/abn'
import { normaliseEmail } from './lib/email'
import { normalisePhone } from './lib/phone'
import { edited, setContactPerson } from './clientContacts'
import {
  INLINE_LIMIT,
  decorate as decorateReports,
  reportChips,
} from './reports'
import { isInScope, reportReadable } from './lib/capabilities'
import type { RowScope } from './lib/capabilities'
import { clientKind, clientStatus } from './schema'
import {
  claimClientNumber,
  clientWithNumber,
  isClientNumber,
  normaliseTags,
} from './lib/clientRecord'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { requireActor, requireCapability } from './lib/actor'
import type { ActorEnvelope } from './lib/actor'
import { intervalOf } from './lib/recurrence'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { redactJobs } from './lib/prices'
import { unbinned } from './lib/bin'

async function requireClient(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
) {
  // A client in the Recycle bin reads as gone, and is not edited until it is
  // restored (lib/bin.ts).
  const client = unbinned(await ctx.db.get(clientId))
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
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
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

    const client = unbinned(await ctx.db.get(clientId))
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
    // (CLIENT_NUMBER_TAKEN) rather than silently swapped. The owner's alone
    // to change (NO_ACCESS otherwise): numbers are given automatically, and
    // changed by hand only to match an old system.
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
      // The owner, as themselves: switched into someone else's account,
      // `business.manage` is off, as it is for every admin change.
      requireCapability(await requireActor(ctx, businessId), 'business.manage')
      if (!isClientNumber(clientNumber)) {
        throw new ConvexError('INVALID_CLIENT_NUMBER')
      }
      const holder = await clientWithNumber(ctx, businessId, clientNumber)
      if (holder && holder._id !== clientId) {
        throw new ConvexError('CLIENT_NUMBER_TAKEN')
      }
      record.clientNumber = clientNumber
      // Past the count, so it is not handed to the next new client too.
      await claimClientNumber(ctx, businessId, clientNumber)
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
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
      .collect()

    const jobsByProperty = await Promise.all(
      properties.map((property) =>
        ctx.db
          .query('jobs')
          .withIndex('by_property', (q) => q.eq('propertyId', property._id))
          .filter((q) => q.eq(q.field('deletedAt'), undefined))
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
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
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

/**
 * The most of a property's visits the client sheet reads: the newest made
 * first, so what drops off a very long history is its oldest end. Projected
 * visits are made last, so a recurring client's next six months always fit.
 */
export const SUMMARY_VISITS_PER_PROPERTY = 400

/** The same for a property's reports, newest first. */
export const SUMMARY_REPORTS_PER_PROPERTY = 100

/** Past this, a client's properties are not all summarised (none has come close). */
const SUMMARY_PROPERTIES = 50

/**
 * The client, if the caller may see them: null otherwise, as `get` answers,
 * so one they may not see is indistinguishable from one that is not there.
 */
async function visibleClient(
  ctx: QueryCtx,
  env: ActorEnvelope,
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
) {
  const client = unbinned(await ctx.db.get(clientId))
  if (!client || client.businessId !== businessId) return null
  const visible = await visibleClientIds(ctx, env)
  return inClientScope(visible, client._id) ? client : null
}

/**
 * The client's properties, oldest first — the newest `SUMMARY_PROPERTIES` of
 * them when there are more, and `capped` to say so.
 */
async function propertiesOf(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
) {
  const newest = await ctx.db
    .query('properties')
    .withIndex('by_client', (q) => q.eq('clientId', clientId))
    .order('desc')
    .filter((q) => q.eq(q.field('deletedAt'), undefined))
    .take(SUMMARY_PROPERTIES + 1)
  return {
    properties: newest
      .slice(0, SUMMARY_PROPERTIES)
      .filter((p) => p.businessId === businessId)
      .reverse(),
    capped: newest.length > SUMMARY_PROPERTIES,
  }
}

/**
 * Whose rows a scope admits — null for the whole business — so a read can
 * keep to them before it is cut short: otherwise the rows of people the
 * caller may not see would fill the window, and "there are more" would count
 * them.
 */
function scopeMembers(scope: RowScope): ReadonlyArray<Id<'memberships'>> | null {
  if (scope.kind === 'business') return null
  return scope.kind === 'own' ? [scope.membershipId] : scope.membershipIds
}

/**
 * A client's work, for the Jobs tab of their sheet: their properties, the
 * recurring services at them, and every visit, each cut to what a row shows.
 *
 * Raw rather than worked out: which visit is next, what is overdue, what
 * counts as done are the sheet's to decide (src/lib/clientJobs.ts), against
 * the day it is where the business is. So nothing here reads the clock, and
 * the answer only changes when a visit does. No price leaves: the sheet
 * shows none, so there is nothing to redact.
 *
 * Scoped as every job read is: a subcontractor sees their own visits and
 * services, and counts made from what they see — nor learns of the rest
 * from the numbers.
 */
export const summary = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireActor(ctx, businessId)
    if (!(await visibleClient(ctx, env, businessId, clientId))) return null
    const sites = await propertiesOf(ctx, businessId, clientId)
    const properties = sites.properties
    const assignees = scopeMembers(env.scope)

    const perProperty = await Promise.all(
      properties.map(async (property) => {
        const [series, jobs] = await Promise.all([
          ctx.db
            .query('recurrences')
            .withIndex('by_property', (q) => q.eq('propertyId', property._id))
            .filter((q) => q.eq(q.field('deletedAt'), undefined))
            .take(SUMMARY_PROPERTIES),
          ctx.db
            .query('jobs')
            .withIndex('by_property', (q) => q.eq('propertyId', property._id))
            .order('desc')
            .filter((q) =>
              q.and(
                q.eq(q.field('deletedAt'), undefined),
                assignees === null
                  ? true
                  : q.or(
                      ...assignees.map((id) =>
                        q.eq(q.field('assignedMembershipId'), id),
                      ),
                    ),
              ),
            )
            .take(SUMMARY_VISITS_PER_PROPERTY + 1),
        ])
        return {
          series,
          jobs: jobs.slice(0, SUMMARY_VISITS_PER_PROPERTY),
          capped: jobs.length > SUMMARY_VISITS_PER_PROPERTY,
        }
      }),
    )

    const series = perProperty
      .flatMap((p) => p.series)
      .filter((r) => r.businessId === businessId && isInScope(env.scope, r))
    const visits = perProperty
      .flatMap((p) => p.jobs)
      .filter((j) => j.businessId === businessId && isInScope(env.scope, j))

    // The latest occurrence each running service has used, whoever's visit
    // it is and whether it is in the Recycle bin: the engine books none of
    // them again (recurrences.materialiseOne), so when one is next due is
    // counted from here — a yearly service done early is not due again on
    // its old date. The newest made are the latest projected.
    const lastTaken = new Map(
      await Promise.all(
        series
          .filter((r) => r.active)
          .map(async (r) => {
            const recent = await ctx.db
              .query('jobs')
              .withIndex('by_recurrence', (q) => q.eq('recurrenceId', r._id))
              .order('desc')
              .take(20)
            const taken = recent.map((j) => j.occurrenceAt ?? j.scheduledAt)
            return [r._id, taken.length > 0 ? Math.max(...taken) : undefined] as const
          }),
      ),
    )

    return {
      properties: properties.map((p) => ({
        _id: p._id,
        addressLine: p.addressLine,
        suburb: p.suburb,
      })),
      series: series.map((r) => ({
        _id: r._id,
        jobType: r.jobType,
        interval: intervalOf(r),
        active: r.active,
        propertyId: r.propertyId,
        assignedMembershipId: r.assignedMembershipId,
        anchorDate: r.anchorDate,
        lastTaken: lastTaken.get(r._id),
      })),
      visits: visits.map((j) => ({
        _id: j._id,
        jobNumber: j.jobNumber,
        scheduledAt: j.scheduledAt,
        status: j.status,
        jobType: j.jobType,
        propertyId: j.propertyId,
        recurrenceId: j.recurrenceId,
        occurrenceAt: j.occurrenceAt,
        assignedMembershipId: j.assignedMembershipId,
      })),
      // Some property's history was longer than was read: the sheet says
      // its oldest visits are not all shown.
      capped: perProperty.some((p) => p.capped),
      // More properties than were read: the sheet says so.
      sitesCapped: sites.capped,
    }
  },
})

/**
 * A client's reports, to sit under the visits they came from on the Jobs tab
 * — kept apart from `summary` because a draft being written saves every few
 * seconds, and each save would otherwise send every visit again.
 *
 * Through the same `reportReadable` gate as every report list, newest first.
 * Bounded per property; `capped` says when some were left out, and the
 * sheet points to Reports for them.
 */
export const visitReports = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireActor(ctx, businessId)
    if (!(await visibleClient(ctx, env, businessId, clientId))) return null
    const { properties } = await propertiesOf(ctx, businessId, clientId)
    // Authors whose reports the caller may read (reportReadable): their
    // scope's, and their own.
    const scoped = scopeMembers(env.scope)
    const authors =
      scoped === null ? null : [...new Set([...scoped, env.actor.real._id])]

    const perProperty = await Promise.all(
      properties.map((property) =>
        ctx.db
          .query('reports')
          .withIndex('by_property', (q) => q.eq('propertyId', property._id))
          .order('desc')
          .filter((q) =>
            q.and(
              q.eq(q.field('deletedAt'), undefined),
              authors === null
                ? true
                : q.or(
                    ...authors.map((id) =>
                      q.eq(q.field('authorMembershipId'), id),
                    ),
                  ),
            ),
          )
          .take(SUMMARY_REPORTS_PER_PROPERTY + 1),
      ),
    )

    const readable = perProperty
      .flatMap((rows) => rows.slice(0, SUMMARY_REPORTS_PER_PROPERTY))
      .filter(
        (r) =>
          r.businessId === businessId &&
          reportReadable(env.scope, env.actor.real._id, r),
      )
      .sort(
        (a, b) =>
          (b.finalisedAt ?? b.createdAt) - (a.finalisedAt ?? a.createdAt),
      )

    return {
      reports: await reportChips(ctx, readable),
      capped: perProperty.some(
        (rows) => rows.length > SUMMARY_REPORTS_PER_PROPERTY,
      ),
    }
  },
})
