/**
 * Products (Phase 7.1): the rules for what a product may hold, in one place
 * both ends can read.
 *
 * Pure and import-free on purpose. The Products page imports this directly —
 * the way `AbnInput` imports `lib/abn` — so the form can refuse a name that is
 * too long, tidy a pasted link, or turn away a 30 MB scan before anything is
 * uploaded, by exactly the rule `convex/products.ts` will enforce on Save.
 * Nothing here may reach for the database, the auth component or anything
 * else a browser bundle cannot load.
 *
 * Every check returns a value rather than throwing. The server turns a refusal
 * into a `ConvexError`; the form turns it into a line under the field. Neither
 * should have to catch an exception to find out a link was mistyped.
 */

/**
 * The most products one business keeps.
 *
 * The list is read whole — a business's shelf is a few dozen tins and labels,
 * not a catalogue — so this is also the page's window: `list` reads at most
 * this many rows, and `create` refuses the one past it rather than accept a
 * product nobody would ever be shown. The same reasoning as `MAX_SNIPPETS`.
 */
export const MAX_PRODUCTS = 200

/** Room for a full label name with its active constituent and strength
 * ("Termidor Residual Termiticide (Fipronil 100 g/L)") and then some. */
export const MAX_NAME_LENGTH = 120

/** A few paragraphs of "what it is for, how we use it": notes, not a label. */
export const MAX_DESCRIPTION_LENGTH = 2000

/** The practical ceiling browsers and link previews agree on. */
export const MAX_URL_LENGTH = 2048

/** A safety data sheet or label with photographs in it runs to a few MB; a
 * scanned one can reach ten. Twenty leaves room without inviting a manual. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024

/** A phone photo of a tin, at full resolution, with room to spare. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024

/**
 * How long after an upload its file may be claimed by a product.
 *
 * Storage ids are not secrets in this app — report queries hand them out — so
 * "an id you know" cannot mean "a file you may attach". A file uploaded in the
 * last fifteen minutes that nothing has claimed yet is, in practice, the one
 * this person just uploaded for this Save. The same window `notes.ts` uses for
 * a note's pictures, for the same reason.
 */
export const CLAIM_WINDOW_MS = 15 * 60 * 1000

/** A PDF's file name, as kept: long enough for any real one, short enough to
 * fit a share sheet and a download bar. Includes the `.pdf`. */
export const MAX_FILE_NAME_LENGTH = 200

/** The refusals a stored file can earn, as `ConvexError` data. */
export type FileRefusal = 'FILE_TOO_LARGE' | 'WRONG_FILE_TYPE'

/** What a file check needs to know — the shape of a `_storage` row, and of a
 * browser `File` (`type`, `size`) once renamed. */
export type FileFacts = { contentType?: string; size: number }

// ────────────────────────────────────────────────────────────────── the name

/**
 * A product's name as it is compared: trimmed, runs of whitespace (tabs, the
 * double space a thumb leaves) collapsed to one, lower-cased.
 *
 * Stored alongside the name as `nameKey` so the list sorts the way a person
 * reads it — "fipronil" beside "Fipronil", not after every capital — and so
 * "Termidor " and "termidor" are recognised as the same product when the
 * second one is added. Locale-free `toLowerCase`, so the key a server writes
 * and the key a phone computes to warn about a duplicate cannot differ.
 */
export function nameKeyOf(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * A product's name as stored — trimmed — or null when it cannot be one: blank,
 * or longer than `MAX_NAME_LENGTH` once trimmed.
 *
 * Inner spacing is kept as typed. Only the key is folded; the name is what the
 * person wrote, and the list shows it that way.
 */
export function cleanProductName(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > MAX_NAME_LENGTH) return null
  return trimmed
}

/**
 * A description as stored: trimmed, and `undefined` — no description at all,
 * rather than an empty string that can never be told apart from one — when
 * blank. Null when it is longer than `MAX_DESCRIPTION_LENGTH` once trimmed.
 */
export function cleanDescription(input: string): string | undefined | null {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) return null
  return trimmed
}

// ─────────────────────────────────────────────────────────────────── the link

/** `scheme:` at the very start — but only a scheme with no dot in it, which is
 * how "brand.com.au:8080" is told apart from "mailto:" and "javascript:". */
const LEADING_SCHEME = /^([a-z][a-z0-9+.-]*):/i

/**
 * A product link as stored, or why not.
 *
 *  - `undefined`: blank. No link — the same as not giving one.
 *  - `null`: not a link this list will keep. Tell the person; store nothing.
 *  - a string: the link, canonical (`URL.href`), always `http:` or `https:`.
 *
 * Three answers rather than a result object because every caller asks exactly
 * the question the three answer: "is there a link, and is it any good?".
 *
 * The rules, and what each is for:
 *
 *  - Only http and https. The link is tapped, copied and shared to other
 *    people; a `javascript:` or `data:` link would run something on whoever
 *    trusted it, and `mailto:`, `tel:` or `ftp:` are not a product page.
 *  - A bare "brand.com.au" or "brand.com.au/sds" is how links get typed on a
 *    phone, so `https://` is put in front of anything with no scheme of its
 *    own. A scheme is only recognised without a dot in it, so a host with a
 *    port ("brand.com.au:8080") is a host, not a scheme called "brand.com.au".
 *  - The host must have a dot in it. "localhost", "intranet" or a single
 *    mistyped word is not somewhere a colleague's phone can go.
 *  - No user name or password in it. "https://termidor.com.au@example.com"
 *    reads as the brand's site and opens someone else's, and nothing a
 *    product page needs is ever written that way.
 *  - At most `MAX_URL_LENGTH`, as typed and as stored (`href` can come out
 *    longer than what was typed, once spaces are escaped).
 */
