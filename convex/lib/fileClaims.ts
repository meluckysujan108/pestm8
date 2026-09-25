import type { Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

type Ctx = QueryCtx | MutationCtx

/**
 * Whether a stored file is somebody's licence document (Phase 8.1).
 *
 * Asked by every feature that claims an upload by its id — a product's photo
 * or PDF, a note's picture — so a file that is someone's licence can never
 * also be something the whole business reads. And asked before the one path
 * that deletes a note's files, which must never reach a licence.
 */
export async function heldAsLicence(
  ctx: Ctx,
  storageId: Id<'_storage'>,
): Promise<boolean> {
  const holder = await ctx.db
    .query('memberships')
    .withIndex('by_licenceFile_storageId', (q) =>
      q.eq('licenceFile.storageId', storageId),
    )
    .first()
  return holder !== null
}

/**
 * Whether any row that can be asked already holds this file: a product (photo
 * or PDF), a report's gallery photo, a note's picture, or someone's licence.
 *
 * These are the tables with an index on the storage id — the same set
 * `demo/cleanup.ts` asks before it deletes anything. A report's rendered PDF,
 * its preview, a signature and a job photo cannot be asked this way; the
 * claim window (`CLAIM_WINDOW_MS`) is what keeps those out, since each is
 * either made by the server or claimed by its own feature the moment it is
 * uploaded.
 */
export async function heldAnywhere(
  ctx: Ctx,
  storageId: Id<'_storage'>,
): Promise<boolean> {
  const [asProductPdf, asProductPhoto, asReportPhoto, asNoteImage] =
    await Promise.all([
      ctx.db
        .query('products')
        .withIndex('by_pdfStorageId', (q) => q.eq('pdfStorageId', storageId))
        .first(),
      ctx.db
        .query('products')
        .withIndex('by_photoStorageId', (q) =>
          q.eq('photoStorageId', storageId),
        )
        .first(),
      ctx.db
        .query('reportPhotos')
        .withIndex('by_storage', (q) => q.eq('storageId', storageId))
        .first(),
      ctx.db
        .query('noteAttachments')
        .withIndex('by_storage', (q) => q.eq('storageId', storageId))
        .first(),
    ])
  if (asProductPdf || asProductPhoto || asReportPhoto || asNoteImage) {
    return true
  }
  return heldAsLicence(ctx, storageId)
}
