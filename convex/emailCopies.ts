import { v } from 'convex/values'
import { internalMutation, internalQuery } from './_generated/server'
import { RENDER_VERSION } from './reports'
import { EMAIL_BUDGET_BYTES } from './lib/emailFit'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'

/**
 * The record side of a big report's lighter email copy: which one exists
 * for which original, and writing a new one down. The copy is made in the
 * Node runtime (convex/emailCopy.ts); a database is only reachable from here.
 */

/** A copy, as the sender needs it. */
export type EmailCopyRow = {
  pdfId: Id<'reportPdfs'>
  storageId: Id<'_storage'>
  bytes: number
  photoEdge: number | null
}

function asCopy(row: Doc<'reportPdfs'>): EmailCopyRow {
  return {
    pdfId: row._id,
    storageId: row.storageId,
    bytes: row.bytes,
    photoEdge: row.photoEdge ?? null,
  }
}

/**
 * How many of a report's files are looked through, newest first. A report
 * has one per render and a copy per render too big to email — a handful —
 * so this is a guard, not a limit anyone will meet.
 */
const PDF_ROWS = 200

/** A report's files, newest first. */
function pdfRowsOf(ctx: QueryCtx, reportId: Id<'reports'>) {
  return ctx.db
    .query('reportPdfs')
    .withIndex('by_report', (q) => q.eq('reportId', reportId))
    .order('desc')
    .take(PDF_ROWS)
}

/**
 * The copy of this original that can still go. One made before the budget
 * was lowered, and now over it, is passed over rather than attached and
 * refused on every send forever; a new one is made beside it, and it stays,
 * as every file someone may have been sent does.
 */
async function copyOf(
  ctx: QueryCtx,
  reportId: Id<'reports'>,
  sourceStorageId: Id<'_storage'>,
): Promise<Doc<'reportPdfs'> | null> {
  return (
    (await pdfRowsOf(ctx, reportId)).find(
      (row) =>
        row.variant === 'email' &&
        row.sourceStorageId === sourceStorageId &&
        row.bytes <= EMAIL_BUDGET_BYTES,
    ) ?? null
  )
}

/** How big a stored file is, without downloading it. */
export const fileSize = internalQuery({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }): Promise<number | null> => {
    const file = await ctx.db.system.get('_storage', storageId)
    return file?.size ?? null
  },
})

/**
 * The report's own `reportPdfs` row for a file, so a delivery can record
 * exactly which file it attached. Null for a file drawn before the rows
 * existed.
 */
export const rowFor = internalQuery({
  args: { reportId: v.id('reports'), storageId: v.id('_storage') },
  handler: async (
    ctx,
    { reportId, storageId },
  ): Promise<Id<'reportPdfs'> | null> => {
    return (
      (await pdfRowsOf(ctx, reportId)).find(
        (row) => row.storageId === storageId && row.variant === undefined,
      )?._id ?? null
    )
  },
})

/** The lighter copy already made of this original, if there is one. */
export const forSource = internalQuery({
  args: {
    reportId: v.id('reports'),
    sourceStorageId: v.id('_storage'),
  },
  handler: async (
    ctx,
    { reportId, sourceStorageId },
  ): Promise<EmailCopyRow | null> => {
    const row = await copyOf(ctx, reportId, sourceStorageId)
    return row ? asCopy(row) : null
  },
})

/**
 * Writes down a copy just made, and answers with the one to use.
 *
 * Two sends can make a copy of the same report at once — a technician
 * tapping Send while the lock's own copy is still being made. Whichever is
 * written first is the copy; the other's file was stored a moment ago by the
 * action that made it and has been handed to nobody, so it is deleted rather
 * than left in storage with nothing pointing at it.
 *
 * It stamps the painter version itself rather than trusting the caller: the
 * copy is drawn by the same painter as the file it copies.
 */
export const record = internalMutation({
  args: {
    reportId: v.id('reports'),
    sourceStorageId: v.id('_storage'),
    storageId: v.id('_storage'),
    bytes: v.number(),
    photoEdge: v.number(),
  },
  handler: async (
    ctx,
    { reportId, sourceStorageId, storageId, bytes, photoEdge },
  ): Promise<EmailCopyRow | null> => {
    const report = await ctx.db.get(reportId)
    if (!report) {
      // Gone while the copy was made (purged, or its demo removed): the file
      // was made for this report alone.
      await ctx.storage.delete(storageId)
      return null
    }

    const existing = await copyOf(ctx, reportId, sourceStorageId)
    if (existing) {
      await ctx.storage.delete(storageId)
      return asCopy(existing)
    }

    const pdfId = await ctx.db.insert('reportPdfs', {
      businessId: report.businessId,
      reportId,
      storageId,
      rendererVersion: RENDER_VERSION,
      templateVersion: report.templateVersion,
      version: report.version ?? 1,
      bytes,
      createdAt: Date.now(),
      variant: 'email',
      sourceStorageId,
      photoEdge,
    })
    return { pdfId, storageId, bytes, photoEdge }
  },
})
