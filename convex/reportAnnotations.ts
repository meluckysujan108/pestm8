import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { reportReadable } from './lib/capabilities'
import { normaliseColour } from './lib/colours'
import {
  MAX_POINTS_PER_AUTHOR,
  MAX_POINTS_PER_REPORT,
  MAX_STROKES_PER_AUTHOR,
  MAX_STROKES_PER_REPORT,
  strokeToStore,
} from './lib/reportMarkup'
import type { Ctx } from './lib/access'
import type { Id } from './_generated/dataModel'
import { requireActor } from './lib/actor'

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
  // The REAL caller, deliberately: an annotation is authored, and the
  // read-only view-as has never granted authorship. `requireActor` resolves
  // both halves; this one wants the human.
  const env = await requireActor(ctx, businessId)
  const membership = env.actor.real
  const report = await ctx.db.get(reportId)
  if (!report || report.businessId !== businessId) {
    throw new ConvexError('NOT_FOUND')
  }
  if (report.deletedAt !== undefined) throw new ConvexError('NOT_FOUND')
  if (!reportReadable(env.realScope, env.actor.real._id, report)) {
    throw new ConvexError('NO_ACCESS')
  }
  return { membership, report }
}

const point = v.object({ x: v.number(), y: v.number() })

export const addStroke = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    /** 1-based, as it has always been stored. */
    page: v.number(),
    points: v.array(point),
  },
  // The new row, so a viewer showing the stroke while it saves can tell its
  // own mark has arrived. The old viewer ignores it; it returned nothing.
  returns: v.id('reportPdfAnnotations'),
  handler: async (ctx, { businessId, reportId, page, points: sent }) => {
    const { membership } = await requireVisibleReport(ctx, businessId, reportId)

    // Pulled in rather than refused when it only runs off the page: the old
    // viewer sends where the finger went and drops a refusal on the floor.
    const points = strokeToStore(page, sent)
    if (!points) throw new ConvexError('INVALID_STROKE')

    // Read whole, because there is no count to ask for: `listForReport`
    // reads at most `MAX_STROKES_PER_REPORT` rows, and a stroke saved past it
    // — or past the points one query can afford to read — would be kept and
    // shown to nobody, which is worse than a refusal the viewer can explain.
    const held = await ctx.db
      .query('reportPdfAnnotations')
      .withIndex('by_report_page', (q) => q.eq('reportId', reportId))
      .take(MAX_STROKES_PER_REPORT)
    const pointsIn = (rows: typeof held) =>
      rows.reduce((sum, row) => sum + row.points.length, 0)

    // The caller's own share first: only they can make room in it, so this
    // refusal is the one that tells them to clear some of theirs. One person
    // alone can never fill the report for everyone else, who could not clear
    // a single mark of theirs (`MAX_STROKES_PER_AUTHOR`).
    const own = held.filter((row) => row.authorMembershipId === membership._id)
    if (
      own.length >= MAX_STROKES_PER_AUTHOR ||
      pointsIn(own) + points.length > MAX_POINTS_PER_AUTHOR
    ) {
      throw new ConvexError('TOO_MANY_STROKES')
    }
    // Then the report's: several people at their limit. Words of its own,
    // since the caller may have no marks here to clear.
    if (
      held.length >= MAX_STROKES_PER_REPORT ||
      pointsIn(held) + points.length > MAX_POINTS_PER_REPORT
    ) {
      throw new ConvexError('REPORT_FULL_OF_MARKS')
    }

    return ctx.db.insert('reportPdfAnnotations', {
      reportId,
      page,
      authorMembershipId: membership._id,
      points,
      createdAt: Date.now(),
    })
  },
})

/**
 * Takes back one mark, named by its id — the new viewer's Undo.
 *
 * By id rather than "my newest on this page", because the newest is only
 * the right answer at the moment Undo is tapped, and the server hears of the
 * tap later. A stroke drawn while the Undo waits for the one it means to
 * finish saving reaches the server first, and "newest" would then remove
 * that — the mark just drawn, kept on screen, gone from the record. The
 * viewer chooses its mark when the thumb lands (`pdf/localMarks.ts`) and names
 * it here, so what goes is what was aimed at, on whatever page.
 *
 * The rules are `undoLastStroke`'s and `clearMyStrokes`'s:
 *
 * - The gate is the same (`requireVisibleReport`, the REAL person): someone
 *   who could not read the report cannot remove its marks.
 * - The mark must be on this report, and so in this business: an id from
 *   another report is `NOT_FOUND`, never a way to reach a report the caller
 *   was not checked against.
 * - It must be the caller's own. Nobody — not the owner, who can see every
 *   mark in the business — removes a mark someone else drew (`NO_ACCESS`).
 * - A mark already gone is quietly nothing: two Undo taps a moment apart
 *   that both reached for it, or a Clear of its page that landed first. The
 *   caller asked for it not to be there, and it isn't.
 *
 * Alongside `undoLastStroke`, not instead of it: the live site's viewer
 * still calls that until this one ships, and the backend ships first.
 */
