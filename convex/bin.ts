import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import { authComponent } from './auth'
import { requireActor, requireCapability, requireWriteActor } from './lib/actor'
import { recordAudit } from './lib/audit'
import { isBinned, unbinned } from './lib/bin'
import { writeAttribution } from './lib/capabilities'
import { heldAnywhere } from './lib/fileClaims'
import { mayEditJob } from './lib/jobAccess'
import { purgeNote } from './notes'
import { purgeReport, restoredDraftPatch } from './reports'
import { intervalOf } from './lib/recurrence'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { WriteEnvelope } from './lib/actor'

/**
 * The Recycle bin: deleting a client, property, job or Recurring Job, and
 * bringing it back.
 *
 * Deleting puts the record in the bin with everything that belongs to it,
 * all marked alike (`deletedAt`, and this delete's `binEntryId`) so every
 * reader leaves them out without looking anything up (lib/bin.ts):
 *
 * - a client takes its properties, and everything at them;
 * - a property takes its jobs, its Recurring Jobs, and the notes and draft
 *   reports about it and them;
 * - a Recurring Job takes its visits, and what is about them;
 * - a job takes its notes and draft reports.
 *
 * A finalised report is never taken. It is a record the business may be
 * required to keep, so it stays in Reports, printing what it froze at
 * finalise, whatever happens to the property it is about. Only the owner
 * deleting the report itself takes one away (reports.softDelete).
 *
 * Anything already in the bin stays in its own group: deleting a client whose
 * property was deleted last week leaves that property's entry as it was, so
 * each can be restored on its own terms.
 *
 * Who: deleting is for the people who manage the client book — the owner
 * and contractors (`clients.manage`), a job or series only if they may edit
 * it. Restoring, like everything else in the bin, is the owner's
 * (`business.manage`): the bin is a place to recover from a mistake, not a
 * second list for everyone to work from.
 *
 * Wiping for good — Delete now, Empty bin, or 30 days on — takes every row in
 * the group, in batches (`wipeStep`). The rows go, and with them every name,
 * address, phone number and note the group held. Photo and signature files
 * are the exception, as they are everywhere in this app (reports.ts
 * `purgeReport`): a file's id is not proof it belongs to this job alone, and
 * deleting one a signed certificate also holds cannot be undone. A note's
 * pictures, which the notes feature owns outright, go with the note.
 */

/**
 * A group bigger than this is refused rather than half-written. One
 * transaction marks the whole group, which is what makes a delete all or
 * nothing — and a client with this many records needs a different tool
 * than a tap on their sheet.
 */
export const MAX_GROUP_ROWS = 4000

/** The bin page lists this many deletes, newest first. */
const LIST_LIMIT = 200

/** How long a delete waits in the bin before it is wiped for good — the
 * same thirty days as a note or a draft in Recently Deleted. */
export const BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Rows a wipe step takes of a table: notes and drafts each call out to
 * more (mentions, the sync component, photos), so fewer of them. */
const HEAVY_BATCH = 25
const ROW_BATCH = 200

type Root = Doc<'binEntries'>['root']

type Group = {
  clients: Map<Id<'clients'>, Doc<'clients'>>
  properties: Map<Id<'properties'>, Doc<'properties'>>
  recurrences: Map<Id<'recurrences'>, Doc<'recurrences'>>
  jobs: Map<Id<'jobs'>, Doc<'jobs'>>
  notes: Map<Id<'notes'>, Doc<'notes'>>
  drafts: Map<Id<'reports'>, Doc<'reports'>>
  contacts: Map<Id<'clientContacts'>, Doc<'clientContacts'>>
}

