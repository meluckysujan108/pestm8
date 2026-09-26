import type { Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

type Ctx = QueryCtx | MutationCtx

/**
 * Whether a stored file is somebody's licence: the Phase 8.1 document on a
 * membership (`licenceFile`), or a file in someone's licence wallet
 * (`memberLicenceFiles`, `memberLicences.ts`).
 *
 * Asked by every feature that claims an upload by its id — a product's photo
 * or PDF, a note's picture — so a file that is someone's licence can never
 * also be something the whole business reads. And asked before the paths that
 * delete files (a note's purge, a demo's removal), which must never reach a
 * licence.
 *
 * Both places, for as long as both exist: `migrations/licenceWalletV1` copied
 * each membership's document into the wallet under the same storage id and
 * left the original pointer, which `migrations/licenceFileContractV1` clears
 * before the field is dropped. Until then a file either one holds is a
 * licence — a document nobody copied included.
 */
export async function heldAsLicence(
  ctx: Ctx,
  storageId: Id<'_storage'>,
): Promise<boolean> {
  const [onMembership, inWallet] = await Promise.all([
    ctx.db
      .query('memberships')
      .withIndex('by_licenceFile_storageId', (q) =>
        q.eq('licenceFile.storageId', storageId),
      )
      .first(),
    ctx.db
      .query('memberLicenceFiles')
      .withIndex('by_storage', (q) => q.eq('storageId', storageId))
      .first(),
  ])
  return onMembership !== null || inWallet !== null
}

/**
 * Whether any row that can be asked already holds this file: a product (photo
 * or PDF), a report's gallery photo, a note's picture, or someone's licence —
 * either kind (`heldAsLicence`).
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
