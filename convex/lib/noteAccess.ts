import { ConvexError } from 'convex/values'
import { requireActor } from './actor'
import { isInScope } from './capabilities'
import type { MembershipFacts, RowScope } from './capabilities'
import type { Doc, Id } from '../_generated/dataModel'
import type { Ctx } from './access'

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
export type NoteViewer = {
  real: MembershipFacts
  scope: MembershipFacts
  /** Rows the lens they are looking through may read — job-note visibility. */
  readRows: RowScope
  /** Rows the real person may read: a note is attached as yourself, never
   * as whoever you are looking at. What writes are checked against. */
  ownRows: RowScope
  /** What the attach-to-job picker OFFERS — `ownRows`, narrowed to their own
   * jobs when they have chosen "Just my jobs". A choice of what to be shown,
   * so it is read by the picker and by nothing that decides what is allowed. */
  pickerRows: RowScope
  /**
   * The owner, standing in God view as himself: not in "Just my jobs", not
   * switched into an account, not looking through anyone. Only this LISTS
   * other people's personal notes ("Everyone's notes"). It never decides
   * whether one may be read — `canReadNote` asks the real role for that — so
   * a note opened by link reads the same in any view.
   */
  godView: boolean
}

export async function noteViewer(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<NoteViewer> {
  // One resolution, not two: this used to call requireMembership and then
  // resolveViewScope, which called it again — two round trips to answer one
  // question, and two answers that could disagree.
  const env = await requireActor(ctx, businessId)
  return {
    godView:
      env.actor.real.role === 'owner' &&
      env.view === 'everyone' &&
      env.actor.session === null &&
      !env.viewingAsLegacy,
    real: env.actor.real,
    scope: env.readScope,
    readRows: env.scope,
    ownRows: env.realScope,
    // Standing in their own account, `listScope` is their own rows as their
    // chosen view shows them. Looking through anyone else, it is that
    // person's — and the picker offers what you would attach as yourself.
    pickerRows:
      env.readScope._id === env.actor.real._id ? env.listScope : env.realScope,
  }
}

export function isPrivate(note: Pick<Note, 'visibility'>): boolean {
  return note.visibility === 'private'
}

/**
 * Knowledge-first policy: site, client and team notes are the business's
 * shared knowledge and every active member can read them — a gate code or
 * "dog on site" is exactly what a subcontractor turning up needs. Job notes
 * follow job visibility (the assignee, or anyone with business-wide scope),
 * and being @mentioned in a note always grants read on that note.
 *
 * A personal note is the exception, and it is decided on the REAL person
 * before any of that: its author, and the owner of the business. Not a
 * contractor over the author, not anyone looking through the author's
 * account, and not an @mention — job scope and lenses say nothing about it.
 */
export async function canReadNote(
  ctx: Ctx,
  viewer: NoteViewer,
  note: Note,
): Promise<boolean> {
  if (note.businessId !== viewer.real.businessId) return false

  const mine = note.authorMembershipId === viewer.real._id
  if (isPrivate(note)) return mine || viewer.real.role === 'owner'
  if (note.deletedAt !== undefined) return mine || viewer.real.role === 'owner'

  if (noteKind(note) !== 'job') return true
  if (mine) return true

  const job = note.jobId ? await ctx.db.get(note.jobId) : null
  if (job && isInScope(viewer.readRows, job)) return true

  return isMentioned(ctx, note._id, viewer.real._id)
}

/**
 * Anyone who can read a note can edit it — shared knowledge stays fixable.
 * Except that writes never honour "view as": it is a read-only lens, so
 * the write decision is made as the REAL caller.
 */
export async function canWriteNote(
  ctx: Ctx,
  viewer: NoteViewer,
  note: Note,
): Promise<boolean> {
  if (note.deletedAt !== undefined) return false
  // Personal notes are written by their author alone. The owner reads them;
  // an employer editing someone's own notes is not what was agreed.
  if (isPrivate(note)) return note.authorMembershipId === viewer.real._id
  // Re-asked as the real person, looking through nobody: "view as" is a lens,
  // and a lens has never granted the right to write what it shows you.
  return canReadNote(
    ctx,
    {
      real: viewer.real,
      scope: viewer.real,
      readRows: viewer.ownRows,
      ownRows: viewer.ownRows,
      pickerRows: viewer.ownRows,
      godView: false,
    },
    note,
  )
}

/** Deletion keeps today's rule: what you wrote, or anything if you own the
 * business — personal notes included, so an owner can clear out what a
 * departed member left behind. */
export function canDeleteNote(real: MembershipFacts, note: Note): boolean {
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
  if (!note || note.businessId !== businessId)
    throw new ConvexError('NOT_FOUND')
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
  if (!(await canReadNote(ctx, viewer, note)))
    throw new ConvexError('NOT_FOUND')
  return { note, viewer }
}