/** Everything that goes into the bin with `root`, not already in it. */
async function gather(ctx: MutationCtx, root: Root): Promise<Group> {
  const group: Group = {
    clients: new Map(),
    properties: new Map(),
    recurrences: new Map(),
    jobs: new Map(),
    notes: new Map(),
    drafts: new Map(),
    contacts: new Map(),
  }

  const addNotes = (notes: Array<Doc<'notes'>>) => {
    for (const note of notes) {
      if (!isBinned(note)) group.notes.set(note._id, note)
    }
  }
  const addDrafts = (reports: Array<Doc<'reports'>>) => {
    for (const report of reports) {
      if (report.status === 'draft' && !isBinned(report)) {
        group.drafts.set(report._id, report)
      }
    }
  }

  const addJob = async (job: Doc<'jobs'>) => {
    if (isBinned(job) || group.jobs.has(job._id)) return
    group.jobs.set(job._id, job)
    addNotes(
      await ctx.db
        .query('notes')
        .withIndex('by_job', (q) => q.eq('jobId', job._id))
        .collect(),
    )
    addDrafts(
      await ctx.db
        .query('reports')
        .withIndex('by_job', (q) => q.eq('jobId', job._id))
        .collect(),
    )
  }

  const addSeries = async (series: Doc<'recurrences'>) => {
    if (isBinned(series) || group.recurrences.has(series._id)) return
    group.recurrences.set(series._id, series)
    const visits = await ctx.db
      .query('jobs')
      .withIndex('by_recurrence', (q) => q.eq('recurrenceId', series._id))
      .collect()
    for (const visit of visits) await addJob(visit)
  }

  const addProperty = async (property: Doc<'properties'>) => {
    if (isBinned(property) || group.properties.has(property._id)) return
    group.properties.set(property._id, property)
    const series = await ctx.db
      .query('recurrences')
      .withIndex('by_property', (q) => q.eq('propertyId', property._id))
      .collect()
    for (const s of series) await addSeries(s)
    const jobs = await ctx.db
      .query('jobs')
      .withIndex('by_property', (q) => q.eq('propertyId', property._id))
      .collect()
    for (const job of jobs) await addJob(job)
    addNotes(
      await ctx.db
        .query('notes')
        .withIndex('by_property', (q) => q.eq('propertyId', property._id))
        .collect(),
    )
    addDrafts(
      await ctx.db
        .query('reports')
        .withIndex('by_property', (q) => q.eq('propertyId', property._id))
        .collect(),
    )
  }

  switch (root.kind) {
    case 'client': {
      const client = await ctx.db.get(root.id)
      if (!client) break
      group.clients.set(client._id, client)
      const properties = await ctx.db
        .query('properties')
        .withIndex('by_client', (q) => q.eq('clientId', client._id))
        .collect()
      for (const property of properties) await addProperty(property)
      addNotes(
        await ctx.db
          .query('notes')
          .withIndex('by_client', (q) => q.eq('clientId', client._id))
          .collect(),
      )
      break
    }
    case 'property': {
      const property = await ctx.db.get(root.id)
      if (property) await addProperty(property)
      break
    }
    case 'recurrence': {
      const series = await ctx.db.get(root.id)
      if (series) await addSeries(series)
      break
    }
    case 'job': {
      const job = await ctx.db.get(root.id)
      if (job) await addJob(job)
      break
    }
    case 'contact': {
      // A contact goes alone. A client's contacts are not marked when the
      // client is deleted: they are only ever read through their client,
      // and go with it when it is wiped.
      const contact = await ctx.db.get(root.id)
      if (contact && !isBinned(contact))
        group.contacts.set(contact._id, contact)
      break
    }
  }
  return group
}

function sizeOf(group: Group): number {
  return (
    group.clients.size +
    group.properties.size +
    group.recurrences.size +
    group.jobs.size +
    group.notes.size +
    group.drafts.size +
    group.contacts.size
  )
}

/**
 * Puts `root` and everything with it in the bin, as one delete: one entry,
 * one audit row, one transaction.
 *
 * `by` is who deleted it — or, for a client archived before the bin existed
 * (migrations/archivedClientsToBinV1), when it was archived: nothing
 * recorded who, so the entry names nobody and nothing is audited.
 */
export async function putInBin(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  root: Root,
  by: { env: WriteEnvelope } | { archivedAt: number },
): Promise<Id<'binEntries'>> {
  const group = await gather(ctx, root)
  if (sizeOf(group) > MAX_GROUP_ROWS) {
    throw new ConvexError('TOO_MUCH_TO_DELETE')
  }

  // What went WITH the record — the record itself is not counted.
  const counts = {
    properties: group.properties.size - (root.kind === 'property' ? 1 : 0),
    jobs: group.jobs.size - (root.kind === 'job' ? 1 : 0),
    recurrences: group.recurrences.size - (root.kind === 'recurrence' ? 1 : 0),
    notes: group.notes.size,
    drafts: group.drafts.size,
  }

  const now = Date.now()
  const binEntryId = await ctx.db.insert('binEntries', {
    businessId,
    root,
    deletedAt: now,
    ...('env' in by
      ? { deletedByMembershipId: by.env.actor.real._id }
      : { archivedAt: by.archivedAt }),
    counts,
  })
  const mark = { deletedAt: now, binEntryId }
  for (const id of group.clients.keys()) await ctx.db.patch(id, mark)
  for (const id of group.properties.keys()) await ctx.db.patch(id, mark)
  for (const id of group.recurrences.keys()) await ctx.db.patch(id, mark)
  for (const id of group.jobs.keys()) await ctx.db.patch(id, mark)
  for (const id of group.notes.keys()) await ctx.db.patch(id, mark)
  for (const id of group.drafts.keys()) await ctx.db.patch(id, mark)
  for (const id of group.contacts.keys()) await ctx.db.patch(id, mark)

  if (!('env' in by)) return binEntryId

  // Ids and numbers only: the audit log outlives a wipe, so it must not
  // carry a name or an address.
  await recordAudit(ctx, writeAttribution(by.env.actor), {
    businessId,
    action: 'bin.delete',
    entityType: TABLE_OF[root.kind],
    entityId: root.id,
    meta: { counts },
    at: now,
  })
  return binEntryId
}

