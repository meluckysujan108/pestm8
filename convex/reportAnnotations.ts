import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import { canSeeReport } from './reports'
import type { Ctx } from './lib/access'
import type { Id } from './_generated/dataModel'

/**
 * Deliberately *not* `requireEditableReport` (the guard every other report
 * mutation uses, which throws `REPORT_FINALISED`). `ReportActionBar.tsx`
 * only ever renders the PDF tab once a report is finalised, so annotations
 * are structurally only ever created after finalising — reusing that guard
 * wouldn't add safety, it would make the feature permanently unreachable.
 * Annotations don't touch `reports.data`, photos, or `pdfStorageId`; the
 * immutability rule was never about this table. Mirrors `canSeeReport`'s
 * existing visibility rule instead — the same business-wide-for-owners,
 * author-only-otherwise scoping every other read of a report already uses.
 */
async function requireVisibleReport(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  reportId: Id<'reports'>,
) {
  const membership = await requireMembership(ctx, businessId)
  const report = await ctx.db.get(reportId)
  if (!report || report.businessId !== businessId) {
    throw new ConvexError('NOT_FOUND')
  }
  if (report.deletedAt !== undefined) throw new ConvexError('NOT_FOUND')
  if (!canSeeReport(membership, report)) throw new ConvexError('NO_ACCESS')
  return { membership, report }
}

export const addStroke = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    page: v.number(),
    points: v.array(v.object({ x: v.number(), y: v.number() })),
  },
  handler: async (ctx, { businessId, reportId, page, points }) => {
    const { membership } = await requireVisibleReport(ctx, businessId, reportId)
    await ctx.db.insert('reportPdfAnnotations', {
      reportId,
      page,
      authorMembershipId: membership._id,
      points,
      createdAt: Date.now(),
    })
  },
})

/**
 * Per-author, not global — one person's undo must not delete a stroke drawn
 * by someone else they can't even tell apart from their own.
 */
export const undoLastStroke = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    page: v.number(),
  },
  handler: async (ctx, { businessId, reportId, page }) => {
    const { membership } = await requireVisibleReport(ctx, businessId, reportId)

    const mine = await ctx.db
      .query('reportPdfAnnotations')
      .withIndex('by_report_page', (q) =>
        q.eq('reportId', reportId).eq('page', page),
      )
      .filter((q) => q.eq(q.field('authorMembershipId'), membership._id))
      .collect()

    if (mine.length === 0) return
    const last = mine.sort((a, b) => b.createdAt - a.createdAt)[0]
    await ctx.db.delete(last._id)
  },
})

/**
 * Deliberately not a global "clear page" — that would let any visible member
 * erase another reviewer's markup, a real multi-user risk worth designing
 * out now rather than patching later.
 */
export const clearMyStrokes = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    page: v.number(),
  },
  handler: async (ctx, { businessId, reportId, page }) => {
    const { membership } = await requireVisibleReport(ctx, businessId, reportId)

    const mine = await ctx.db
      .query('reportPdfAnnotations')
      .withIndex('by_report_page', (q) =>
        q.eq('reportId', reportId).eq('page', page),
      )
      .filter((q) => q.eq(q.field('authorMembershipId'), membership._id))
      .collect()

    for (const stroke of mine) await ctx.db.delete(stroke._id)
  },
})

/**
 * Everyone's strokes are visible; only your own are erasable via undo/clear
 * above — the safe default until the product decides otherwise. Whether one
 * author's marks should be editable by another doesn't require a schema
 * change either way.
 */
export const listAnnotations = query({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    page: v.number(),
  },
  handler: async (ctx, { businessId, reportId, page }) => {
    await requireVisibleReport(ctx, businessId, reportId)

    const strokes = await ctx.db
      .query('reportPdfAnnotations')
      .withIndex('by_report_page', (q) =>
        q.eq('reportId', reportId).eq('page', page),
      )
      .collect()

    return strokes
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((stroke) => ({
        _id: stroke._id,
        authorMembershipId: stroke.authorMembershipId,
        points: stroke.points,
      }))
  },
})