export const removeStroke = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    strokeId: v.id('reportPdfAnnotations'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, reportId, strokeId }) => {
    const { membership } = await requireVisibleReport(ctx, businessId, reportId)

    const stroke = await ctx.db.get(strokeId)
    if (!stroke) return null
    if (stroke.reportId !== reportId) throw new ConvexError('NOT_FOUND')
    if (stroke.authorMembershipId !== membership._id) {
      throw new ConvexError('NO_ACCESS')
    }
    await ctx.db.delete(stroke._id)
    return null
  },
})

/**
 * Per-author, not global — one person's undo must not delete a stroke drawn
 * by someone else they can't even tell apart from their own.
 *
 * Per page, as the old viewer asked for it; the new viewer names the exact
 * mark (`removeStroke`). Kept, with its arguments unchanged, while the old
 * viewer is still what the live site serves. It picks by the latest
 * `createdAt`, and of two in one millisecond the later-written.
 */
export const undoLastStroke = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    page: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, reportId, page }) => {
    const { membership } = await requireVisibleReport(ctx, businessId, reportId)

    const mine = await ctx.db
      .query('reportPdfAnnotations')
      .withIndex('by_report_page', (q) =>
        q.eq('reportId', reportId).eq('page', page),
      )
      .filter((q) => q.eq(q.field('authorMembershipId'), membership._id))
      .collect()

    if (mine.length === 0) return null
    const last = mine.sort(
      (a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime,
    )[0]
    await ctx.db.delete(last._id)
    return null
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
  returns: v.null(),
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
    return null
  },
})

/**
 * Everyone's strokes are visible; only your own are erasable via undo/clear
 * above — the safe default until the product decides otherwise. Whether one
 * author's marks should be editable by another doesn't require a schema
 * change either way.
 *
 * One page at a time, for the old viewer, which drew a canvas per page. Kept
 * with its shape unchanged while that viewer is still what the live site
 * serves; `listForReport` is what the new one reads.
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

/**
 * The colour a teammate's marks are drawn in: their member colour, the one
 * the schedule's rails and the history's dots already show them by.
 *
 * Null — the viewer's one neutral colour — for anyone no longer on the team.
 * A person who leaves gives their colour back and the next to join may be
 * dealt it (`memberships.ts`), so drawing a departed author's marks in it
 * would put them in the name of whoever holds it now.
 */
async function authorColourOf(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  membershipId: Id<'memberships'>,
): Promise<string | null> {
  const author = await ctx.db.get(membershipId)
  if (!author || author.businessId !== businessId) return null
  if (author.status !== 'active') return null
  return normaliseColour(author.colour)
}

/**
 * Every mark on a report, for the viewer that draws the whole document at
 * once — one subscription where the old viewer held one per page.
 *
 * The same gate as `listAnnotations`, and deliberately narrower than
 * `reports.get`: it asks of the REAL person (`realScope`), because the marks
 * come with a pen, and a pen is authorship, which looking through someone
 * else's account has never granted. Someone who can open the report but not
 * mark it gets `NO_ACCESS` here; the viewer then shows the report with no
 * pen and no marks rather than a tool that fails on first use.
 *
 * `page` stays 1-based, as stored — the viewer's slots count from 0, and the
 * conversion belongs in one place on the client rather than in two here.
 * `mine` is the rule undo and clear already use: written by the person
 * asking, never by the account they are working in.
 */
export const listForReport = query({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
  },
  returns: v.array(
    v.object({
      id: v.id('reportPdfAnnotations'),
      page: v.number(),
      points: v.array(point),
      createdAt: v.number(),
      mine: v.boolean(),
      authorColour: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { businessId, reportId }) => {
    const { membership } = await requireVisibleReport(ctx, businessId, reportId)

    // By page, then in the order they were drawn — the index's own order, so
    // a later stroke is painted over an earlier one without sorting here.
    const strokes = await ctx.db
      .query('reportPdfAnnotations')
      .withIndex('by_report_page', (q) => q.eq('reportId', reportId))
      .take(MAX_STROKES_PER_REPORT)

    // One read per person, however many marks they made. The map holds the
    // promise, so two strokes by one author resolved together share it.
    const colours = new Map<Id<'memberships'>, Promise<string | null>>()
    const colourOf = (membershipId: Id<'memberships'>) => {
      let colour = colours.get(membershipId)
      if (!colour) {
        colour = authorColourOf(ctx, businessId, membershipId)
        colours.set(membershipId, colour)
      }
      return colour
    }

    return Promise.all(
      strokes.map(async (stroke) => ({
        id: stroke._id,
        page: stroke.page,
        points: stroke.points,
        createdAt: stroke.createdAt,
        mine: stroke.authorMembershipId === membership._id,
        authorColour: await colourOf(stroke.authorMembershipId),
      })),
    )
  },
})
