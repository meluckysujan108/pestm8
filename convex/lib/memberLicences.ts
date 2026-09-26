/**
 * My licences: the rules for what a person may keep in their licence wallet,
 * in one place both ends can read.
 *
 * Pure and import-free on purpose, like `lib/licences.ts` (whose file rules
 * every file here still follows): the page imports this directly so it can
 * refuse an empty name, a long number or a date that does not exist before it
 * sends anything, by exactly the rule `convex/memberLicences.ts` enforces.
 *
 * Every check returns a value rather than throwing. The server turns a refusal
 * into a `ConvexError`; the page turns it into a line under the field.
 *
 * Separate from the licence NUMBER on the membership (`licenceNumber`), which
 * prints on reports and decides whether one may be finalised. Nothing here
 * touches that number, and nothing that reads it reads this.
 */

/** The refusals a licence or its files can earn, as `ConvexError` data. */
export type MemberLicenceRefusal =
  | 'INVALID_NAME'
  | 'INVALID_NUMBER'
  | 'INVALID_DATE'
  | 'TOO_MANY_LICENCES'
  | 'TOO_MANY_FILES'

/** Licences one person may keep, and files on one licence. */
export const MAX_LICENCES = 20
export const MAX_LICENCE_FILES = 6

/** Lengths as `.length` counts them — UTF-16 units, which is also what an
 * input's `maxLength` counts, so the field and the server agree. */
export const MAX_LICENCE_NAME_LENGTH = 80
export const MAX_LICENCE_NUMBER_LENGTH = 60

/**
 * The characters that have no business in a name or a number: control
 * characters, line and paragraph separators, bidi controls — the set
 * `lib/licences.ts` strips from file names, and for the same reason (an RLO
 * makes text read backwards on the owner's screen).
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu

/**
 * Tidied text: line breaks and tabs made spaces (a name pasted over two lines
 * keeps its two words), the characters above dropped, runs of spaces made
 * one, trimmed.
 */
function tidy(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * Characters that draw nothing: format characters (a zero-width space, a
 * zero-width joiner, a soft hyphen) and separators. Only ever used to ask
 * whether anything VISIBLE is left, never to strip — the joiner is what holds
 * an emoji like 👷‍♀️ together, and a name may have one.
 */
const INVISIBLE = /[\p{Cf}\p{Z}]/gu

/** Whether `value` would show as nothing at all. */
function looksBlank(value: string): boolean {
  return value.replace(INVISIBLE, '') === ''
}

/**
 * A licence's name as kept — whatever the person calls it ("Pest management
 * (WA)", "Fumigation", "White card") — or INVALID_NAME when nothing visible is
 * left of it or it runs past `MAX_LICENCE_NAME_LENGTH`. Required: it is the
 * only thing that tells one licence from another in the list, and a name of
 * zero-width spaces is a row with no name on the owner's screen.
 */
export function cleanLicenceName(
  input: string,
): { ok: true; value: string } | { ok: false; refusal: 'INVALID_NAME' } {
  const value = tidy(input)
  if (looksBlank(value) || value.length > MAX_LICENCE_NAME_LENGTH) {
    return { ok: false, refusal: 'INVALID_NAME' }
  }
  return { ok: true, value }
}

/**
 * A licence's number as kept, or undefined when there is none — an empty or
 * blank field means "no number", not a refusal, and so does one of nothing
 * but invisible characters (a pasted zero-width space): it looks blank to the
 * person who typed it, and "That number is too long" would make no sense to
 * them. INVALID_NUMBER past `MAX_LICENCE_NUMBER_LENGTH`: a number cut short to
 * fit would be a different number, so it is refused rather than trimmed.
 */
export function cleanLicenceNumber(
  input: string,
):
  | { ok: true; value: string | undefined }
  | { ok: false; refusal: 'INVALID_NUMBER' } {
  const value = tidy(input)
  if (looksBlank(value)) return { ok: true, value: undefined }
  if (value.length > MAX_LICENCE_NUMBER_LENGTH) {
    return { ok: false, refusal: 'INVALID_NUMBER' }
  }
  return { ok: true, value }
}

/** Years an expiry may fall in. Wide on purpose: this only turns away the
 * slip that types "0202" or "20266" into a date field. */
const EARLIEST_YEAR = 1900
const LATEST_YEAR = 2999

/**
 * Whether `input` is a calendar date written `YYYY-MM-DD` — what an
 * `<input type="date">` gives — that exists: 2028-02-29 does, 2027-02-29 and
 * 2027-04-31 do not.
 */
export function isCalendarDate(input: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < EARLIEST_YEAR || year > LATEST_YEAR) return false
  if (month < 1 || month > 12 || day < 1) return false
  return day <= daysInMonth(year, month)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/**
 * A licence's expiry as kept: a calendar date, `YYYY-MM-DD`, or undefined for
 * none (an empty field, which is what a cleared date input sends). Refused
 * with INVALID_DATE when it is not a date that exists.
 *
 * A DATE, never a timestamp: "expires 30 June 2027" is the same day in Perth
 * and in Sydney, and turning it into an instant would make it a day early or
 * late for someone. It is the last day the licence is good for.
 */
export function checkExpiresOn(
  input: string,
):
  | { ok: true; value: string | undefined }
  | { ok: false; refusal: 'INVALID_DATE' } {
  const value = input.trim()
  if (value === '') return { ok: true, value: undefined }
  if (!isCalendarDate(value)) return { ok: false, refusal: 'INVALID_DATE' }
  return { ok: true, value }
}

/**
 * Days from `today` to `expiresOn`, both `YYYY-MM-DD`: 0 on the last day the
 * licence is good for, negative once it has expired (-1 the day after).
 *
 * `today` is the caller's to supply, as the date where the business is —
 * `dayKeyOf(Date.now(), business.timezone)` in `lib/dates.ts` — never the
 * server's or the phone's. Both are read as UTC midnights, so no daylight
 * saving change can make a day 23 hours long here.
 */
export function daysUntilExpiry(expiresOn: string, today: string): number {
  return Math.round((utcMidnight(expiresOn) - utcMidnight(today)) / 86_400_000)
}

function utcMidnight(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

/** Whether a person holding `held` licences may add another. */
export function checkLicenceCount(
  held: number,
): { ok: true } | { ok: false; refusal: 'TOO_MANY_LICENCES' } {
  return held >= MAX_LICENCES
    ? { ok: false, refusal: 'TOO_MANY_LICENCES' }
    : { ok: true }
}

/** Whether a licence with `held` files may take another. */
export function checkLicenceFileCount(
  held: number,
): { ok: true } | { ok: false; refusal: 'TOO_MANY_FILES' } {
  return held >= MAX_LICENCE_FILES
    ? { ok: false, refusal: 'TOO_MANY_FILES' }
    : { ok: true }
}
