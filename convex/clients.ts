import { ConvexError, v } from 'convex/values'
import { paginationOptsValidator } from 'convex/server'
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
import { isInScope } from './lib/capabilities'
import {
  inScope,
  reportReadableHere,
  sharedJobIds,
  sharedJobsInRange,
} from './lib/jobPeople'
import type { Role, RowScope } from './lib/capabilities'
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
import { clientFacets } from './lib/clientFacets'
import {
  countXeroLinksOf,
  inXeroBook,
  markClientForXero,
} from './lib/xeroHooks'

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

/**
 * Past this many clients (or sites, or contact people) the directory stops
 * reading and says so. Far beyond any book today (the largest is 1,371):
 * before a business gets here, the Clients search moves to the server
 * (docs/design-system.md, Long lists), and the directory is split. It keeps
 * the read inside a query's limits rather than failing.
 */
const DIRECTORY_LIMIT = 8000

/**
 * Who is sent clients' emails and business clients' contact people: every
 * role, subcontractors included (the owner's answer, 27 Oct 2026). Any
 * member may be the one a caller rings, and they already hold names, phones
 * and addresses. The account being read decides (`readScope`), so an owner
 * looking through a subcontractor's eyes sees what they would.
 *
 * Without them, a directory carries no `email` and no `contacts`, and the
 * phone's matcher reads the copy as incomplete (lib/clientMatch.ts).
 */
const CONTACT_DETAILS_ROLES: ReadonlySet<Role> = new Set([
  'owner',
  'contractor',
  'subcontractor',
])

function contactDetailsFor(env: ActorEnvelope): boolean {
  return CONTACT_DETAILS_ROLES.has(env.readScope.role)
}

/**
 * Every client and every site of the business, in slim rows — the one list
 * behind the booking pickers (New Job, the job's edit form, New report), the
 * client import's "already here", the Clients page's search, A–Z and
 * filters, and "is this caller already a client?" (lib/clientMatch.ts),
 * which a phone answers from its kept copy with no signal.
 *
 * Read whole on purpose: a picker that held only some clients would let the
 * office type an existing one in again, a second history for the same house
 * (properties.ts `search`). What it no longer does is what made
 * `properties.list` heavy: one read per site to embed the whole client, and
 * every field of both. A few range reads, joined here, and only the fields
 * those screens use.
 *
 * For matching, each client's email, and each business client's contact
 * people (`contacts`): an agency's property manager rings from her own
 * mobile. Not a person client's, which the app hides. Who gets them is
 * `contactDetailsFor`.
 *
 * Every field it sends is the client sheet's to show anyone the book is
 * open to (`clients.get`, `clientContacts.list`): the directory sends them
 * all at once, for a phone with no signal, and nothing more.
 *
 * Re-run, and re-sent whole to every member with it open, on every change
 * to what it reads, so it reads the client book and nothing else: clients,
 * sites and contact people, after the access check every query makes. Not
 * the business row, which every booking, Recurring Job visit and numbered
 * report patches (its job and report numbers), nor the team. That is why
 * the business's and the team's own numbers, which matching leaves out, are
 * not marked here: the phone works them out from what it already holds
 * (`oursFor`, lib/clientMatch.ts).
 *
 * Archived clients are in it, with `archivedAt`: the pickers keep them
 * pickable, labelled and last; the Clients page leaves them out. Every
 * array is oldest first (`by_business`), as `properties.list` was: the
 * import matches the older of two same-named clients, and New report picks
 * the first site. Scoped as `properties.list` is. `capped` says clients or
 * sites passed the limit; `contactsCapped`, that only contact people did.
 *
 * Kept on phones: a renamed or removed field means bumping KEPT_SHAPE. An
 * added one doesn't, but every field already here keeps its meaning: the
 * live frontend reads them as they are.
 */
