/**
 * How a report too big to email is made small enough to send.
 *
 * A report's PDF is its photos: react-pdf copies each JPEG in unchanged, so
 * a 53-photo job came to 33.7 MiB, of which 33.5 MiB was photos (30 Sept
 * 2026). No mail provider carries that — Resend stops at 40 MB after base64,
 * and many mail servers at about 10 MB — so the report failed to send, twice.
 *
 * The answer is a second copy of the same document for the email: same
 * pages, same words, same signatures, with each photo re-encoded smaller.
 * The report in the app, and its own PDF, are never touched. This module is
 * the arithmetic of that, kept pure so every rule is tested without a codec;
 * `convex/emailCopy.ts` does the work.
 */

/**
 * The most an attached PDF may weigh.
 *
 * 6 MiB comes to about 8.6 MB on the wire once base64 and MIME are added,
 * which is under the 10 MB many mail servers still enforce. The old limit,
 * 8 MiB, was already 11.5 MB there.
 */
export const EMAIL_BUDGET_BYTES = 6 * 1024 * 1024

/**
 * Room kept back from the budget beyond what the report's own PDF shows its
 * pages to weigh: a lighter copy draws the same pages, but not byte for byte.
 */
export const FIXED_MARGIN_BYTES = 64 * 1024

/**
 * The share of the photos' budget a tier is chosen to fill. The prediction
 * was within 5% on the 30 Sept photos; the rest is caught by weighing what
 * was actually made, which only costs a second pass when it is wrong. At 90%
 * that report would have gone at 800 px when 1000 px fits with room to spare.
 */
export const TIER_HEADROOM = 0.95

/**
 * When even the floor is predicted this far over, no pass is tried at all:
 * nobody should wait a minute for a copy that cannot be made.
 */
export const FLOOR_REACH = 1.15

/** A size and quality a report's photos are all re-encoded at. */
export type PhotoTier = {
  /** Longest side, in pixels. Nothing is ever enlarged to reach it. */
  edge: number
  /** mozjpeg quality, 0–100. */
  quality: number
}

/**
 * From the lightest touch to the most, and the first that fits is used.
 *
 * Measured on the 30 Sept report's own photos: a portrait photo prints at
 * about 2.3 × 3.0 inches, so the long edge in pixels over 3 is its print
 * resolution. The first tier keeps every pixel (528 dpi) and only encodes
 * them sensibly — the phone had saved them at about quality 94, twice the
 * bytes for nothing a page can show. The floor, 600 px, still prints at
 * about 200 dpi; below that a photo of a subfloor starts to lose the thing
 * it was taken to show, so a report that does not fit there is not sent
 * this way.
 */
export const PHOTO_TIERS: ReadonlyArray<PhotoTier> = [
  { edge: 1600, quality: 85 },
  { edge: 1400, quality: 80 },
  { edge: 1200, quality: 75 },
  { edge: 1000, quality: 75 },
  { edge: 800, quality: 75 },
  { edge: 700, quality: 75 },
  { edge: 600, quality: 72 },
]

/** Where a sample of photos is encoded to predict every tier from. */
export const REFERENCE_TIER: PhotoTier = { edge: 1000, quality: 75 }

/**
 * A re-encode must save at least this much to be used: a photo that would
 * only shrink by a few percent is sent as it was, rather than paying a
 * second generation of JPEG loss for nothing.
 */
export const KEEP_ORIGINAL_RATIO = 0.9

/**
 * How much bigger the same pixels come out at `quality` than at 75.
 *
 * Measured with mozjpeg (4:2:0) on the 30 Sept photos: 70 → 0.875,
 * 80 → 1.19, 85 → 1.43. Between those it is interpolated; outside them it is
 * held at the ends rather than guessed.
 */
export function qualityFactor(quality: number): number {
  const points: ReadonlyArray<readonly [number, number]> = [
    [70, 0.875],
    [75, 1],
    [80, 1.19],
    [85, 1.43],
  ]
  const first = points[0]
  const last = points[points.length - 1]
  if (quality <= first[0]) return first[1]
  if (quality >= last[0]) return last[1]
  for (let i = 1; i < points.length; i++) {
    const [q1, f1] = points[i]
    const [q0, f0] = points[i - 1]
    if (quality <= q1) return f0 + ((quality - q0) / (q1 - q0)) * (f1 - f0)
  }
  return last[1]
}

/**
 * The size to encode at: the same shape, no larger than `edge` on its long
 * side, and never enlarged. The same rule `src/lib/images/prepareUpload.ts`
 * applies on the phone.
 */
export function fitWithin(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= edge || longest === 0) return { width, height }
  const scale = edge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** One photo, as far as choosing a tier needs to know it. */
export type PhotoMeasure = {
  originalBytes: number
  /** Decoded size; for a photo that could not be decoded, it is kept as is. */
  width: number
  height: number
  /** Its bytes at `REFERENCE_TIER`, when it was in the sample. */
  referenceBytes?: number
  /** Could not be decoded: it goes as it came, whatever the tier. */
  keep?: boolean
}

/**
 * What one photo is expected to weigh at `tier`.
 *
 * At a fixed quality a JPEG's size follows its pixel count — within 5% from
 * 800 to 1600 px on the 30 Sept photos — so one encode at the reference size
 * predicts every other. A photo expected to shrink by less than
 * `KEEP_ORIGINAL_RATIO` is expected to go as it came.
 */