const TABLE_OF = {
  client: 'clients',
  property: 'properties',
  job: 'jobs',
  recurrence: 'recurrences',
  contact: 'clientContacts',
} as const satisfies Record<Root['kind'], string>

/** The owner and contractors: the people who manage the client book. */
async function requireBinner(ctx: MutationCtx, businessId: Id<'businesses'>) {
  const env = await requireWriteActor(ctx, businessId)
  requireCapability(env, 'clients.manage')
  return env
}

export const deleteClient = mutation({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireBinner(ctx, businessId)
    const client = unbinned(await ctx.db.get(clientId))
    if (!client || client.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    return putInBin(ctx, businessId, { kind: 'client', id: clientId }, { env })
  },
})

export const deleteProperty = mutation({
  args: { businessId: v.id('businesses'), propertyId: v.id('properties') },
  handler: async (ctx, { businessId, propertyId }) => {
    const env = await requireBinner(ctx, businessId)
    const property = unbinned(await ctx.db.get(propertyId))
    if (!property || property.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    return putInBin(
      ctx,
      businessId,
      { kind: 'property', id: propertyId },
      { env },
    )
  },
})

export const deleteJob = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const env = await requireBinner(ctx, businessId)
    const job = unbinned(await ctx.db.get(jobId))
    if (!job || job.businessId !== businessId)
      throw new ConvexError('NOT_FOUND')
    // A contractor deletes their own team's work, as they edit it.
    if (!(await mayEditJob(ctx, env.actor, job))) {
      throw new ConvexError('NO_ACCESS')
    }
    return putInBin(ctx, businessId, { kind: 'job', id: jobId }, { env })
  },
})

/** A Recurring Job and all its visits, deleted from any one of them. */
export const deleteSeries = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const env = await requireBinner(ctx, businessId)
    const job = unbinned(await ctx.db.get(jobId))
    if (!job || job.businessId !== businessId)
      throw new ConvexError('NOT_FOUND')
    if (!job.recurrenceId) throw new ConvexError('NOT_RECURRING')
    const series = unbinned(await ctx.db.get(job.recurrenceId))
    if (!series || series.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (!(await mayEditJob(ctx, env.actor, series))) {
      throw new ConvexError('NO_ACCESS')
    }
    return putInBin(
      ctx,
      businessId,
      { kind: 'recurrence', id: series._id },
      { env },
    )
  },
})

/**
 * A client's contact, into the bin on its own — its name, number and email
 * are the client's to lose, and "Remove" was a tap away from anyone.
 */
export const deleteContact = mutation({
  args: { businessId: v.id('businesses'), contactId: v.id('clientContacts') },
  handler: async (ctx, { businessId, contactId }) =>
    binContact(ctx, businessId, contactId),
})

/** `deleteContact`, for the older `clientContacts.remove` too. */
export async function binContact(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  contactId: Id<'clientContacts'>,
): Promise<Id<'binEntries'>> {
  const env = await requireBinner(ctx, businessId)
  const contact = unbinned(await ctx.db.get(contactId))
  if (!contact || contact.businessId !== businessId) {
    throw new ConvexError('NOT_FOUND')
  }
  return putInBin(ctx, businessId, { kind: 'contact', id: contactId }, { env })
}

/**
 * Brings a delete back exactly as it went in: every row carrying this entry,
 * and nothing else.
 *
 * Refused while what it belongs to is still in the bin under a delete of its
 * own — a property whose client is binned, a job whose property or series
 * is — because it would come back into lists at an address nobody can open.
 * The error names what to restore first.
 */
