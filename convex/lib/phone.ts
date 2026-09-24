import { ConvexError } from 'convex/values'

/**
 * Australian phone numbers as typed into the app (clients, contacts, site
 * contacts, the business, a member's own number). Pure, so a form can check
 * a number as it is typed with the rule the server enforces.
 *
 * Call and Text dial whatever is saved (`tel:` / `sms:`), so a number missing
 * its area code rings the wrong line, and one with a letter in it may not
 * dial at all. The one hard rule is a number that can never be dialled; the
 * rest are warnings with a one-tap fix, because the person on the phone to
 * the customer may know better (an overseas owner, an internal extension).
 */

export type PhoneKind =
  'mobile' | 'landline' | 'local' | 'special' | 'international' | 'unknown'

export type PhoneCheck = {
  level: 'ok' | 'warning' | 'error'
  kind: PhoneKind
  /** For the person typing, when level is not 'ok'. */
  message?: string
  /** The number written the usual way, offered as a one-tap fix when it
   * differs from what was typed and the meaning is not in doubt. */
  tidy?: string
}

/** The fewest digits any number worth dialling has (13 xx xx). */
const MIN_DIGITS = 6

/** A trailing extension, kept as typed: "ext 2", "x21". */
const EXTENSION = /\s*(?:ext\.?|extension|x)\s*(\d{1,6})\s*$/i

/** The area code an 8-digit local number most likely belongs to. */
const AREA_CODE: Record<string, string> = {
  ACT: '02',
  NSW: '02',
  VIC: '03',
  TAS: '03',
  QLD: '07',
  SA: '08',
  WA: '08',
  NT: '08',
}

function splitExtension(raw: string): { number: string; extension: string } {
  const match = EXTENSION.exec(raw)
  if (!match) return { number: raw.trim(), extension: '' }
  return {
    number: raw.slice(0, match.index).trim(),
    extension: ` ext ${match[1]}`,
  }
}

function group(digits: string, sizes: Array<number>): string {
  const parts: Array<string> = []
  let at = 0
  for (const size of sizes) {
    parts.push(digits.slice(at, at + size))
    at += size
  }
  return parts.join(' ')
}

/** Every digit, with +61 / 0061 / 61 written back as the leading 0 a number
 * has when dialled from inside Australia. Null for another country's code. */
function nationalDigits(number: string): string | null {
  const plus = number.trim().startsWith('+')
  let digits = number.replace(/\D/g, '')
  if (digits.startsWith('0061')) digits = digits.slice(4)
  else if (plus && digits.startsWith('61')) digits = digits.slice(2)
  else if (plus) return null
  else if (digits.startsWith('61') && digits.length === 11) {
    digits = digits.slice(2)
  } else return digits
  // "+61 (0)8 …": the 0 in brackets is not dialled after +61.
  if (digits.startsWith('0')) digits = digits.slice(1)
  return `0${digits}`
}

export function checkPhone(
  raw: string,
  opts: { businessState?: string } = {},
): PhoneCheck {
  const { number, extension } = splitExtension(raw)
  if (number === '') return { level: 'ok', kind: 'unknown' }

  if (/[a-z]/i.test(number)) {
    return {
      level: 'error',
      kind: 'unknown',
      message:
        'A phone number can only have digits, spaces, brackets and a +. Put a name or note somewhere else.',
    }
  }
  const allDigits = number.replace(/\D/g, '')
  if (allDigits.length < MIN_DIGITS) {
    return {
      level: 'error',
      kind: 'unknown',
      message: 'That is too short for a phone number.',
    }
  }

  const digits = nationalDigits(number)
  if (digits === null) {
    // Another country's code: trusted as typed.
    return { level: 'ok', kind: 'international' }
  }

  const done = (kind: PhoneKind, sizes: Array<number>): PhoneCheck => {
    const tidy = `${group(digits, sizes)}${extension}`
    return tidy === raw.trim()
      ? { level: 'ok', kind }
      : { level: 'ok', kind, tidy }
  }

  if (/^04\d{8}$/.test(digits)) return done('mobile', [4, 3, 3])
  if (/^0[2378]\d{8}$/.test(digits)) return done('landline', [2, 4, 4])
  if (/^1[38]00\d{6}$/.test(digits)) return done('special', [4, 3, 3])
  if (/^13\d{4}$/.test(digits)) return done('special', [2, 2, 2])

  if (/^05\d{8}$/.test(digits)) {
    return {
      level: 'warning',
      kind: 'unknown',
      message: '05 numbers are not in use in Australia yet. Check it.',
    }
  }
  // A local number never starts with 0 or 1: "0412 3456" is a mobile missing
  // two digits, not a Perth landline, and an area code in front would make
  // it a wrong number rather than a fixed one.
  if (/^[2-9]\d{7}$/.test(digits)) {
    const area = AREA_CODE[opts.businessState?.toUpperCase() ?? ''] ?? '08'
    return {
      level: 'warning',
      kind: 'local',
      message: `Missing the area code. From a mobile it will not connect without one.`,
      tidy: `${area} ${group(digits, [4, 4])}${extension}`,
    }
  }
  if (/^4\d{8}$/.test(digits)) {
    return {
      level: 'warning',
      kind: 'mobile',
      message: 'A mobile number starts with 04.',
      tidy: `0${group(digits, [3, 3, 3])}${extension}`,
    }
  }
  return {
    level: 'warning',
    kind: 'unknown',
    message: `This does not look like an Australian number (it has ${digits.length} digits). Check it.`,
  }
}

/**
 * A phone number as stored: trimmed, and absent when blank. `undefined` in
 * means "not given"; a blank string means "none". Refused only when it can
 * never be dialled — too few digits. The stricter checks (letters, a missing
 * area code) are the form's, as warnings, so nothing an older screen sends is
 * turned away for a note in brackets.
 */
export function normalisePhone(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  if (raw.replace(/\D/g, '').length < MIN_DIGITS) {
    throw new ConvexError('INVALID_PHONE')
  }
  return raw.trim()
}
