import { paginationOptsValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { components, internal } from './_generated/api'
import { internalMutation, mutation, query } from './_generated/server'
import { authComponent } from './auth'
import { jobVisibility, requireMembership } from './lib/access'
import {
  canDeleteNote,
  canReadNote,
  canWriteNote,
  noteKind,
  noteViewer,
  requireNote,
  requireReadableNote,
} from './lib/noteAccess'
import { NOTE_TEMPLATE_KEYS, NOTE_TEMPLATES } from './lib/noteTemplates'
import { deriveNoteFields } from './lib/richText'
import { prosemirrorSync } from './notesSync'
import { clientNameOf } from './properties'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Note, NoteViewer } from './lib/noteAccess'

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// A photo may only be attached within this long of being uploaded. Convex
// has no per-upload ownership tag, so freshness is the proxy that keeps
// every other storage id in the deployment (report PDFs, signatures,
// logos) out of reach of the notes purge.
const ATTACH_WINDOW_MS = 15 * 60 * 1000

export const noteFilter = v.union(
  v.literal('all'),
  v.literal('jobs'),
  v.literal('sites'),
  v.literal('team'),
  v.literal('trash'),
)

const noteTemplate = v.union(
  ...NOTE_TEMPLATE_KEYS.map((key) => v.literal(key)),
)

const noteLink = v.union(
  v.object({ kind: v.literal('job'), jobId: v.id('jobs') }),
  v.object({ kind: v.literal('property'), propertyId: v.id('properties') }),
  v.object({ kind: v.literal('client'), clientId: v.id('clients') }),
  v.object({ kind: v.literal('none') }),
)

// ---------------------------------------------------------------------------
// Shaping

async function readable(ctx: QueryCtx, viewer: NoteViewer, notes: Array<Note>) {
  const flags = await Promise.all(notes.map((n) => canReadNote(ctx, viewer, n)))
  return notes.filter((_, i) => flags[i])
}

type Folder = 'all' | 'jobs' | 'sites' | 'team' | 'trash'

/** The library folders, as a predicate on a row already read from the index. */
function inFolder(note: Note, folder: Folder): boolean {
  switch (folder) {
    case 'all':
      return note.deletedAt === undefined
    case 'jobs':
      return note.deletedAt === undefined && note.jobId !== undefined
    case 'sites':
      return note.deletedAt === undefined && note.jobId === undefined && noteKind(note) !== 'team'
    case 'team':
      return note.deletedAt === undefined && noteKind(note) === 'team'
    case 'trash':
      return note.deletedAt !== undefined
  }
}

/** Pinned first, then most recently edited — the phone's Notes order. */
function byPinnedThenEdited<T extends { pinnedAt?: number; updatedAt: number }>(
  notes: Array<T>,
) {
  return [...notes].sort((a, b) => {
    const pin = Number(b.pinnedAt !== undefined) - Number(a.pinnedAt !== undefined)
    return pin !== 0 ? pin : b.updatedAt - a.updatedAt
  })
}

async function decorate(ctx: QueryCtx, viewer: NoteViewer, notes: Array<Note>) {
  // One auth-component lookup per person, not per note — the same in-flight
  // promise memo `jobs.decorate` uses, for the same reason.
  const names = new Map<Id<'memberships'>, Promise<string>>()
  const nameOf = (membershipId: Id<'memberships'>) => {
    const inFlight = names.get(membershipId)
    if (inFlight) return inFlight
    const pending = (async () => {
      const member = await ctx.db.get(membershipId)
      const user = member ? await authComponent.getAnyUserById(ctx, member.userId) : null
      return user?.name ?? ''
    })()
    names.set(membershipId, pending)
    return pending
  }

  return Promise.all(
    notes.map(async (note) => {
      const author = await ctx.db.get(note.authorMembershipId)
      const job = note.jobId ? await ctx.db.get(note.jobId) : null
      const property = note.propertyId ? await ctx.db.get(note.propertyId) : null
      const client = note.clientId ? await ctx.db.get(note.clientId) : null
      return {
        _id: note._id,
        kind: noteKind(note),
        title: note.title,
        preview: note.preview,
        jobId: note.jobId,
        propertyId: note.propertyId,
        clientId: note.clientId,
        job: job
          ? {
              jobNumber: job.jobNumber,
              jobType: job.jobType,
              scheduledAt: job.scheduledAt,
              status: job.status,
            }
          : null,
        clientName: client?.name ?? '',
        addressLine: property?.addressLine ?? '',
        suburb: property?.suburb ?? '',
        authorColour: author?.colour ?? '#8E8E93',
        authorRole: author?.role,
        authorName: await nameOf(note.authorMembershipId),
        editorName: await nameOf(note.lastEditedByMembershipId),
        checklistTotal: note.checklistTotal,
        checklistDone: note.checklistDone,
        pinnedAt: note.pinnedAt,
        deletedAt: note.deletedAt,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        // Always the REAL caller: "view as" grants reading, never authorship.
        mine: note.authorMembershipId === viewer.real._id,
        canEdit: await canWriteNote(ctx, viewer, note),
        canDelete: canDeleteNote(viewer.real, note),
      }
    }),
  )
}

