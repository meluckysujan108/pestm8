import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import {
  MAX_SNIPPETS,
  MAX_SNIPPETS_PER_FIELD,
  MAX_SNIPPET_LENGTH,
  sameSnippet,
  snippetOrder,
} from '../src/lib/reportTemplates/snippets'

/**
 * Phrases: the wording a business reuses in the long-answer boxes.
 *
 * Any member may add one, which is the difference between this and an option
 * library. A library IS the answer — a controlled vocabulary that prints as a
 * chosen value, so only an owner changes it. A phrase is a head start on an
 * answer the technician was going to type anyway, in a box that accepts
 * anything; saving it grants nobody an authority the form did not already
 * give them, and it saves everyone else the same thumb-typing.
 */

/**
 * Every phrase this business holds, newest use first.
 *
 * Read whole rather than per field: a business keeps a couple of dozen across
 * the whole form, and one cached query beats a request each time a technician
 * opens a section.
 */
export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)

    const rows = await ctx.db
      .query('reportSnippets')
      .withIndex('by_business_field', (q) => q.eq('businessId', businessId))
      .take(MAX_SNIPPETS)

    return snippetOrder(
      rows.map((row) => ({
        id: row._id,
        fieldKey: row.fieldKey,
        text: row.text,
        usedCount: row.usedCount,
        createdAt: row.createdAt,
      })),
    )
  },
})

/** Keeps what was written in this box, for the next report that asks it. */
export const save = mutation({
  args: {
    businessId: v.id('businesses'),
    fieldKey: v.string(),
    text: v.string(),
  },
  handler: async (ctx, { businessId, fieldKey, text }) => {
    const membership = await requireMembership(ctx, businessId)

    const trimmed = text.trim()
    if (trimmed === '' || trimmed.length > MAX_SNIPPET_LENGTH) {
      throw new ConvexError('INVALID_SNIPPET')
    }

    const existing = await ctx.db
      .query('reportSnippets')
      .withIndex('by_business_field', (q) =>
        q.eq('businessId', businessId).eq('fieldKey', fieldKey),
      )
      .take(MAX_SNIPPETS_PER_FIELD + 1)

    // Saving the same sentence twice is what happens when somebody taps it a
    // second time to be sure, and two entries nobody can tell apart is worse
    // than a refusal.
    const already = existing.find((row) => sameSnippet(row.text, trimmed))
    if (already) return already._id

    if (existing.length >= MAX_SNIPPETS_PER_FIELD) {
      throw new ConvexError('TOO_MANY_SNIPPETS')
    }

    return ctx.db.insert('reportSnippets', {
      businessId,
      fieldKey,
      text: trimmed,
      createdByMembershipId: membership._id,
      usedCount: 0,
      createdAt: Date.now(),
    })
  },
})

/**
 * Records that a phrase was reached for, which is what orders the list.
 *
 * Fire and forget from the client: nothing about the answer depends on this
 * landing, and a report is not the place to surface a failed tally.
 */
export const used = mutation({
  args: {
    businessId: v.id('businesses'),
    snippetId: v.id('reportSnippets'),
  },
  handler: async (ctx, { businessId, snippetId }) => {
    await requireMembership(ctx, businessId)

    const row = await ctx.db.get(snippetId)
    if (!row || row.businessId !== businessId) return

    await ctx.db.patch(snippetId, {
      usedCount: row.usedCount + 1,
      lastUsedAt: Date.now(),
    })
  },
})

/**
 * Drops a phrase. Its author or an owner — the person who wrote it, or the
 * person answerable for what the business's reports say.
 */
export const remove = mutation({
  args: {
    businessId: v.id('businesses'),
    snippetId: v.id('reportSnippets'),
  },
  handler: async (ctx, { businessId, snippetId }) => {
    const membership = await requireMembership(ctx, businessId)

    const row = await ctx.db.get(snippetId)
    if (!row || row.businessId !== businessId) throw new ConvexError('NOT_FOUND')
    if (
      membership.role !== 'owner' &&
      row.createdByMembershipId !== membership._id
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    await ctx.db.delete(snippetId)
  },
})