export const restore = mutation({
  args: { businessId: v.id('businesses'), entryId: v.id('binEntries') },
  handler: async (ctx, { businessId, entryId }) => {
    const env = await requireWriteActor(ctx, businessId)
    requireCapability(env, 'business.manage')
    const entry = await ctx.db.get(entryId)
    if (!entry || entry.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (entry.wipeStartedAt !== undefined) throw new ConvexError('WIPING')
    await requireRestorable(ctx, entry.root)

    const back = { deletedAt: undefined, binEntryId: undefined }
    const clients = await ctx.db
      .query('clients')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .collect()
    const properties = await ctx.db
      .query('properties')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .collect()
    const recurrences = await ctx.db
      .query('recurrences')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .collect()
    const jobs = await ctx.db
      .query('jobs')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .collect()
    const notes = await ctx.db
      .query('notes')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .collect()
    const drafts = await ctx.db
      .query('reports')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .collect()
    const contacts = await ctx.db
      .query('clientContacts')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .collect()
    for (const rows of [properties, recurrences, jobs, notes, contacts]) {
      for (const row of rows) await ctx.db.patch(row._id, back)
    }
    // A correction whose report the owner deleted while it was in here goes
    // to that report in Recently Deleted instead (reports.ts).
    for (const draft of drafts) {
      await ctx.db.patch(
        draft._id,
        (await restoredDraftPatch(ctx, draft)) ?? back,
      )
    }
    // A client archived before the bin existed comes back un-archived: the
    // archive had no way back, and the bin is that way now.
    for (const row of clients) {
      await ctx.db.patch(row._id, { ...back, archivedAt: undefined })
    }
    await ctx.db.delete(entryId)

    await recordAudit(ctx, writeAttribution(env.actor), {
      businessId,
      action: 'bin.restore',
      entityType: TABLE_OF[entry.root.kind],
      entityId: entry.root.id,
    })
  },
})

async function requireRestorable(ctx: MutationCtx, root: Root) {
  const clientOf = async (clientId: Id<'clients'>) => {
    const client = await ctx.db.get(clientId)
    if (!client) throw new ConvexError('RESTORE_PARENT_GONE')
    if (isBinned(client)) throw new ConvexError('RESTORE_CLIENT_FIRST')
  }
  const propertyOf = async (propertyId: Id<'properties'>) => {
    const property = await ctx.db.get(propertyId)
    if (!property) throw new ConvexError('RESTORE_PARENT_GONE')
    if (isBinned(property)) throw new ConvexError('RESTORE_PROPERTY_FIRST')
  }
  switch (root.kind) {
    case 'client':
      return
    case 'property': {
      const property = await ctx.db.get(root.id)
      if (!property) throw new ConvexError('NOT_FOUND')
      await clientOf(property.clientId)
      return
    }
    case 'contact': {
      const contact = await ctx.db.get(root.id)
      if (!contact) throw new ConvexError('NOT_FOUND')
      await clientOf(contact.clientId)
      return
    }
    case 'recurrence': {
      const series = await ctx.db.get(root.id)
      if (!series) throw new ConvexError('NOT_FOUND')
      await propertyOf(series.propertyId)
      return
    }
    case 'job': {
      const job = await ctx.db.get(root.id)
      if (!job) throw new ConvexError('NOT_FOUND')
      await propertyOf(job.propertyId)
      if (job.recurrenceId) {
        const series = await ctx.db.get(job.recurrenceId)
        if (series && isBinned(series)) {
          throw new ConvexError('RESTORE_SERIES_FIRST')
        }
      }
      return
    }
  }
}

/**
 * What is in the bin, newest first: the owner's.
 *
 * Each row names the record the way the rest of the app does — a client by
 * name, a site by its address, a job by its type, suburb and day — read from
 * the binned record itself, which is what lets the entry hold no names.
 */
export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'business.manage')

    const found = await ctx.db
      .query('binEntries')
      .withIndex('by_businessId_and_deletedAt', (q) =>
        q.eq('businessId', businessId),
      )
      // Being wiped: already on its way out, and not coming back.
      .filter((q) => q.eq(q.field('wipeStartedAt'), undefined))
      .order('desc')
      .take(LIST_LIMIT + 1)

    const names = new Map<Id<'memberships'>, Promise<string>>()
    const nameOf = (membershipId: Id<'memberships'>) => {
      const known = names.get(membershipId)
      if (known) return known
      const pending = (async () => {
        const membership = await ctx.db.get(membershipId)
        const user = membership
          ? await authComponent.getAnyUserById(ctx, membership.userId)
          : null
        return user?.name ?? ''
      })()
      names.set(membershipId, pending)
      return pending
    }

    const rows = await Promise.all(
      found.slice(0, LIST_LIMIT).map(async (entry) => {
        const what = await describe(ctx, entry.root)
        if (!what) return null
        return {
          _id: entry._id,
          deletedAt: entry.deletedAt,
          wipesAt: entry.deletedAt + BIN_RETENTION_MS,
          deletedBy: entry.deletedByMembershipId
            ? await nameOf(entry.deletedByMembershipId)
            : '',
          archivedAt: entry.archivedAt ?? null,
          counts: entry.counts,
          ...what,
        }
      }),
    )
    return {
      entries: rows.filter((row) => row !== null),
      capped: found.length > LIST_LIMIT,
    }
  },
})