export type DecoratedNote = Awaited<ReturnType<typeof decorate>>[number]

// ---------------------------------------------------------------------------
// Reading

export const list = query({
  args: {
    businessId: v.id('businesses'),
    filter: noteFilter,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { businessId, filter, paginationOpts }) => {
    const viewer = await noteViewer(ctx, businessId)

    const result = await ctx.db
      .query('notes')
      .withIndex('by_business_updated', (q) => q.eq('businessId', businessId))
      .order('desc')
      .filter((q) => {
        const isLive = q.eq(q.field('deletedAt'), undefined)
        const noJob = q.eq(q.field('jobId'), undefined)
        switch (filter) {
          case 'all':
            return isLive
          case 'jobs':
            return q.and(isLive, q.neq(q.field('jobId'), undefined))
          case 'sites':
            return q.and(
              isLive,
              noJob,
              q.or(
                q.neq(q.field('propertyId'), undefined),
                q.neq(q.field('clientId'), undefined),
              ),
            )
          case 'team':
            return q.and(
              isLive,
              noJob,
              q.eq(q.field('propertyId'), undefined),
              q.eq(q.field('clientId'), undefined),
            )
          case 'trash':
            return q.neq(q.field('deletedAt'), undefined)
        }
      })
      .paginate(paginationOpts)

    // A page can come back short after the visibility pass; the client's
    // paginator simply asks for the next one.
    const visible = await readable(ctx, viewer, result.page)
    return { ...result, page: await decorate(ctx, viewer, visible) }
  },
})

export const listPinned = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const viewer = await noteViewer(ctx, businessId)
    const notes = await ctx.db
      .query('notes')
      .withIndex('by_business_updated', (q) => q.eq('businessId', businessId))
      .order('desc')
      .filter((q) =>
        q.and(
          q.eq(q.field('deletedAt'), undefined),
          q.neq(q.field('pinnedAt'), undefined),
        ),
      )
      .take(50)
    return decorate(ctx, viewer, await readable(ctx, viewer, notes))
  },
})

/** Notes that @mention the real caller, unread first. */
export const listMentions = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const viewer = await noteViewer(ctx, businessId)
    const me = viewer.real._id

    const unread = await ctx.db
      .query('noteMentions')
      .withIndex('by_membership_read', (q) =>
        q.eq('membershipId', me).eq('readAt', undefined),
      )
      .order('desc')
      .take(50)
    const read = await ctx.db
      .query('noteMentions')
      .withIndex('by_membership_read', (q) =>
        q.eq('membershipId', me).gt('readAt', 0),
      )
      .order('desc')
      .take(50)

    const rows = [...unread, ...read]
    const notes = await Promise.all(rows.map((row) => ctx.db.get(row.noteId)))
    const out: Array<DecoratedNote & { unread: boolean }> = []
    for (const [i, note] of notes.entries()) {
      if (!note || note.businessId !== businessId || note.deletedAt !== undefined) continue
      if (!(await canReadNote(ctx, viewer, note))) continue
      const [decorated] = await decorate(ctx, viewer, [note])
      out.push({ ...decorated, unread: rows[i].readAt === undefined })
    }
    return out
  },
})