export const directory = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    const visible = await visibleClientIds(ctx, env)
    const details = contactDetailsFor(env)
    // Contact people only with the whole book: a phone reads a copy with
    // them as complete, and counts who holds a number from it. A copy of
    // some clients only (lib/clientScope.ts) would count a family's or an
    // agency's number held outside it as one person's, so it goes without,
    // and is matched as a copy that can't say who else holds a number.
    const withContacts = details && visible === 'all'

    // Read newest first, so a book past the limit loses its OLDEST rows:
    // the newest are the ones about to be booked, and an import's duplicate
    // check has most need of what was added last. Turned back to oldest
    // first after the cut.
    const [clients, sites, contacts] = await Promise.all([
      ctx.db
        .query('clients')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .order('desc')
        .filter((q) => q.eq(q.field('deletedAt'), undefined))
        .take(DIRECTORY_LIMIT + 1),
      ctx.db
        .query('properties')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .order('desc')
        .filter((q) => q.eq(q.field('deletedAt'), undefined))
        .take(DIRECTORY_LIMIT + 1),
      withContacts
        ? ctx.db
            .query('clientContacts')
            .withIndex('by_business', (q) => q.eq('businessId', businessId))
            .order('desc')
            .filter((q) => q.eq(q.field('deletedAt'), undefined))
            .take(DIRECTORY_LIMIT + 1)
        : null,
    ])

    const shown = clients
      .slice(0, DIRECTORY_LIMIT)
      .reverse()
      .filter((c) => inClientScope(visible, c._id))
    const ids = new Set(shown.map((c) => c._id))
    // Contact people of the business clients listed only: a person
    // client's are hidden in the app, and a contact never arrives without
    // the client it is a contact of.
    const businesses = new Set(
      shown.filter((c) => c.kind === 'business').map((c) => c._id),
    )
    return {
      clients: shown.map((c) => directoryClient(c, details)),
      // Only sites whose client is listed: a site never arrives without the
      // name it is booked under.
      sites: sites
        .slice(0, DIRECTORY_LIMIT)
        .reverse()
        .filter((p) => ids.has(p.clientId))
        .map(directorySite),
      ...(contacts
        ? {
            contacts: contacts
              .slice(0, DIRECTORY_LIMIT)
              .reverse()
              .filter((p) => businesses.has(p.clientId))
              .map(directoryContact),
            // Said only when the clients weren't cut too: then "only the
            // newest clients" is already said, and covers their contacts.
            contactsCapped:
              contacts.length > DIRECTORY_LIMIT &&
              clients.length <= DIRECTORY_LIMIT,
          }
        : {}),
      capped:
        clients.length > DIRECTORY_LIMIT || sites.length > DIRECTORY_LIMIT,
    }
  },
})

const imported = (row: {
  importId?: Id<'clientImports'>
  importedFrom?: Id<'clientImports'>
}) =>
  // Either: Undo clears `importId` on what it keeps, never `importedFrom`.
  row.importId !== undefined || row.importedFrom !== undefined
    ? { imported: true as const }
    : {}

/** A client as the directory sends it. An empty field is left out. */
function directoryClient(c: Doc<'clients'>, details: boolean) {
  const email = details ? c.email : undefined
  return {
    _id: c._id,
    _creationTime: c._creationTime,
    name: c.name,
    kind: c.kind,
    ...(c.phone ? { phone: c.phone } : {}),
    ...(email ? { email } : {}),
    ...(c.abn ? { abn: c.abn } : {}),
    ...(c.clientNumber !== undefined ? { clientNumber: c.clientNumber } : {}),
    ...(c.status ? { status: c.status } : {}),
    ...(c.tags && c.tags.length > 0 ? { tags: c.tags } : {}),
    ...(c.archivedAt !== undefined ? { archivedAt: c.archivedAt } : {}),
    createdAt: c.createdAt,
    ...imported(c),
  }
}

/** A site as the directory sends it. An empty field is left out. */
function directorySite(p: Doc<'properties'>) {
  return {
    _id: p._id,
    clientId: p.clientId,
    addressLine: p.addressLine,
    suburb: p.suburb,
    postcode: p.postcode,
    ...(p.siteContactName ? { siteContactName: p.siteContactName } : {}),
    ...(p.siteContactPhone ? { siteContactPhone: p.siteContactPhone } : {}),
    createdAt: p.createdAt,
    ...imported(p),
  }
}

/** A business client's contact person as the directory sends it. An empty
 * field is left out. */
function directoryContact(p: Doc<'clientContacts'>) {
  return {
    _id: p._id,
    clientId: p.clientId,
    name: p.name,
    ...(p.role ? { role: p.role } : {}),
    ...(p.phone ? { phone: p.phone } : {}),
    ...(p.email ? { email: p.email } : {}),
  }
}

/** The Clients page asks for 30; past this a page is cut down. */
const CLIENT_PAGE_MAX = 60

