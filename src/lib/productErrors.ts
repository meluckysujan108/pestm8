import { ConvexError } from 'convex/values'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PDF_BYTES,
  MAX_PHOTO_BYTES,
  MAX_PRODUCTS,
} from '../../convex/lib/products'
import { FileTransferError } from './pdfFiles'
import type { FileRefusal } from '../../convex/lib/products'

/**
 * What went wrong with a product, in the words a technician reads.
 *
 * `convex/products.ts` refuses with a bare code (`ConvexError('PRODUCT_EXISTS')`),
 * which is right for a server and useless on a phone: the page turns each one
 * into a sentence that says what happened and what to do about it. Kept in
 * one place, and pure, so every code the server can send is known to have
 * words and a test can say so.
 *
 * The limits are read from `convex/lib/products`, the same constants the
 * server enforces, so the sentence cannot quote a number the rule no longer
 * uses.
 */

/** What was being done when it failed: it decides the fallback sentence. */
export type ProductAction = 'save' | 'delete' | 'replace'

/** Megabytes as the limits were written — `20 * 1024 * 1024` is "20 MB". */
const mb = (bytes: number) => Math.round(bytes / (1024 * 1024))

export const PDF_LIMIT_MB = mb(MAX_PDF_BYTES)
export const PHOTO_LIMIT_MB = mb(MAX_PHOTO_BYTES)

/**
 * Said in terms of what happened to them: a Save made while switched into
 * someone's account after that switch lapsed (`requireWriteActor` fails
 * closed) wrote nothing, and the app has put them back in their own account.
 * The same account of it the switch banner gives.
 */
export const SWITCH_ENDED =
  'That session ended, so you are back in your own account. Nothing was changed — try again.'

const WORDS: Record<string, string> = {
  INVALID_PRODUCT: `Give the product a name of up to ${MAX_NAME_LENGTH} characters, and keep the description under ${MAX_DESCRIPTION_LENGTH.toLocaleString('en-AU')}.`,
  INVALID_URL:
    'That website address does not look right. It should be a web page, like brand.com.au/product.',
  PRODUCT_EXISTS: "There's already a product with that name.",
  TOO_MANY_PRODUCTS: `The list is full: a business can keep ${MAX_PRODUCTS} products. Delete one nobody uses any more, then try again.`,
  FILE_NOT_FOUND: 'That upload took too long — pick the file again.',
  ALREADY_ATTACHED:
    'That file is already on another product — pick the file again.',
  FILE_TOO_LARGE: `That file is too big. A PDF can be up to ${PDF_LIMIT_MB} MB and a photo up to ${PHOTO_LIMIT_MB} MB.`,
  WRONG_FILE_TYPE:
    'That file is the wrong kind: the document has to be a PDF, and the photo a picture.',
  NOT_FOUND: 'This product has been deleted.',
  NO_ACCESS:
    'Only the person who added this product, or the owner, can change it.',
}

const FALLBACK: Record<ProductAction, string> = {
  save: 'Could not save this product. Check your signal and try again.',
  delete: 'Could not delete this product. Check your signal and try again.',
  replace: 'Could not replace the PDF. Check your signal and try again.',
}

/** The code a Convex refusal carries, or null for anything else. */
export function productErrorCode(error: unknown): string | null {
  if (error instanceof ConvexError && typeof error.data === 'string') {
    return error.data
  }
  return null
}

/** Whether a Save should forget the uploads it made: the server will not
 * take them again, so the next Save must send the files afresh. */
export function uploadsSpent(error: unknown): boolean {
  const code = productErrorCode(error)
  return code === 'FILE_NOT_FOUND' || code === 'ALREADY_ATTACHED'
}

export function productErrorMessage(
  error: unknown,
  action: ProductAction = 'save',
): string {
  const code = productErrorCode(error)
  if (code !== null) {
    if (code.startsWith('SWITCH_')) return SWITCH_ENDED
    if (code === 'NOT_FOUND' && action === 'delete') {
      return 'This product was already deleted.'
    }
    // A Save has already sent the file again once by itself (`saveProduct`),
    // and still has it in the draft: another tap sends it afresh, where
    // picking it again would only find the same file.
    if (code === 'FILE_NOT_FOUND' && action === 'save') {
      return 'The upload took too long to reach the server. Tap Save to send it again.'
    }
    if (code in WORDS) return WORDS[code]
  }
  // An upload that did not get through already says why, in these words.
  if (error instanceof FileTransferError) return error.message
  return FALLBACK[action]
}

/** Why a picked file was turned away before anything was uploaded. */
export type PickRefusal = FileRefusal | 'NOT_A_PDF'

export function pickRefusalMessage(
  slot: 'pdf' | 'photo',
  refusal: PickRefusal,
): string {
  if (slot === 'pdf') {
    return refusal === 'FILE_TOO_LARGE'
      ? `That PDF is over ${PDF_LIMIT_MB} MB, the most a product can hold. A smaller copy — the label or the safety data sheet on its own — will fit.`
      : "That file isn't a PDF. Pick the product's label or safety data sheet as a PDF."
  }
  return refusal === 'FILE_TOO_LARGE'
    ? `That photo is over ${PHOTO_LIMIT_MB} MB. Take a new one, or pick a smaller copy.`
    : "That file isn't a photo. Pick a picture of the product."
}
