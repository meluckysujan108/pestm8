import { ConvexError } from 'convex/values'
import { jobVisibility, requireMembership, resolveViewScope } from './access'
import type { Doc, Id } from '../_generated/dataModel'
import type { Ctx, Membership } from './access'

export type Note = Doc<'notes'>
export type NoteKind = 'job' | 'site' | 'client' | 'team'

/** What a note is about, read from its links — see the schema comment. */
export function noteKind(note: {
  jobId?: Id<'jobs'>
  propertyId?: Id<'properties'>
  clientId?: Id<'clients'>
}): NoteKind {
  if (note.jobId) return 'job'
  if (note.propertyId) return 'site'
  if (note.clientId) return 'client'
  return 'team'
}

/**
 * Resolved once per request and threaded through, so a list query does not
 * re-resolve the caller for every row. `real` is who is actually here (for
 * authorship, mentions, deletion); `scope` honours "view as" for job
 * visibility only, exactly as `jobs.get` does.
 */
export type NoteViewer = { real: Membership; scope: Membership }

export async function noteViewer(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<NoteViewer> {
  const real = await requireMembership(ctx, businessId)
  const scope = await resolveViewScope(ctx, businessId)
  return { real, scope }
}

/**
 * Knowledge-first policy: site, client and team notes are the business's
 * shared knowledge and every active member can read them — a gate code or
 * "dog on site" is exactly what a subcontractor turning up needs. Job notes
 * follow job visibility (the assignee, or anyone with business-wide scope),
 * and being @mentioned in a note always grants read on that note.
 */
export async function canReadNote(
  ctx: Ctx,
  viewer: NoteViewer,
  note: Note,
): Promise<boolean> {
  if (note.businessId !== viewer.real.businessId) return false

  const mine = note.authorMembershipId === viewer.real._id
  if (note.deletedAt !== undefined) return mine || viewer.real.role === 'owner'

  if (noteKind(note) !== 'job') return true
  if (mine) return true

  const visibility = jobVisibility(viewer.scope)
  if (visibility.scope === 'business') return true

  const job = note.jobId ? await ctx.db.get(note.jobId) : null
  if (job?.assignedMembershipId === visibility.membershipId) return true

  return isMentioned(ctx, note._id, viewer.real._id)
}

/**
 * Anyone who can read a note can edit it — shared knowledge stays fixable.
 * Except that writes never honour "view as": it is a read-only lens, so
 * the write decision is made as the REAL caller, exactly as `canEditJob`.
 */
export async function canWriteNote(
  ctx: Ctx,
  viewer: NoteViewer,
  note: Note,
): Promise<boolean> {
  if (note.deletedAt !== undefined) return false
  return canReadNote(ctx, { real: viewer.real, scope: viewer.real }, note)
}

/** Deletion keeps today's rule: what you wrote, or anything if you own the business. */
export function canDeleteNote(real: Membership, note: Note): boolean {
  return real.role === 'owner' || note.authorMembershipId === real._id
}

export async function isMentioned(
  ctx: Ctx,
  noteId: Id<'notes'>,
  membershipId: Id<'memberships'>,
): Promise<boolean> {
  const row = await ctx.db
    .query('noteMentions')
    .withIndex('by_note', (q) => q.eq('noteId', noteId))
    .filter((q) => q.eq(q.field('membershipId'), membershipId))
    .first()
  return row !== null
}

export async function requireNote(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  noteId: Id<'notes'>,
): Promise<Note> {
  const note = await ctx.db.get(noteId)
  if (!note || note.businessId !== businessId) throw new ConvexError('NOT_FOUND')
  return note
}

/** NOT_FOUND rather than NO_ACCESS: a hidden note must look like no note. */
export async function requireReadableNote(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  noteId: Id<'notes'>,
): Promise<{ note: Note; viewer: NoteViewer }> {
  const viewer = await noteViewer(ctx, businessId)
  const note = await requireNote(ctx, businessId, noteId)
  if (!(await canReadNote(ctx, viewer, note))) throw new ConvexError('NOT_FOUND')
  return { note, viewer }
}