/**
 * The Clients page as it opens: the newest clients, a page at a time, each
 * with its sites for the card — instead of every client and every site.
 *
 * Newest first is `by_business` read backwards: every client is inserted
 * with `createdAt` = now, so creation order is the page's order. Archived
 * clients and the Recycle bin are stepped over by the filter, before the
 * page is cut, so a page comes back full. The filter is the same for
 * everyone, so a page's place never goes stale (see `jobs.listPage`).
 *
 * Client scope is applied to the page afterwards — it is the whole book for
 * every role today (lib/clientScope.ts), and the app keeps asking while a
 * page comes back empty but not done.
 *
 * Search, A–Z and the filters do not page: they read `directory`, and run
 * the page's own matcher over every client (src/lib/clientFilters.ts).
 */
export const page = query({
  args: {
    businessId: v.id('businesses'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { businessId, paginationOpts }) => {
    const env = await requireActor(ctx, businessId)
    const visible = await visibleClientIds(ctx, env)

    const result = await ctx.db
      .query('clients')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .filter((q) =>
        q.and(
          q.eq(q.field('deletedAt'), undefined),
          q.eq(q.field('archivedAt'), undefined),
        ),
      )
      .paginate({
        ...paginationOpts,
        numItems: Math.max(
          1,
          Math.min(paginationOpts.numItems, CLIENT_PAGE_MAX),
        ),
        maximumRowsRead: paginationOpts.maximumRowsRead ?? 4000,
      })

    const rows = await Promise.all(
      result.page
        .filter((c) => inClientScope(visible, c._id))
        .map(async (c) => {
          // Live sites only, oldest first, the newest 50 when there are
          // more — and `propertiesCapped` to say so ("50+ properties").
          const sites = await propertiesOf(ctx, businessId, c._id)
          return {
            client: {
              _id: c._id,
              _creationTime: c._creationTime,
              name: c.name,
              kind: c.kind,
              ...(c.clientNumber !== undefined
                ? { clientNumber: c.clientNumber }
                : {}),
              ...(c.status ? { status: c.status } : {}),
              ...(c.tags && c.tags.length > 0 ? { tags: c.tags } : {}),
              createdAt: c.createdAt,
            },
            properties: sites.properties.map((p) => ({
              _id: p._id,
              addressLine: p.addressLine,
              suburb: p.suburb,
            })),
            propertiesCapped: sites.capped,
          }
        }),
    )
    return { ...result, page: rows }
  },
})

/** Past this many clients the overview stops counting: "5000+ clients". */
const OVERVIEW_LIMIT = 5000

/**
 * The Clients page's header and filters for the whole book, without sending
 * the book: how many clients, and which statuses, tags and suburbs they
 * have, with counts — a few KB where the page used to need every client and
 * site to work these out.
 *
 * The same clients the page lists (live, not archived, in scope), newest
 * first as the page shows them, and the same counting
 * (lib/clientFacets.ts), so the first screen's filters offer exactly what
 * they did. Also the client form's tag suggestions.
 */
export const overview = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    const visible = await visibleClientIds(ctx, env)

    const found = await ctx.db
      .query('clients')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .filter((q) =>
        q.and(
          q.eq(q.field('deletedAt'), undefined),
          q.eq(q.field('archivedAt'), undefined),
        ),
      )
      .take(OVERVIEW_LIMIT + 1)
    const clients = found
      .slice(0, OVERVIEW_LIMIT)
      .filter((c) => inClientScope(visible, c._id))

    // Suburbs are the sites': each client counts once per distinct suburb.
    const suburbsOf = new Map<Id<'clients'>, Array<{ suburb: string }>>(
      clients.map((c) => [c._id, []]),
    )
    const sites = await ctx.db
      .query('properties')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
      .take(OVERVIEW_LIMIT * 2)
    for (const site of sites) {
      suburbsOf.get(site.clientId)?.push({ suburb: site.suburb })
    }

    return {
      total: clients.length,
      capped: found.length > OVERVIEW_LIMIT,
      ...clientFacets(
        clients.map((c) => ({
          client: c,
          properties: suburbsOf.get(c._id) ?? [],
        })),
      ),
    }
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
      await ctx.db.patch('clients', clientId, {
        ...fields,
        ...record,
        updatedAt: Date.now(),
      })
      await markClientForXero(ctx, clientId)
    }
    // Queues the client for Xero itself, when it changes anyone.
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
    const client = await requireClient(ctx, businessId, clientId)
    // xero: out of the book, so off the match page's lists and counts.
    if (inXeroBook(client)) await countXeroLinksOf(ctx, clientId, -1)
    await ctx.db.patch('clients', clientId, { archivedAt: Date.now() })
    // Nothing is archived in Xero; whether it still gets this client's
    // changes is the sync's to decide, from the client as it is then.
    await markClientForXero(ctx, clientId)
  },
})

