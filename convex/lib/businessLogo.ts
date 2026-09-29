import type { Doc, Id } from '../_generated/dataModel'

/**
 * A business's logo, as the letterhead prints it and as an email carries it:
 * the rules both ends read. The browser draws the files
 * (src/lib/images/prepareLogo.ts); the server checks what it is sent against
 * the same numbers and puts them in the email (lib/reportEmail.ts).
 *
 * A logo is kept as up to four files:
 *
 * - `logoStorageId`, the logo itself, trimmed to its artwork: what the PDF
 *   prints on the cover and at the top of every page, and what Settings
 *   shows. A PNG whenever it has any transparency, since a JPEG has none and
 *   turns clear areas black.
 * - `logoEmail`, that logo on a white card, for email. The mail apps that
 *   darken an email by inverting its colours (the Gmail app, Outlook for
 *   Windows) never invert its images, so a transparent logo with dark
 *   lettering vanishes into the darkened background; on its own card it stays
 *   readable. On the white email the card cannot be seen.
 * - `logoOnDark`, optional: a version with light lettering, for the mail apps
 *   that follow the email's own dark styling (Apple Mail, Outlook for Mac and
 *   phones, Outlook.com), with its own email copy on the card's geometry but
 *   transparent.
 */

/** The box a logo is fitted into in an email, in CSS pixels, and its card. */
export const EMAIL_LOGO = {
  maxWidth: 200,
  maxHeight: 56,
  /** The card's margin round the logo. */
  padding: 10,
  /** The card's corner. */
  radius: 10,
  /** Device pixels to a CSS pixel in the email's copies: sharp on a phone. */
  scale: 3,
} as const

/**
 * The longest edge a logo is kept at. It prints at most 240pt wide on the
 * cover, where 1600px is over 450 dpi; more is bytes in every PDF and no
 * sharper on paper.
 */
export const LOGO_MAX_EDGE = 1600

/** A file bigger than this is not a logo. */
export const MAX_LOGO_BYTES = 5 * 1024 * 1024

/** The two kinds of picture the PDF painter draws (@react-pdf/image). A GIF
 * or a WebP it skips without a word, which is how reports locked with the
 * GIF Pest M8 used until 29 Sept 2026 printed no logo at all. */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg'])

/**
 * Why a stored file cannot be a logo, as `ConvexError` data, or null.
 *
 * A type, when there is one, must be one the painter draws. An upload made
 * without a `Content-Type` is stored without one and is let through, as a
 * product's is (lib/products.ts): this app's own screens always send one, and
 * a file that is not a picture only ever fails to draw.
 */
export function logoFileRefusal(file: {
  contentType?: string
  size: number
}): 'WRONG_FILE_TYPE' | 'FILE_TOO_LARGE' | null {
  const type = file.contentType?.split(';')[0].trim().toLowerCase()
  if (type && !LOGO_TYPES.has(type)) return 'WRONG_FILE_TYPE'
  if (file.size > MAX_LOGO_BYTES) return 'FILE_TOO_LARGE'
  return null
}

/**
 * A logo's size in the email: as large as the box allows, its shape kept.
 * A wide logo fills the width and a square one the height, so the two read
 * at a similar weight.
 */
export function fitEmailLogo(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(
    EMAIL_LOGO.maxWidth / width,
    EMAIL_LOGO.maxHeight / height,
  )
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** The card a logo of that size sits on: the logo and its margin. */
export function emailCardSize(logo: { width: number; height: number }) {
  return {
    width: logo.width + 2 * EMAIL_LOGO.padding,
    height: logo.height + 2 * EMAIL_LOGO.padding,
  }
}

/** Whether a size is one a card could have: whole pixels, no bigger than
 * the box and its margin, and room for a logo inside the margin. */
export function isEmailCardSize({
  width,
  height,
}: {
  width: number
  height: number
}): boolean {
  const pad = 2 * EMAIL_LOGO.padding
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > pad &&
    height > pad &&
    width <= EMAIL_LOGO.maxWidth + pad &&
    height <= EMAIL_LOGO.maxHeight + pad
  )
}

/**
 * Every stored file a business's logos use now. Not the ones they used
 * before: a finished report keeps the logo it was locked with, and an email
 * already sent shows the copy it was sent with, so a replaced logo's files
 * are never deleted.
 */
export function logoFilesOf(
  business: Pick<
    Doc<'businesses'>,
    'logoStorageId' | 'logoEmail' | 'logoOnDark'
  >,
): Array<Id<'_storage'>> {
  return [
    business.logoStorageId,
    business.logoEmail?.storageId,
    business.logoOnDark?.storageId,
    business.logoOnDark?.email.storageId,
  ].filter((id): id is Id<'_storage'> => id !== undefined)
}