/** Full-text search within the open folder, so Recently Deleted is searchable too. */
export const search = query({
  args: {
    businessId: v.id('businesses'),
    q: v.string(),
    filter: v.optional(noteFilter),
  },
  handler: async (ctx, { businessId, q: term, filter = 'all' }) => {
    const viewer = await noteViewer(ctx, businessId)
    if (term.trim() === '') return []
    // Liveness is applied before the bound so trashed rows cannot crowd
    // live matches out of the window (or vice versa).
    const hits = await ctx.db
      .query('notes')
      .withSearchIndex('search', (q) =>
        q.search('plainText', term).eq('businessId', businessId),
      )
      .filter((q) =>
        filter === 'trash'
          ? q.neq(q.field('deletedAt'), undefined)
          : q.eq(q.field('deletedAt'), undefined),
      )
      .take(40)
    const scoped = hits.filter((n) => inFolder(n, filter))
    return decorate(ctx, viewer, await readable(ctx, viewer, scoped))
  },
})

export const get = query({
  args: { businessId: v.id('businesses'), noteId: v.id('notes') },
  handler: async (ctx, { businessId, noteId }) => {
    const note = await ctx.db.get(noteId)
    if (!note || note.businessId !== businessId) return null
    const viewer = await noteViewer(ctx, businessId)
    if (!(await canReadNote(ctx, viewer, note))) return null
    const [decorated] = await decorate(ctx, viewer, [note])
    return decorated
  },
})

/**
 * Notes on one job, with the author's actual name resolved: two technicians
 * (or an owner) leaving notes on the same job need telling apart.
 */
export const listForJob = query({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const viewer = await noteViewer(ctx, businessId)
    const notes = await ctx.db
      .query('notes')
      .withIndex('by_job', (q) => q.eq('jobId', jobId))
      .order('desc')
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
      .take(100)
    const scoped = notes.filter((n) => n.businessId === businessId)
    return byPinnedThenEdited(
      await decorate(ctx, viewer, await readable(ctx, viewer, scoped)),
    )
  },
})

/**
 * What to read before turning up: standing site notes for the property and
 * anything written about its client, then past visit notes for history.
 */
export const listForProperty = query({
  args: { businessId: v.id('businesses'), propertyId: v.id('properties') },
  handler: async (ctx, { businessId, propertyId }) => {
    const viewer = await noteViewer(ctx, businessId)
    const property = await ctx.db.get(propertyId)
    if (!property || property.businessId !== businessId) {
      return { site: [], visits: [] }
    }

    // Standing knowledge and visit notes are bounded separately: a busy
    // site's visit history must never push the gate code out of the window.
    const standing = await ctx.db
      .query('notes')
      .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
      .order('desc')
      .filter((q) =>
        q.and(q.eq(q.field('jobId'), undefined), q.eq(q.field('deletedAt'), undefined)),
      )
      .take(50)
    const visits = await ctx.db
      .query('notes')
      .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
      .order('desc')
      .filter((q) =>
        q.and(q.neq(q.field('jobId'), undefined), q.eq(q.field('deletedAt'), undefined)),
      )
      .take(100)
    const aboutClient = await ctx.db
      .query('notes')
      .withIndex('by_client', (q) => q.eq('clientId', property.clientId))
      .order('desc')
      .filter((q) =>
        q.and(
          q.eq(q.field('jobId'), undefined),
          q.eq(q.field('propertyId'), undefined),
          q.eq(q.field('deletedAt'), undefined),
        ),
      )
      .take(50)

    const visible = await readable(
      ctx,
      viewer,
      [...standing, ...visits, ...aboutClient].filter((n) => n.businessId === businessId),
    )
    const decorated = await decorate(ctx, viewer, visible)
    return {
      site: byPinnedThenEdited(decorated.filter((n) => n.kind !== 'job')),
      visits: byPinnedThenEdited(decorated.filter((n) => n.kind === 'job')),
    }
  },
})

/** Everything the team knows about a client: their notes, their sites, their visits. */
export const listForClient = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const viewer = await noteViewer(ctx, businessId)
    const standing = await ctx.db
      .query('notes')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .order('desc')
      .filter((q) =>
        q.and(q.eq(q.field('jobId'), undefined), q.eq(q.field('deletedAt'), undefined)),
      )
      .take(50)
    const visits = await ctx.db
      .query('notes')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .order('desc')
      .filter((q) =>
        q.and(q.neq(q.field('jobId'), undefined), q.eq(q.field('deletedAt'), undefined)),
      )
      .take(100)
    const scoped = [...standing, ...visits].filter((n) => n.businessId === businessId)
    return byPinnedThenEdited(
      await decorate(ctx, viewer, await readable(ctx, viewer, scoped)),
    )
  },
})