async function describe(ctx: QueryCtx, root: Root) {
  const siteOf = async (propertyId: Id<'properties'>) => {
    const property = await ctx.db.get(propertyId)
    return property
      ? { addressLine: property.addressLine, suburb: property.suburb }
      : { addressLine: '', suburb: '' }
  }
  switch (root.kind) {
    case 'client': {
      const client = await ctx.db.get(root.id)
      return client && { kind: 'client' as const, title: client.name }
    }
    case 'property': {
      const property = await ctx.db.get(root.id)
      if (!property) return null
      const client = await ctx.db.get(property.clientId)
      return {
        kind: 'property' as const,
        title: property.addressLine,
        suburb: property.suburb,
        clientName: client?.name ?? '',
      }
    }
    case 'job': {
      const job = await ctx.db.get(root.id)
      if (!job) return null
      const { suburb } = await siteOf(job.propertyId)
      return {
        kind: 'job' as const,
        title: job.jobType,
        suburb,
        scheduledAt: job.scheduledAt,
      }
    }
    case 'contact': {
      const contact = await ctx.db.get(root.id)
      if (!contact) return null
      const client = await ctx.db.get(contact.clientId)
      return {
        kind: 'contact' as const,
        title: contact.name,
        clientName: client?.name ?? '',
      }
    }
    case 'recurrence': {
      const series = await ctx.db.get(root.id)
      if (!series) return null
      const { suburb } = await siteOf(series.propertyId)
      return {
        kind: 'recurrence' as const,
        title: series.jobType,
        suburb,
        interval: intervalOf(series),
      }
    }
  }
}

/**
 * Delete forever, one delete: the owner's. Starts the wipe and returns; the
 * entry leaves the bin page at once, and its rows go over the next moments.
 */
export const wipe = mutation({
  args: { businessId: v.id('businesses'), entryId: v.id('binEntries') },
  handler: async (ctx, { businessId, entryId }) => {
    const env = await requireWriteActor(ctx, businessId)
    requireCapability(env, 'business.manage')
    const entry = await ctx.db.get(entryId)
    if (!entry || entry.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (entry.wipeStartedAt !== undefined) return
    await startWipe(ctx, entry)
    await recordAudit(ctx, writeAttribution(env.actor), {
      businessId,
      action: 'bin.wipe',
      entityType: TABLE_OF[entry.root.kind],
      entityId: entry.root.id,
      meta: { counts: entry.counts },
    })
  },
})

/** Empty bin: every delete in it, for good. The owner's. */
export const empty = mutation({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireWriteActor(ctx, businessId)
    requireCapability(env, 'business.manage')
    const entries = await ctx.db
      .query('binEntries')
      .withIndex('by_businessId_and_deletedAt', (q) =>
        q.eq('businessId', businessId),
      )
      .filter((q) => q.eq(q.field('wipeStartedAt'), undefined))
      .collect()
    for (const entry of entries) await startWipe(ctx, entry)
    await recordAudit(ctx, writeAttribution(env.actor), {
      businessId,
      action: 'bin.empty',
      entityType: 'businesses',
      entityId: businessId,
      meta: { entries: entries.length },
    })
  },
})

/**
 * The nightly sweep: every delete in the bin for thirty days, wiped. Only
 * starts each wipe — `wipeStep` does the work — so a large night stays in
 * small transactions.
 */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - BIN_RETENTION_MS
    const due = await ctx.db
      .query('binEntries')
      .withIndex('by_deletedAt', (q) => q.lt('deletedAt', cutoff))
      .filter((q) => q.eq(q.field('wipeStartedAt'), undefined))
      .take(ROW_BATCH)
    for (const entry of due) await startWipe(ctx, entry)
    if (due.length === ROW_BATCH) {
      await ctx.scheduler.runAfter(0, internal.bin.purgeExpired, {})
    }
  },
})

