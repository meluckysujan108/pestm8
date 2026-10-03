import { mediaTypeOf } from './products'
import type { FileFacts } from './products'

/**
 * The files a drawn signature is kept as, and when it was signed.
 *
 * A signature is two files: the image every document prints, and the strokes
 * it was drawn from — where the pen went and when — kept beside it as
 * evidence of how it was made. The image can be redrawn from the strokes at
 * any size; the strokes cannot be got back from the image. Their timing is
 * close to biometric data, so nothing that reads a report is ever handed
 * either file's id (`withoutImages` in reports.ts): the image is shown from a
 * signed URL, and the strokes are not shown at all.
 */

/** A drawn signature's image: a PNG cut to its ink, at most 2,000 pixels
 * across (`exportPlan`), dark ink on a transparent ground — tens of
 * kilobytes, so this only ever refuses something that is not one. */
export const MAX_SIGNATURE_IMAGE_BYTES = 2 * 1024 * 1024

/** The strokes as JSON: a long signature is a few thousand points. */
export const MAX_SIGNATURE_STROKES_BYTES = 512 * 1024

/**
 * How far ahead of the server a phone's clock may run before what it says
 * about when a signature was drawn stops being believed.
 */
export const DRAWN_AT_SKEW_MS = 2 * 60 * 1000

/**
 * Whether an upload may be a signature's image or its strokes: null if so,
 * or the refusal. The type may be absent — an upload sent without a
 * `Content-Type` is stored without one, as `checkPhotoFile` allows — but one
 * that is present must be what the pad makes.
 */
export function signatureFileRefusal(
  file: FileFacts,
  as: 'image' | 'strokes',
): 'WRONG_FILE_TYPE' | 'FILE_TOO_LARGE' | null {
  const type = mediaTypeOf(file.contentType)
  const expected = as === 'image' ? 'image/png' : 'application/json'
  if (type !== undefined && type !== expected) return 'WRONG_FILE_TYPE'
  const max =
    as === 'image' ? MAX_SIGNATURE_IMAGE_BYTES : MAX_SIGNATURE_STROKES_BYTES
  if (file.size > max) return 'FILE_TOO_LARGE'
  return null
}

/**
 * When a signature was signed, given when the phone says it was drawn.
 *
 * A signature drawn with no signal is kept on the phone until there is one
 * (`src/lib/signature/kept.ts`), and arrives later: stamped with the moment it
 * arrived, it would claim the client signed at 4 pm for a visit at 10 am. So
 * the phone's time is taken — and the arrival kept beside it as
 * `receivedAt` — but only where it could be true: not before the report
 * existed, and not ahead of the server by more than a phone's clock drifts
 * (`DRAWN_AT_SKEW_MS`). Anything else is the server's own time, as every
 * signature was before.
 */
export function signedAtOf(
  drawnAt: number | undefined,
  { now, notBefore }: { now: number; notBefore: number },
): { signedAt: number; receivedAt?: number } {
  if (
    drawnAt === undefined ||
    !Number.isFinite(drawnAt) ||
    drawnAt < notBefore ||
    drawnAt > now + DRAWN_AT_SKEW_MS
  ) {
    return { signedAt: now }
  }
  const signedAt = Math.min(drawnAt, now)
  return signedAt < now ? { signedAt, receivedAt: now } : { signedAt }
}