/** Bounded on purpose: the badge says "9+", it never counts a whole table. */
export const unreadMentionCount = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const me = await requireMembership(ctx, businessId)
    // Newest first: stale rows on trashed notes can then only shave the
    // count once there are already more than ten — inside "9+" territory.
    const rows = await ctx.db
      .query('noteMentions')
      .withIndex('by_membership_read', (q) =>
        q.eq('membershipId', me._id).eq('readAt', undefined),
      )
      .order('desc')
      .take(10)
    const notes = await Promise.all(rows.map((row) => ctx.db.get(row.noteId)))
    return notes.filter((n) => n && n.deletedAt === undefined).length
  },
})

/**
 * Jobs offered by the "attach to job" picker: the caller's own visible jobs
 * (writes never honour "view as") from the last three months to two months
 * ahead, nearest to today first. `now` comes from the client so the query
 * stays cacheable. Both sides are bounded at the index; names are resolved
 * only for the rows kept.
 */
export const jobOptions = query({
  args: { businessId: v.id('businesses'), now: v.number() },
  handler: async (ctx, { businessId, now }) => {
    const viewer = await noteViewer(ctx, businessId)
    const day = 24 * 60 * 60 * 1000
    const from = now - 90 * day
    const to = now + 60 * day
    const visibility = jobVisibility(viewer.real)

    const [past, future] =
      visibility.scope === 'business'
        ? await Promise.all([
            ctx.db
              .query('jobs')
              .withIndex('by_business_date', (q) =>
                q.eq('businessId', visibility.businessId).gte('scheduledAt', from).lt('scheduledAt', now),
              )
              .order('desc')
              .take(120),
            ctx.db
              .query('jobs')
              .withIndex('by_business_date', (q) =>
                q.eq('businessId', visibility.businessId).gte('scheduledAt', now).lt('scheduledAt', to),
              )
              .take(120),
          ])
        : await Promise.all([
            ctx.db
              .query('jobs')
              .withIndex('by_assignee_date', (q) =>
                q
                  .eq('assignedMembershipId', visibility.membershipId)
                  .gte('scheduledAt', from)
                  .lt('scheduledAt', now),
              )
              .order('desc')
              .take(120),
            ctx.db
              .query('jobs')
              .withIndex('by_assignee_date', (q) =>
                q
                  .eq('assignedMembershipId', visibility.membershipId)
                  .gte('scheduledAt', now)
                  .lt('scheduledAt', to),
              )
              .take(120),
          ])

    const kept = [...past, ...future]
      .filter((j) => j.status !== 'cancelled')
      .sort((a, b) => Math.abs(a.scheduledAt - now) - Math.abs(b.scheduledAt - now))
      .slice(0, 150)

    const properties = new Map<Id<'properties'>, Promise<Doc<'properties'> | null>>()
    const propertyOf = (id: Id<'properties'>) => {
      const hit = properties.get(id)
      if (hit) return hit
      const pending = ctx.db.get(id)
      properties.set(id, pending)
      return pending
    }
    const clientNames = new Map<Id<'properties'>, Promise<string>>()
    const clientNameFor = (id: Id<'properties'>) => {
      const hit = clientNames.get(id)
      if (hit) return hit
      const pending = propertyOf(id).then((property) => clientNameOf(ctx, property))
      clientNames.set(id, pending)
      return pending
    }

    return Promise.all(
      kept.map(async (job) => {
        const property = await propertyOf(job.propertyId)
        return {
          _id: job._id,
          jobNumber: job.jobNumber,
          jobType: job.jobType,
          scheduledAt: job.scheduledAt,
          status: job.status,
          clientName: await clientNameFor(job.propertyId),
          suburb: property?.suburb ?? '',
        }
      }),
    )
  },
})

export const attachmentUrls = query({
  args: { businessId: v.id('businesses'), noteId: v.id('notes') },
  handler: async (ctx, { businessId, noteId }) => {
    await requireReadableNote(ctx, businessId, noteId)
    const rows = await ctx.db
      .query('noteAttachments')
      .withIndex('by_note', (q) => q.eq('noteId', noteId))
      .take(200)
    const urls: Record<string, string | null> = {}
    for (const row of rows) urls[row.storageId] = await ctx.storage.getUrl(row.storageId)
    return urls
  },
})

// ---------------------------------------------------------------------------
// Writing