async function startWipe(ctx: MutationCtx, entry: Doc<'binEntries'>) {
  await ctx.db.patch(entry._id, { wipeStartedAt: Date.now() })
  await ctx.scheduler.runAfter(0, internal.bin.wipeStep, { entryId: entry._id })
}

/**
 * One batch of a wipe, then the next, until nothing carries the entry — and
 * then the entry itself.
 *
 * Children before parents (notes and drafts, jobs, series, properties,
 * clients), so a wipe cut short leaves nothing pointing at a row that is
 * gone. Every step reads what is still there, so running one twice, or
 * after a failure, only carries on.
 */
export const wipeStep = internalMutation({
  args: { entryId: v.id('binEntries') },
  handler: async (ctx, { entryId }): Promise<null> => {
    const entry = await ctx.db.get(entryId)
    if (!entry || entry.wipeStartedAt === undefined) return null
    const again = async (): Promise<null> => {
      await ctx.scheduler.runAfter(0, internal.bin.wipeStep, { entryId })
      return null
    }

    const notes = await ctx.db
      .query('notes')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .take(HEAVY_BATCH)
    if (notes.length > 0) {
      for (const note of notes) await purgeNote(ctx, note)
      return again()
    }

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .take(HEAVY_BATCH)
    if (reports.length > 0) {
      for (const report of reports) {
        // Only drafts go into the bin, and a binned draft cannot be
        // finalised. Checked anyway: a finalised report is a record the
        // business must keep, so one found here is put back, never wiped.
        if (report.status === 'finalised') {
          await ctx.db.patch(report._id, {
            deletedAt: undefined,
            binEntryId: undefined,
          })
          continue
        }
        await purgeReport(ctx, report)
      }
      return again()
    }

    const jobs = await ctx.db
      .query('jobs')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .take(ROW_BATCH)
    if (jobs.length > 0) {
      for (const job of jobs) {
        const photos = await ctx.db
          .query('jobPhotos')
          .withIndex('by_job', (q) => q.eq('jobId', job._id))
          .collect()
        for (const photo of photos) {
          await ctx.db.delete(photo._id)
          await dropJobPhotoFile(ctx, photo)
        }
        await ctx.db.delete(job._id)
      }
      return again()
    }

    const series = await ctx.db
      .query('recurrences')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .take(ROW_BATCH)
    if (series.length > 0) {
      for (const row of series) await ctx.db.delete(row._id)
      return again()
    }

    const properties = await ctx.db
      .query('properties')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .take(ROW_BATCH)
    if (properties.length > 0) {
      for (const row of properties) await ctx.db.delete(row._id)
      return again()
    }

    const contacts = await ctx.db
      .query('clientContacts')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .take(ROW_BATCH)
    if (contacts.length > 0) {
      for (const row of contacts) await ctx.db.delete(row._id)
      return again()
    }

    const clients = await ctx.db
      .query('clients')
      .withIndex('by_binEntryId', (q) => q.eq('binEntryId', entryId))
      .take(HEAVY_BATCH)
    if (clients.length > 0) {
      for (const client of clients) {
        const people = await ctx.db
          .query('clientContacts')
          .withIndex('by_client', (q) => q.eq('clientId', client._id))
          .collect()
        for (const person of people) await ctx.db.delete(person._id)
        await ctx.db.delete(client._id)
      }
      return again()
    }

    await ctx.db.delete(entryId)
    return null
  },
})

/**
 * A wiped job photo's file, deleted — only when it was claimed for that job
 * alone (`claimed`, jobs.addPhoto) and nothing holds it now: no other job
 * photo, and none of the rows `heldAnywhere` can ask. A photo added before
 * claims existed keeps its file, as every file in this app used to.
 */
async function dropJobPhotoFile(ctx: MutationCtx, photo: Doc<'jobPhotos'>) {
  if (photo.claimed !== true) return
  const other = await ctx.db
    .query('jobPhotos')
    .withIndex('by_storageId', (q) => q.eq('storageId', photo.storageId))
    .first()
  if (other) return
  if (await heldAnywhere(ctx, photo.storageId)) return
  await ctx.storage.delete(photo.storageId)
}
