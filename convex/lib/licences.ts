/**
 * Licence documents (Phase 8.1): what a technician's uploaded licence may be,
 * in one place both ends can read.
 *
 * Pure and import-free on purpose, like `lib/products.ts`, whose rules these
 * follow: the Profile page imports this directly so it can turn away a HEIC,
 * a Word file or a 40 MB scan before anything is uploaded, by exactly the
 * rule `convex/licences.ts` will enforce when the upload is claimed.
 *
 * Every check returns a value rather than throwing. The server turns a refusal
 * into a `ConvexError`; the page turns it into a line under the button.
 */

/** A licence card photographed, or the regulator's PDF certificate. */
export type LicenceKind = 'pdf' | 'image'

/** The refusals a licence file can earn, as `ConvexError` data. */
export type LicenceRefusal = 'WRONG_FILE_TYPE' | 'FILE_TOO_LARGE'

/** What the claim keeps: the kind the viewer opens it with, and the type. */
export type LicenceType = {
  kind: LicenceKind
  contentType: 'application/pdf' | 'image/png' | 'image/jpeg'
}

/**
 * The same ceilings Products uses for the same two kinds of file: a scanned
 * certificate with photographs in it runs to a few MB, and a phone photo of a
 * card at full resolution is well under ten.
 */
export const MAX_LICENCE_PDF_BYTES = 20 * 1024 * 1024
export const MAX_LICENCE_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * What the file picker offers. Types and extensions both: some Android pickers
 * filter on one and some on the other.
 *
 * Naming `image/jpeg` rather than `image/*` is what makes an iPhone convert a
 * HEIC photo to JPEG as it hands it over — the camera's own format is not one
 * every browser the owner might view it on can draw. Keep it that way.
 */
export const LICENCE_ACCEPT =
  'application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg'

/** A licence's file name, as kept. Includes the extension. */
export const MAX_LICENCE_FILE_NAME_LENGTH = 200

const BY_MEDIA_TYPE: Record<string, LicenceType> = {
  'application/pdf': { kind: 'pdf', contentType: 'application/pdf' },
  'image/png': { kind: 'image', contentType: 'image/png' },
  'image/jpeg': { kind: 'image', contentType: 'image/jpeg' },
  // Not a registered type, but what some older Android pickers still say.
  'image/jpg': { kind: 'image', contentType: 'image/jpeg' },
}

const BY_EXTENSION: Record<string, LicenceType> = {
  pdf: BY_MEDIA_TYPE['application/pdf'],
  png: BY_MEDIA_TYPE['image/png'],
  jpg: BY_MEDIA_TYPE['image/jpeg'],
  jpeg: BY_MEDIA_TYPE['image/jpeg'],
}

/** The extension a kept file name ends in, for each stored type. */
const EXTENSION_OF: Record<LicenceType['contentType'], string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
}

/**
 * A content type's bare media type: lower-cased, parameters dropped. Undefined
 * when there is none, which is how an upload with no `Content-Type` is stored.
 */
function mediaTypeOf(contentType: string | undefined): string | undefined {
  const bare = contentType?.split(';')[0].trim().toLowerCase()
  return bare === '' ? undefined : bare
}

function extensionOf(fileName: string): string | undefined {
  const match = /\.([a-z0-9]+)\s*$/i.exec(fileName)
  return match?.[1].toLowerCase()
}

/**
 * What a file is as a licence — PDF, PNG or JPEG — or null for anything else.
 *
 * The stored type decides whenever there is one. The file's name is looked at
 * only when there is no type at all: an upload made without a `Content-Type`
 * is stored without one, and refusing those would refuse a real PDF from a
 * browser that did not know what it was. A type that is present and wrong
 * (`application/octet-stream`, `image/heic`, `image/svg+xml`) is never
 * overruled by a name that says otherwise — the name is the easier of the two
 * to get wrong, or to fake.
 *
 * SVG in particular stays out: it is a document that can carry script, and a
 * licence is opened full screen by the owner as well as its holder.
 */
export function licenceTypeOf(
  contentType: string | undefined,
  fileName: string,
): LicenceType | null {
  const media = mediaTypeOf(contentType)
  if (media !== undefined) return BY_MEDIA_TYPE[media] ?? null
  const extension = extensionOf(fileName)
  return extension === undefined ? null : (BY_EXTENSION[extension] ?? null)
}

/**
 * Whether a stored file may be a licence: its type, or the refusal. The type
 * first — a 30 MB video is refused for being a video, not for its size.
 */
export function checkLicenceFile(
  file: { contentType?: string; size: number },
  fileName: string,
): { ok: true; type: LicenceType } | { ok: false; refusal: LicenceRefusal } {
  const type = licenceTypeOf(file.contentType, fileName)
  if (type === null) return { ok: false, refusal: 'WRONG_FILE_TYPE' }
  const limit =
    type.kind === 'pdf' ? MAX_LICENCE_PDF_BYTES : MAX_LICENCE_IMAGE_BYTES
  if (file.size > limit) return { ok: false, refusal: 'FILE_TOO_LARGE' }
  return { ok: true, type }
}

/**
 * The characters that have no business in a file name — control characters,
 * line and paragraph separators, bidi controls. `lib/products.ts` has the
 * reasoning (an RLO makes "licence‹RLO›fdp.exe" read as "licenceexe.pdf").
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu
const PATH_SEPARATORS = /[/\\]+/g

/**
 * The name a licence is shown and shared under: the name it had on the phone,
 * tidied, ending in the extension of what it actually is ("IMG_0412.JPG" is
 * kept as "IMG_0412.jpg"; a PDF someone named "licence" becomes
 * "licence.pdf"). "Licence" when nothing usable is left.
 */
export function cleanLicenceFileName(input: string, type: LicenceType): string {
  const extension = EXTENSION_OF[type.contentType]
  const cleaned = input
    .replace(CONTROL_CHARACTERS, '')
    .replace(PATH_SEPARATORS, '-')
    .trim()
  // Whatever extension it had goes; the right one is put back below.
  const stem = cleaned.replace(/\.(pdf|png|jpe?g)$/i, '').trim()
  const kept = cutAt(stem, MAX_LICENCE_FILE_NAME_LENGTH - extension.length)
    .trim()
    .replace(/\.+$/, '')
  if (kept.replace(/\./g, '').trim() === '') return `Licence${extension}`
  return `${kept}${extension}`
}

/** The first `length` UTF-16 units of `text`, without half a surrogate pair. */
function cutAt(text: string, length: number): string {
  if (text.length <= length) return text
  const cut = text.slice(0, length)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}
