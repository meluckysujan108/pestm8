import { ConvexError } from 'convex/values'
import { heldAnywhere } from './fileClaims'
import { checkLicenceFile, cleanLicenceFileName } from './licences'
import { CLAIM_WINDOW_MS } from './products'
import type { LicenceKind } from './licences'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * What a claimed licence file is, as it is kept: the kind the viewer opens it
 * with, the type and size from storage, and the tidied name.
 */
export type ClaimedLicenceFile = {
  kind: LicenceKind
  contentType: string
  fileName: string
  size: number
}

/**
 * Takes an upload for a licence, or refuses it — the rule for every file in
 * someone's licence wallet (`memberLicences.addFile`), kept apart from the
 * mutation so it reads as one rule. `products.claimFile`'s rule:
 *
 *  - It must exist and have been uploaded within `CLAIM_WINDOW_MS`: storage
 *    ids are not secrets, so only a fresh upload can be the one this person
 *    just made (FILE_NOT_FOUND otherwise, whichever it was).
 *  - Nothing that can be asked may already hold it — a product, a report
 *    photo, a note's picture, or any licence file, this person's included
 *    (ALREADY_ATTACHED; `heldAnywhere`).
 *  - It must be a PDF, PNG or JPEG within its size (`checkLicenceFile`:
 *    WRONG_FILE_TYPE, FILE_TOO_LARGE) — the checks the page makes before it
 *    uploads, so this only ever refuses a client that skipped them.
 *
 * The type and size kept are storage's, not the client's. `fileName` is the
 * name it had on the phone — tidied, never refused — and is also what decides
 * the type when storage recorded none (`licenceTypeOf`).
 *
 * A caller that allows a retry (the same upload sent again after a dropped
 * reply) must recognise it BEFORE calling this: the second time, the file is
 * held — by the caller's own first write — and this refuses it.
 */
export async function claimLicenceFile(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  fileName: string,
): Promise<ClaimedLicenceFile> {
  const stored = await ctx.db.system.get('_storage', storageId)
  if (!stored || Date.now() - stored._creationTime > CLAIM_WINDOW_MS) {
    throw new ConvexError('FILE_NOT_FOUND')
  }
  if (await heldAnywhere(ctx, storageId)) {
    throw new ConvexError('ALREADY_ATTACHED')
  }
  const checked = checkLicenceFile(stored, fileName)
  if (!checked.ok) throw new ConvexError(checked.refusal)
  return {
    kind: checked.type.kind,
    contentType: checked.type.contentType,
    fileName: cleanLicenceFileName(fileName, checked.type),
    size: stored.size,
  }
}