export function normaliseProductUrl(input: string): string | undefined | null {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > MAX_URL_LENGTH) return null

  // No scheme of its own ("brand.com.au", "brand.com.au:8080/sds") gets https
  // in front, as does a protocol-relative "//brand.com.au". Anything with a
  // scheme is parsed as typed, and must turn out to be http(s) below.
  const scheme = LEADING_SCHEME.exec(trimmed)?.[1]
  const candidate =
    scheme === undefined || scheme.includes('.')
      ? `https://${trimmed.replace(/^\/+/, '')}`
      : trimmed

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname.includes('.')) return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.href.length > MAX_URL_LENGTH) return null
  return parsed.href
}

// ─────────────────────────────────────────────────────────────────── the PDF

/**
 * The characters that have no business in a file name, all invisible, which
 * download bars and share sheets render as boxes, as line breaks, or by
 * quietly rearranging everything after them:
 *
 *  - `Cc`, every control character: C0 and DEL, and the C1 block
 *    (U+0080–U+009F), whose NEL (U+0085) breaks a line and survives `trim`.
 *  - `Zl` and `Zp`, the Unicode line and paragraph separators.
 *  - `Bidi_Control`: the embeddings, overrides and isolates (U+202A–U+202E,
 *    U+2066–U+2069) and the direction marks (U+200E, U+200F, U+061C). An RLO
 *    turns "sds‹RLO›fdp.exe" into "sdsexe.pdf" on screen, which is a name
 *    lying about what it is.
 *
 * Written as property escapes so the source holds none of them itself.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu

/** Either kind of path separator, in runs. */
const PATH_SEPARATORS = /[/\\]+/g

/**
 * The name a PDF is shown, saved and shared under.
 *
 * Starts from the name the file had on the phone, because "Termidor SDS
 * 2024.pdf" is how the person who uploaded it will look for it later, and
 * falls back to the product's own name when that is blank.
 *
 *  - Path separators become a hyphen. A file name is only ever the last
 *    part of a path, and a slash in one is either a path that should not be
 *    there or a unit that should read as one ("100 g/L" → "100 g-L").
 *  - Control characters go — the C1 ones, line separators and bidi controls
 *    too (`CONTROL_CHARACTERS`) — and the result is trimmed.
 *  - It ends in `.pdf`, lower-case — whatever the phone called it, it is
 *    served as one, and a share sheet or a Files app decides what opens it
 *    by that.
 *  - It fits `MAX_FILE_NAME_LENGTH`, `.pdf` included, cut without splitting a
 *    character that takes two UTF-16 units (an emoji, say): half of one is
 *    not a string Convex can store.
 *  - A name that is nothing but `.pdf`, or dots, is no name: the product's.
 */
export function cleanPdfFileName(input: string, productName: string): string {
  const own = tidyFileName(input)
  if (own !== null) return own
  // The product's name is at most MAX_NAME_LENGTH, so its tidied form always
  // fits; the literal is for a name with nothing left in it at all.
  return tidyFileName(`${productName}.pdf`) ?? 'Product.pdf'
}

function tidyFileName(input: string): string | null {
  const cleaned = input
    .replace(CONTROL_CHARACTERS, '')
    .replace(PATH_SEPARATORS, '-')
    .trim()
  // ".PDF" too: it is written lower-case below either way.
  const stem = /\.pdf$/i.test(cleaned) ? cleaned.slice(0, -4) : cleaned
  const kept = cutAt(stem, MAX_FILE_NAME_LENGTH - '.pdf'.length).trim()
  if (kept.replace(/\./g, '').trim() === '') return null
  return `${kept}.pdf`
}

/** The first `length` UTF-16 units of `text`, without leaving half of a
 * surrogate pair at the end. */
function cutAt(text: string, length: number): string {
  if (text.length <= length) return text
  const cut = text.slice(0, length)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

// ────────────────────────────────────────────────────────────────── the files

/**
 * A content type's bare media type: lower-cased, parameters dropped
 * ("Application/PDF; charset=binary" → "application/pdf"). Undefined when
 * there is none, which is how an upload with no `Content-Type` is stored.
 */
function mediaTypeOf(contentType: string | undefined): string | undefined {
  const bare = contentType?.split(';')[0].trim().toLowerCase()
  return bare === '' ? undefined : bare
}

/**
 * Whether an uploaded file may be a product's PDF: null if so, or the refusal.
 *
 * The type is checked first — a 30 MB photo is refused for being a photo, not
 * for its size — and may be absent. An upload made without a `Content-Type`
 * header is stored without one; refusing those would refuse a real PDF from a
 * browser that did not know what it was, and the viewer is what finds out if
 * it is not one.
 */
export function checkPdfFile(file: FileFacts): FileRefusal | null {
  const type = mediaTypeOf(file.contentType)
  if (type !== undefined && type !== 'application/pdf') return 'WRONG_FILE_TYPE'
  if (file.size > MAX_PDF_BYTES) return 'FILE_TOO_LARGE'
  return null
}

/**
 * Whether an uploaded file may be a product's photo: null if so, or the
 * refusal. Any `image/` type, or none (as for a PDF, above) — except SVG.
 *
 * SVG is refused because it is a document, not a picture: it can carry script,
 * and a file shown to the whole business and opened full screen from its URL
 * should not be able to run anything. A photo of a tin is never one anyway.
 */
export function checkPhotoFile(file: FileFacts): FileRefusal | null {
  const type = mediaTypeOf(file.contentType)
  if (
    type !== undefined &&
    (!type.startsWith('image/') || type === 'image/svg+xml')
  ) {
    return 'WRONG_FILE_TYPE'
  }
  if (file.size > MAX_PHOTO_BYTES) return 'FILE_TOO_LARGE'
  return null
}
