import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation } from '../_generated/server'
import { deriveNoteFields, docFromPlainText } from '../lib/richText'
import { prosemirrorSync } from '../notesSync'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { PmNode } from '../lib/richText'

/**
 * One-off: plain-text notes → prosemirror-sync documents, and the free-text
 * `clients.notes` / `properties.notes` fields → pinned notes in the library.
 *
 * Expand → migrate → contract. Already run on the dev deployment; for any
 * other deployment (prod) the sequence is:
 *
 * 1. EXPAND — deploy with `npx convex deploy --typecheck disable` after
 *    temporarily loosening convex/schema.ts so the existing rows validate:
 *
 *      notes:      lastEditedByMembershipId, title, preview, plainText and
 *                  updatedAt wrapped in v.optional(...), plus
 *                  text: v.optional(v.string())
 *      clients:    notes: v.optional(v.string())   (re-add)
 *      properties: notes: v.optional(v.string())   (re-add)
 *
 * 2. MIGRATE — each batch schedules the next, so each finishes on its own:
 *
 *      npx convex run migrations/notesV2:backfillNotes '{"cursor":null}' --prod
 *      npx convex run migrations/notesV2:foldClientNotes '{"cursor":null}' --prod
 *      npx convex run migrations/notesV2:foldPropertyNotes '{"cursor":null}' --prod
 *
 *    Verify with `npx convex data notes --prod`: no `text` column remains.
 *
 * 3. CONTRACT — revert the loosening (git checkout convex/schema.ts) and
 *    deploy again. Re-running a step is safe: every mutation skips rows it
 *    has already converted.
 */

type LegacyNote = Doc<'notes'> & { text?: string }
type LegacyClient = Doc<'clients'> & { notes?: string }
type LegacyProperty = Doc<'properties'> & { notes?: string }

const PAGE = 25

export const backfillNotes = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('notes').paginate({ numItems: PAGE, cursor })

    for (const row of page.page) {
      const note = row as LegacyNote
      if (note.text === undefined) continue

      const doc = docFromPlainText(note.text)
      const derived = deriveNoteFields(doc)
      const job = note.jobId ? await ctx.db.get(note.jobId) : null
      const propertyId = note.propertyId ?? job?.propertyId
      const property = propertyId ? await ctx.db.get(propertyId) : null

      await ctx.db.patch(note._id, {
        propertyId,
        clientId: property?.clientId,
        title: derived.title,
        preview: derived.preview,
        plainText: derived.plainText,
        lastEditedByMembershipId: note.authorMembershipId,
        updatedAt: note.createdAt,
        text: undefined,
      } as unknown as Partial<Doc<'notes'>>)
      await prosemirrorSync.create(ctx, note._id, doc)
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.notesV2.backfillNotes, {
        cursor: page.continueCursor,
      })
    }
  },
})

export const foldClientNotes = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('clients').paginate({ numItems: PAGE, cursor })

    for (const row of page.page) {
      const client = row as LegacyClient
      if (!client.notes?.trim()) continue
      await pinnedNote(ctx, client.businessId, docFromPlainText(`${client.name}\n${client.notes}`), {
        clientId: client._id,
      })
      await ctx.db.patch(client._id, { notes: undefined } as Partial<LegacyClient>)
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.notesV2.foldClientNotes, {
        cursor: page.continueCursor,
      })
    }
  },
})

export const foldPropertyNotes = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('properties').paginate({ numItems: PAGE, cursor })

    for (const row of page.page) {
      const property = row as LegacyProperty
      if (!property.notes?.trim()) continue
      await pinnedNote(
        ctx,
        property.businessId,
        docFromPlainText(`${property.addressLine}\n${property.notes}`),
        { propertyId: property._id, clientId: property.clientId },
      )
      await ctx.db.patch(property._id, { notes: undefined } as Partial<LegacyProperty>)
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.notesV2.foldPropertyNotes, {
        cursor: page.continueCursor,
      })
    }
  },
})

/** Authored by the business owner — the free-text fields never recorded who wrote them. */
async function pinnedNote(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  doc: PmNode,
  links: { propertyId?: Id<'properties'>; clientId?: Id<'clients'> },
) {
  const owner = await ctx.db
    .query('memberships')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .filter((q) => q.eq(q.field('role'), 'owner'))
    .first()
  if (!owner) return

  const derived = deriveNoteFields(doc)
  const now = Date.now()
  const noteId = await ctx.db.insert('notes', {
    businessId,
    authorMembershipId: owner._id,
    lastEditedByMembershipId: owner._id,
    ...links,
    title: derived.title,
    preview: derived.preview,
    plainText: derived.plainText,
    pinnedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  await prosemirrorSync.create(ctx, noteId, doc)
}