export const unarchive = mutation({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    requireCapability(await requireActor(ctx, businessId), 'clients.manage')
    const client = await requireClient(ctx, businessId, clientId)
    // xero: back in the book (`requireClient` refuses one in the bin).
    if (client.archivedAt !== undefined) {
      await countXeroLinksOf(ctx, clientId, 1)
    }
    await ctx.db.patch('clients', clientId, { archivedAt: undefined })
    await markClientForXero(ctx, clientId)
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
    // The visits they were also going on count as theirs (lib/jobPeople.ts).
    const shared = await sharedJobIds(ctx, scope)

    // Redacted like every other job read. These went out raw, so anyone who
    // could open a client could read what each of their own visits was
    // charged at whether or not they may see prices — and with the client
    // book open to everyone, that is anyone.
    return redactJobs(
      caps,
      jobs
        .filter((j) => inScope(scope, j, shared))
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

    // The gate `reports.listByProperty` uses: theirs to read, or on a job
    // they were on — as its lead or also going (lib/jobPeople.ts).
    const shared = await sharedJobIds(ctx, scope)
    const live = reportsByProperty
      .flat()
      .filter((r) => r.businessId === businessId && r.deletedAt === undefined)
    const readable = await Promise.all(
      live.map((r) => reportReadableHere(ctx, scope, actor.real._id, r, shared)),
    )
    const visible = live
      .filter((_, i) => readable[i])
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

/** Most shared visits read for one client's summary, across a team. */
const SHARED_VISITS_READ = 300

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
    // The visits they are also going on (lib/jobPeople.ts), which the
    // filter below, on who leads each visit, cannot find: read by person and
    // added back in at each property.
    const sharedJobs =
      assignees === null
        ? []
        : await sharedJobsInRange(ctx, env.scope, {
            businessId,
            order: 'desc',
            // Shared across a team, so a contractor with many on it does not
            // read many times over (each is a document fetched).
            limit: Math.max(
              25,
              Math.floor(SHARED_VISITS_READ / assignees.length),
            ),
          })
    const shared = new Set(sharedJobs.map((job) => job._id))

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
        const here = sharedJobs.filter(
          (job) =>
            job.propertyId === property._id &&
            !jobs.some((own) => own._id === job._id),
        )
        const all = [...jobs, ...here].sort(
          (a, b) => b.scheduledAt - a.scheduledAt,
        )
        return {
          series,
          jobs: all.slice(0, SUMMARY_VISITS_PER_PROPERTY),
          capped: all.length > SUMMARY_VISITS_PER_PROPERTY,
        }
      }),
    )

    const series = perProperty
      .flatMap((p) => p.series)
      .filter((r) => r.businessId === businessId && isInScope(env.scope, r))
    const visits = perProperty
      .flatMap((p) => p.jobs)
      .filter(
        (j) => j.businessId === businessId && inScope(env.scope, j, shared),
      )

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

    // And the reports on visits they were also going on (lib/jobPeople.ts),
    // whoever wrote them — which the author filter above cannot find.
    const propertyIds = new Set(properties.map((p) => p._id))
    const sharedHere =
      scoped === null
        ? []
        : (
            await sharedJobsInRange(ctx, env.scope, {
              businessId,
              order: 'desc',
              limit: Math.max(25, Math.floor(SHARED_VISITS_READ / scoped.length)),
            })
          ).filter((job) => propertyIds.has(job.propertyId))
    const sharedReports = (
      await Promise.all(
        sharedHere.map((job) =>
          ctx.db
            .query('reports')
            .withIndex('by_job', (q) => q.eq('jobId', job._id))
            .take(10),
        ),
      )
    )
      .flat()
      .filter((r) => r.deletedAt === undefined)

    const byId = new Map(
      [
        ...perProperty.flatMap((rows) =>
          rows.slice(0, SUMMARY_REPORTS_PER_PROPERTY),
        ),
        ...sharedReports,
      ].map((r) => [r._id, r]),
    )
    const shared = new Set(sharedHere.map((job) => job._id))
    const candidates = [...byId.values()].filter(
      (r) => r.businessId === businessId,
    )
    const allowed = await Promise.all(
      candidates.map((r) =>
        reportReadableHere(ctx, env.scope, env.actor.real._id, r, shared),
      ),
    )
    const readable = candidates
      .filter((_, i) => allowed[i])
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
