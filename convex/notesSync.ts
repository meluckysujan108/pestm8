import { ProsemirrorSync } from '@convex-dev/prosemirror-sync'
import { ConvexError } from 'convex/values'
import { components } from './_generated/api'
import { requireMembership } from './lib/access'
import { canReadNote, canWriteNote, noteViewer } from './lib/noteAccess'
import { deriveNoteFields } from './lib/richText'
import type { DataModel, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Membership } from './lib/access'
import type { Note } from './lib/noteAccess'
import type { PmNode } from './lib/richText'

/**
 * Note bodies live in the prosemirror-sync component, keyed by the `notes`
 * row id. The component merges concurrent edits step by step (operational
 * transforms), so two people in the same site note never overwrite each
 * other — the failure `reports.data` has suffered twice.
 */
export const prosemirrorSync = new ProsemirrorSync<Id<'notes'>>(
  components.prosemirrorSync,
)

async function noteFromSyncId(ctx: QueryCtx, id: string): Promise<Note> {
  const noteId = ctx.db.normalizeId('notes', id)
  const note = noteId ? await ctx.db.get(noteId) : null
  if (!note) throw new ConvexError('NOT_FOUND')
  return note
}

export const { getSnapshot, submitSnapshot, latestVersion, getSteps, submitSteps } =
  prosemirrorSync.syncApi<DataModel>({
    checkRead: async (ctx, id) => {
      const note = await noteFromSyncId(ctx, id)
      const viewer = await noteViewer(ctx, note.businessId)
      if (!(await canReadNote(ctx, viewer, note))) {
        throw new ConvexError('NOT_FOUND')
      }
    },
    checkWrite: async (ctx, id) => {
      const note = await noteFromSyncId(ctx, id)
      const viewer = await noteViewer(ctx, note.businessId)
      if (!(await canWriteNote(ctx, viewer, note))) {
        throw new ConvexError('NO_ACCESS')
      }
    },
    // Runs inside the same mutation that stores the snapshot — and before the
    // component does — so the list metadata and the mention rows can never
    // drift from the body.
    onSnapshot: async (ctx, id, snapshot, version) => {
      // A snapshot queued offline can arrive after a newer one has landed;
      // only the newest body may drive the row metadata and the mentions.
      const latest = await ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, { id })
      if (latest.content !== null && latest.version >= version) return
      const note = await noteFromSyncId(ctx, id)
      const actor = await requireMembership(ctx, note.businessId)
      const doc = JSON.parse(snapshot) as PmNode
      await applyDerived(ctx, note, actor, doc)
    },
    pruneSnapshots: true,
  })

/** Derive the row's metadata from a document and reconcile its mentions. */
export async function applyDerived(
  ctx: MutationCtx,
  note: Note,
  actor: Membership,
  doc: PmNode,
): Promise<void> {
  const derived = deriveNoteFields(doc)
  await ctx.db.patch(note._id, {
    title: derived.title,
    preview: derived.preview,
    plainText: derived.plainText,
    checklistTotal: derived.checklistTotal || undefined,
    checklistDone: derived.checklistTotal ? derived.checklistDone : undefined,
    updatedAt: Date.now(),
    lastEditedByMembershipId: actor._id,
  })
  await syncMentions(ctx, note, actor, derived.mentionIds)
}

async function syncMentions(
  ctx: MutationCtx,
  note: Note,
  actor: Membership,
  rawIds: Array<string>,
): Promise<void> {
  // Ids come from the document, i.e. from a client: only a real, non-removed
  // member of THIS business becomes a mention row.
  const wanted = new Set<Id<'memberships'>>()
  for (const raw of rawIds) {
    const id = ctx.db.normalizeId('memberships', raw)
    const member = id ? await ctx.db.get(id) : null
    if (member && member.businessId === note.businessId && member.status !== 'removed') {
      wanted.add(member._id)
    }
  }

  const existing = await ctx.db
    .query('noteMentions')
    .withIndex('by_note', (q) => q.eq('noteId', note._id))
    .collect()

  for (const row of existing) {
    if (!wanted.has(row.membershipId)) await ctx.db.delete(row._id)
  }

  const have = new Set(existing.map((row) => row.membershipId))
  const now = Date.now()
  for (const membershipId of wanted) {
    if (have.has(membershipId)) continue
    await ctx.db.insert('noteMentions', {
      businessId: note.businessId,
      noteId: note._id,
      membershipId,
      mentionedByMembershipId: actor._id,
      createdAt: now,
      // Tagging yourself should not light up your own badge.
      readAt: membershipId === actor._id ? now : undefined,
    })
  }
}