export function predictPhotoBytes(
  photo: PhotoMeasure & { referenceBytes: number },
  tier: PhotoTier,
): number {
  if (photo.keep) return photo.originalBytes
  const reference = fitWithin(photo.width, photo.height, REFERENCE_TIER.edge)
  const target = fitWithin(photo.width, photo.height, tier.edge)
  const pixels =
    (target.width * target.height) / (reference.width * reference.height)
  const predicted =
    photo.referenceBytes *
    pixels *
    (qualityFactor(tier.quality) / qualityFactor(REFERENCE_TIER.quality))
  return predicted >= photo.originalBytes * KEEP_ORIGINAL_RATIO
    ? photo.originalBytes
    : predicted
}

/**
 * Which photos to encode as the sample: up to `size` of them, spread evenly
 * through the set by size and always including the largest, which is the one
 * a prediction most needs to be right about.
 */
export function pickSample(
  photos: ReadonlyArray<Pick<PhotoMeasure, 'originalBytes'>>,
  size = 8,
): Array<number> {
  const bySize = photos
    .map((photo, index) => ({ index, bytes: photo.originalBytes }))
    .sort((a, b) => a.bytes - b.bytes)
  if (bySize.length <= size) return bySize.map((photo) => photo.index)
  const picked = new Set<number>()
  for (let i = 0; i < size; i++) {
    const rank = Math.round((i * (bySize.length - 1)) / (size - 1))
    picked.add(bySize[rank].index)
  }
  return [...picked]
}

/**
 * The first tier every photo is predicted to fit in, with `TIER_HEADROOM`
 * kept back for a prediction that is low; or null when even the floor is
 * plainly out of reach, so no one waits for a pass that cannot succeed.
 *
 * A photo outside the sample is predicted from the sample's own ratio of
 * reference bytes to original bytes, which carries how compressible this
 * job's photos are — a dark, noisy subfloor shrinks far less than a wall.
 */
export function chooseTier(
  photos: ReadonlyArray<PhotoMeasure>,
  budget: number,
): number | null {
  const sampled = photos.filter(
    (photo): photo is PhotoMeasure & { referenceBytes: number } =>
      photo.referenceBytes !== undefined && !photo.keep,
  )
  const sampledOriginal = sampled.reduce((sum, p) => sum + p.originalBytes, 0)
  const ratio =
    sampledOriginal > 0
      ? sampled.reduce((sum, p) => sum + p.referenceBytes, 0) / sampledOriginal
      : 1
  const measured = photos.map((photo) => ({
    ...photo,
    referenceBytes: photo.referenceBytes ?? photo.originalBytes * ratio,
  }))
  const total = (tier: PhotoTier) =>
    measured.reduce((sum, photo) => sum + predictPhotoBytes(photo, tier), 0)

  for (let index = 0; index < PHOTO_TIERS.length; index++) {
    if (total(PHOTO_TIERS[index]) <= budget * TIER_HEADROOM) return index
  }
  const floor = PHOTO_TIERS.length - 1
  return total(PHOTO_TIERS[floor]) <= budget * FLOOR_REACH ? floor : null
}

/**
 * The marker pdfkit writes once in the dictionary of every image it embeds —
 * a photo, a signature, a logo, a transparency mask.
 */
const IMAGE_MARKER = new TextEncoder().encode('/Subtype /Image')

/**
 * Counts image markers in a PDF read in pieces, so a 35 MB file is never
 * held whole just to be counted. `carry` is the tail of the previous piece,
 * which a marker split across two pieces starts in.
 */
export function countImageMarkers(
  chunk: Uint8Array,
  carry: Uint8Array = new Uint8Array(0),
): { count: number; carry: Uint8Array } {
  const bytes = new Uint8Array(carry.length + chunk.length)
  bytes.set(carry, 0)
  bytes.set(chunk, carry.length)
  let count = 0
  const last = bytes.length - IMAGE_MARKER.length
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < IMAGE_MARKER.length; j++) {
      if (bytes[i + j] !== IMAGE_MARKER[j]) continue outer
    }
    count++
    i += IMAGE_MARKER.length - 1
  }
  // A marker that ends in the next piece begins in these last bytes.
  const keep = Math.min(bytes.length, IMAGE_MARKER.length - 1)
  return { count, carry: bytes.slice(bytes.length - keep) }
}

/**
 * How many images the lighter copy must hold, given how many the report's
 * own PDF does.
 *
 * react-pdf embeds an image once per distinct source: the report's own PDF
 * fetched each photo by its storage URL, and the copy is handed each photo's
 * bytes directly. Two photo rows that were two uploads of the same picture
 * are two images in the original and, when their bytes come out identical,
 * one in the copy. Anything else missing means react-pdf dropped a picture it
 * could not read — which it does without a word — and a copy that lost a
 * photo, a signature or the logo is not sent.
 */
export function expectedCopyImages(
  originalImages: number,
  sources: ReadonlyArray<{ url: string; contentKey: string }>,
): number {
  const urls = new Set(sources.map((source) => source.url)).size
  const contents = new Set(sources.map((source) => source.contentKey)).size
  return originalImages - (urls - contents)
}