type Links = {
  jobId?: Id<'jobs'>
  propertyId?: Id<'properties'>
  clientId?: Id<'clients'>
}

/**
 * A job link carries its property and client; a property link carries its
 * client — so every note about a client is found by `by_client` alone.
 * A job the caller cannot see reads as NOT_FOUND, as `jobs.get` does.
 */
async function resolveLinks(
  ctx: QueryCtx,
  viewer: NoteViewer,
  args: Links,
): Promise<Links> {
  const businessId = viewer.real.businessId
  if (args.jobId) {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.businessId !== businessId) throw new ConvexError('NOT_FOUND')
    // Linking is a write: judged as the real caller, not the viewed-as one.
    const visibility = jobVisibility(viewer.real)
    if (
      visibility.scope === 'assignee' &&
      job.assignedMembershipId !== visibility.membershipId
    ) {
      throw new ConvexError('NOT_FOUND')
    }
    const property = await ctx.db.get(job.propertyId)
    return { jobId: job._id, propertyId: job.propertyId, clientId: property?.clientId }
  }
  if (args.propertyId) {
    const property = await ctx.db.get(args.propertyId)
    if (!property || property.businessId !== businessId) throw new ConvexError('NOT_FOUND')
    return { propertyId: property._id, clientId: property.clientId }
  }
  if (args.clientId) {
    const client = await ctx.db.get(args.clientId)
    if (!client || client.businessId !== businessId) throw new ConvexError('NOT_FOUND')
    return { clientId: client._id }
  }
  return {}
}

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    template: v.optional(noteTemplate),
    title: v.optional(v.string()),
    jobId: v.optional(v.id('jobs')),
    propertyId: v.optional(v.id('properties')),
    clientId: v.optional(v.id('clients')),
  },
  handler: async (ctx, args) => {
    const viewer = await noteViewer(ctx, args.businessId)
    const links = await resolveLinks(ctx, viewer, args)

    const doc = NOTE_TEMPLATES[args.template ?? 'blank'].doc(args.title?.trim() ?? '')
    const derived = deriveNoteFields(doc)
    const now = Date.now()

    const noteId = await ctx.db.insert('notes', {
      businessId: args.businessId,
      authorMembershipId: viewer.real._id,
      lastEditedByMembershipId: viewer.real._id,
      ...links,
      title: derived.title,
      preview: derived.preview,
      plainText: derived.plainText,
      checklistTotal: derived.checklistTotal || undefined,
      checklistDone: derived.checklistTotal ? derived.checklistDone : undefined,
      createdAt: now,
      updatedAt: now,
    })
    await prosemirrorSync.create(ctx, noteId, doc)
    return noteId
  },
})

async function requireWritableNote(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  noteId: Id<'notes'>,
) {
  const { note, viewer } = await requireReadableNote(ctx, businessId, noteId)
  if (!(await canWriteNote(ctx, viewer, note))) throw new ConvexError('NO_ACCESS')
  return { note, viewer }
}

export const setLinks = mutation({
  args: { businessId: v.id('businesses'), noteId: v.id('notes'), link: noteLink },
  handler: async (ctx, { businessId, noteId, link }) => {
    const { viewer } = await requireWritableNote(ctx, businessId, noteId)
    const links = await resolveLinks(
      ctx,
      viewer,
      link.kind === 'job'
        ? { jobId: link.jobId }
        : link.kind === 'property'
          ? { propertyId: link.propertyId }
          : link.kind === 'client'
            ? { clientId: link.clientId }
            : {},
    )
    // Explicit undefineds clear whichever links the new kind does not carry.
    await ctx.db.patch(noteId, {
      jobId: links.jobId,
      propertyId: links.propertyId,
      clientId: links.clientId,
      updatedAt: Date.now(),
    })
  },
})

export const togglePin = mutation({
  args: { businessId: v.id('businesses'), noteId: v.id('notes') },
  handler: async (ctx, { businessId, noteId }) => {
    const { note } = await requireWritableNote(ctx, businessId, noteId)
    await ctx.db.patch(noteId, {
      pinnedAt: note.pinnedAt === undefined ? Date.now() : undefined,
    })
  },
})

