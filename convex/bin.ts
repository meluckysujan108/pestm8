import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import { requireActor, requireCapability, requireWriteActor } from './lib/actor'
import { recordAudit } from './lib/audit'
import { isBinned, unbinned } from './lib/bin'
import { writeAttribution } from './lib/capabilities'
import { mayEditJob } from './lib/jobAccess'
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
 * A finalised report is never taken. It is a record the business is required
 * to keep (reports.ts), so it stays in Reports, printing what it froze at
 * finalise, whatever happens to the property it is about.
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
 * Wiping for good, by hand or after 30 days, is not here yet.
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

type Root = Doc<'binEntries'>['root']

type Group = {
  clients: Map<Id<'clients'>, Doc<'clients'>>
  properties: Map<Id<'properties'>, Doc<'properties'>>
  recurrences: Map<Id<'recurrences'>, Doc<'recurrences'>>
  jobs: Map<Id<'jobs'>, Doc<'jobs'>>
  notes: Map<Id<'notes'>, Doc<'notes'>>
  drafts: Map<Id<'reports'>, Doc<'reports'>>
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
    group.drafts.size
  )
}

/**
 * Puts `root` and everything with it in the bin, as one delete: one entry,
 * one audit row, one transaction.
 */
async function putInBin(
  ctx: MutationCtx,
  env: WriteEnvelope,
  businessId: Id<'businesses'>,
  root: Root,
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
    deletedByMembershipId: env.actor.real._id,
    counts,
  })
  const mark = { deletedAt: now, binEntryId }
  for (const id of group.clients.keys()) await ctx.db.patch(id, mark)
  for (const id of group.properties.keys()) await ctx.db.patch(id, mark)
  for (const id of group.recurrences.keys()) await ctx.db.patch(id, mark)
  for (const id of group.jobs.keys()) await ctx.db.patch(id, mark)
  for (const id of group.notes.keys()) await ctx.db.patch(id, mark)
  for (const id of group.drafts.keys()) await ctx.db.patch(id, mark)

  // Ids and numbers only: the audit log outlives a wipe, so it must not
  // carry a name or an address.
  await recordAudit(ctx, writeAttribution(env.actor), {
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
    return putInBin(ctx, env, businessId, { kind: 'client', id: clientId })
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
    return putInBin(ctx, env, businessId, { kind: 'property', id: propertyId })
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
    return putInBin(ctx, env, businessId, { kind: 'job', id: jobId })
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
    return putInBin(ctx, env, businessId, {
      kind: 'recurrence',
      id: series._id,
    })
  },
})

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
    for (const rows of [
      clients,
      properties,
      recurrences,
      jobs,
      notes,
      drafts,
    ]) {
      for (const row of rows) await ctx.db.patch(row._id, back)
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
      const client = await ctx.db.get(property.clientId)
      if (!client) throw new ConvexError('RESTORE_PARENT_GONE')
      if (isBinned(client)) throw new ConvexError('RESTORE_CLIENT_FIRST')
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
          deletedBy: await nameOf(entry.deletedByMembershipId),
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
