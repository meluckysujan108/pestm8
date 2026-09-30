/**
 * One path from "a technician picked an image" to "bytes worth uploading".
 *
 * Four screens had their own copy of this — the logo, job photos, report
 * galleries and report slots — agreeing on nothing but the library call, with
 * three different size budgets between them and no two failure paths alike.
 * Worse, none of them recorded what the image actually was: no dimensions, so
 * a report's photos could only ever be printed into fixed boxes and
 * centre-cropped, which on evidence can remove the very thing the photo was
 * taken to show.
 *
 * What this does that the old path did not:
 *
 * - Bakes in EXIF rotation. `createImageBitmap(file, { imageOrientation:
 *   'from-image' })` applies the orientation flag and drops it, so a photo
 *   taken sideways on a phone is upright everywhere afterwards — on screen, in
 *   the PDF, and in anything that reads the bytes without consulting EXIF.
 * - Reports the dimensions it produced, so a document can lay a photo out at
 *   its own aspect instead of guessing.
 * - Strips the rest of the metadata by re-encoding, which quietly removes the
 *   GPS tag a phone camera writes into every shot. A client's report should
 *   not carry the technician's coordinates as a hidden payload.
 *
 * - Saves no heavier than libjpeg's 85 on any phone, found per device by
 *   `jpegQuality.ts`. Until 30 Sept 2026 the canvas was simply told 0.82,
 *   which an iPhone's encoder turns into about 94 — twice the bytes, and a
 *   53-photo report that was too big to email. Where 0.82 already meant 82
 *   (Chrome, Android), it still does.
 *
 * Not for a logo. Everything here comes out a JPEG, which has no
 * transparency — a see-through logo came out a black box until Sept 2026.
 * A logo goes through `prepareLogo.ts`.
 */

import { uploadCanvasQuality } from './jpegQuality'

export type PreparedImage = {
  blob: Blob
  /** Pixel dimensions of the encoded image, after any downscale. */
  width: number
  height: number
  bytes: number
  /** True when the original was used as-is: nothing here could decode it. */
  passthrough: boolean
}

export type PrepareOptions = {
  /** Longest edge to keep. Anything larger is scaled down to it. */
  maxEdge?: number
  /**
   * The canvas's JPEG setting, 0–1. Left out, it is whatever makes this
   * device save at libjpeg's 85, or 0.82 where that is lighter
   * (`jpegQuality.ts`): about where these photos stop getting visibly
   * better, on paper and on a phone screen.
   */
  quality?: number
}

/**
 * 1600px on the long edge.
 *
 * A4 at 300dpi is about 2480px wide, but a report photo is printed at most
 * half a page and usually a third — a portrait photo prints about 3 inches
 * tall, so 1600px is over 500dpi, already more than the page can show. The
 * pixels are kept for zooming in on the phone; the quality setting is what
 * keeps them light (a typical photo from the 30 Sept report: 280 KB at 85,
 * against 617 KB at an iPhone's old 94), which matters on a phone tethered
 * to a van.
 */
const DEFAULT_MAX_EDGE = 1600

/**
 * The size to encode at: the same shape, no larger than `maxEdge` on its long
 * side, and never scaled UP — enlarging a small photo adds bytes and no detail.
 */
export function targetSize(
  width: number,
  height: number,
  maxEdge: number = DEFAULT_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) return { width, height }
  const scale = maxEdge / longest
  // At least 1px in each direction: a 4000x3 panorama must not round to zero.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export async function prepareUpload(
  file: File | Blob,
  options: PrepareOptions = {},
): Promise<PreparedImage> {
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE
  // Asked before the `try`, and it never rejects: a failure in there uploads
  // the original as it came, location tag and all, so working out a setting
  // must never be what sends a photo down that path.
  const quality = options.quality ?? (await uploadCanvasQuality())

  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    })
    const size = targetSize(bitmap.width, bitmap.height, maxEdge)

    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, size.width, size.height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    )
    if (!blob) throw new Error('could not encode the image')

    return {
      blob,
      width: size.width,
      height: size.height,
      bytes: blob.size,
      passthrough: false,
    }
  } catch {
    // An image this browser cannot decode — an unusual HEIC, a corrupt file —
    // is uploaded as it came. A photo that cannot be shrunk is still evidence,
    // and refusing it would lose the only record of what was there.
    return {
      blob: file,
      width: 0,
      height: 0,
      bytes: file.size,
      passthrough: true,
    }
  }
}