export const markMentionsRead = mutation({
  args: { businessId: v.id('businesses'), noteId: v.id('notes') },
  handler: async (ctx, { businessId, noteId }) => {
    const me = await requireMembership(ctx, businessId)
    const rows = await ctx.db
      .query('noteMentions')
      .withIndex('by_note', (q) => q.eq('noteId', noteId))
      .filter((q) =>
        q.and(
          q.eq(q.field('membershipId'), me._id),
          q.eq(q.field('readAt'), undefined),
        ),
      )
      .take(10)
    for (const row of rows) await ctx.db.patch(row._id, { readAt: Date.now() })
  },
})

async function requireDeletable(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  noteId: Id<'notes'>,
) {
  const me = await requireMembership(ctx, businessId)
  const note = await requireNote(ctx, businessId, noteId)
  if (!canDeleteNote(me, note)) throw new ConvexError('NO_ACCESS')
  return note
}

export const softDelete = mutation({
  args: { businessId: v.id('businesses'), noteId: v.id('notes') },
  handler: async (ctx, { businessId, noteId }) => {
    await requireDeletable(ctx, businessId, noteId)
    await ctx.db.patch(noteId, { deletedAt: Date.now(), pinnedAt: undefined })
  },
})

export const restore = mutation({
  args: { businessId: v.id('businesses'), noteId: v.id('notes') },
  handler: async (ctx, { businessId, noteId }) => {
    await requireDeletable(ctx, businessId, noteId)
    await ctx.db.patch(noteId, { deletedAt: undefined, updatedAt: Date.now() })
  },
})

/**
 * Gone for good: the row, its mentions, its photos and its edit history.
 * Only from Recently Deleted — the 30-day safety net is not optional.
 */
export const remove = mutation({
  args: { businessId: v.id('businesses'), noteId: v.id('notes') },
  handler: async (ctx, { businessId, noteId }) => {
    const note = await requireDeletable(ctx, businessId, noteId)
    if (note.deletedAt === undefined) throw new ConvexError('NOT_IN_TRASH')
    await purgeNote(ctx, note)
  },
})

async function purgeNote(ctx: MutationCtx, note: Note) {
  const mentions = await ctx.db
    .query('noteMentions')
    .withIndex('by_note', (q) => q.eq('noteId', note._id))
    .collect()
  for (const row of mentions) await ctx.db.delete(row._id)

  const attachments = await ctx.db
    .query('noteAttachments')
    .withIndex('by_note', (q) => q.eq('noteId', note._id))
    .collect()
  for (const row of attachments) {
    await ctx.db.delete(row._id)
    // The file goes only when nothing else references it — this is the one
    // `storage.delete` in the backend, so it must never reach a file the
    // notes feature does not own.
    const stillReferenced = await ctx.db
      .query('noteAttachments')
      .withIndex('by_storage', (q) => q.eq('storageId', row.storageId))
      .first()
    if (!stillReferenced) await ctx.storage.delete(row.storageId)
  }

  await ctx.runMutation(components.prosemirrorSync.lib.deleteDocument, {
    id: note._id,
  })
  await ctx.db.delete(note._id)
}

export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TRASH_RETENTION_MS
    const batch = await ctx.db
      .query('notes')
      .withIndex('by_deletedAt', (q) => q.gt('deletedAt', 0).lt('deletedAt', cutoff))
      .take(25)
    for (const note of batch) await purgeNote(ctx, note)
    if (batch.length === 25) {
      await ctx.scheduler.runAfter(0, internal.notes.purgeExpired, {})
    }
  },
})

// ---------------------------------------------------------------------------
// Photos

export const generateUploadUrl = mutation({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    return ctx.storage.generateUploadUrl()
  },
})

export const addAttachment = mutation({
  args: {
    businessId: v.id('businesses'),
    noteId: v.id('notes'),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, { businessId, noteId, storageId }) => {
    await requireWritableNote(ctx, businessId, noteId)

    // Storage ids are not secrets (report queries hand them out), so a note
    // may only claim a file that was just uploaded and is not yet claimed.
    const file = await ctx.db.system.get('_storage', storageId)
    if (!file || Date.now() - file._creationTime > ATTACH_WINDOW_MS) {
      throw new ConvexError('NOT_FOUND')
    }
    const claimed = await ctx.db
      .query('noteAttachments')
      .withIndex('by_storage', (q) => q.eq('storageId', storageId))
      .first()
    if (claimed) throw new ConvexError('ALREADY_ATTACHED')

    await ctx.db.insert('noteAttachments', { noteId, storageId, createdAt: Date.now() })
    return ctx.storage.getUrl(storageId)
  },
})
