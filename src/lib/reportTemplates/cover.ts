import { fieldsOf } from './index'
import type { ReportTemplate } from './types'

/**
 * Which photos belong to a `cover` field — the document's front page — and
 * which are ordinary evidence.
 *
 * Resolved by field KIND, deliberately not by the per-row `isCover` flag. That
 * flag is only ever written by `setGalleryCover`, which is only reachable
 * through a star button the gallery control hides whenever a field holds one
 * photo — so the service report's declared front-page photo has never once
 * been able to become a cover. Keying on the kind means the template's own
 * declaration is the claim, needs no backfill, and is unaffected by the rows
 * already stored with `isCover: false`.
 */
export function coverFieldKeys(template: ReportTemplate): Set<string> {
  return new Set(
    fieldsOf(template)
      .filter((field) => field.kind === 'cover')
      .map((field) => field.key),
  )
}

type PhotoLike = { fieldKey: string; order: number; url?: string | null }

/**
 * The one photo that opens the document. First by the technician's own
 * ordering, so reordering the tiles changes the cover with no second control
 * to find.
 */
export function coverPhotoOf<T extends PhotoLike>(
  template: ReportTemplate,
  photos: Array<T>,
  /** The photo fields currently printing (`printedGalleryKeys`); a conditional cover that is hidden has no page. */
  printable?: Set<string>,
): T | undefined {
  const keys = coverFieldKeys(template)
  if (keys.size === 0) return undefined
  return photos
    .filter(
      (photo) =>
        keys.has(photo.fieldKey) &&
        photo.url &&
        (!printable || printable.has(photo.fieldKey)),
    )
    .sort((a, b) => a.order - b.order)[0]
}
