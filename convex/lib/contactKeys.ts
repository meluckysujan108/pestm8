import { STREET_TYPES, siteKey } from './clientImport'
import { editDistance } from './contactNames'
import { AREA_CODE, EXTENSION, nationalDigits } from './phone'

/**
 * Phones, emails, names and addresses as matching compares them: the keys
 * behind "is this caller already a client?" (lib/clientMatch.ts), and behind
 * Xero's "which contact is which client" (lib/xeroMatch.ts). Pure and
 * browser-safe, so the phone and the server derive the same keys from the
 * same rows with the same code.
 *
 * Only ever compared, never stored or sent: a rule changed here changes what
 * matches, with no schema change, migration or KEPT_SHAPE bump.
 *
 * A key that matches is evidence, never identity. Agencies, strata managers
 * and families share numbers and emails; the matcher decides what a key is
 * worth, not this module.
 */

export { siteKey }

// ---------------------------------------------------------------- phones

/** Where one field holds several numbers: "0412 345 678 / 08 9345 6789",
 * "… or …", "… and …", "… & …". */
const NUMBER_BREAK = /\s*(?:[/,;&]|\bor\b|\band\b)\s*/i

/**
 * A piece that is only the start of the number after it, once spaces and
 * brackets are gone: an area code ("08/9345 6789"), the country's code ("+61
 * / 412 345 678") or a line number's ("1300/123 456"). Joined to the next
 * piece, not keyed on its own: "9345 6789" alone would take the business's
 * area code, and in a Sydney business "08/9345 6789" would become the Sydney
 * number (02) 9345 6789.
 */
const NUMBER_START = /^(?:0[2378]|\+?61|0061|1[38]00|13)$/

/** The fewest digits another country's number is kept for. */
const MIN_FOREIGN_DIGITS = 6

/**
 * A number nobody answers: what is typed to get past a field that wants
 * one. After the area code or 04, the same digit eight times ("0400 000
 * 000", "0000 000 000", "(08) 1111 1111"). Held by one client, it would
 * otherwise read as that client's own mobile or landline.
 */
const NO_NUMBER = /^0\d(\d)\1{7}$/

/** The area code a local number is matched under, by the business's state:
 * the one `checkPhone`'s Tidy fix would give it. */
export function areaCodeOf(state: string | undefined): string {
  return AREA_CODE[state?.trim().toUpperCase() ?? ''] ?? '08'
}

/**
 * Every number in a phone field, as a key each. In order:
 *
 *  1. A field holding several numbers is split ("/", ",", ";", "or", "and",
 *     "&"), a piece that is only an area code or a country's or a line's
 *     code is joined to the next ("08/9345 6789"), and a trailing extension
 *     is set aside.
 *  2. +61, 0061 and 61 are written back as the leading 0.
 *  3. A line number first, whatever its length: 13 xx xx, 1300 and 1800 are
 *     `line:` keys. A business answers on them, not a person, so they are
 *     never anyone's own number.
 *  4. Ten digits are the key as they are. Eight are a local number, with the
 *     business's area code in front ("9345 6789" in Perth is 08 9345 6789).
 *     Nine starting with 4 are a mobile missing its 0. Another country's
 *     number is a + and every digit. Anything else gives no key, and nor does
 *     a number nobody answers ("0400 000 000").
 *
 * Not the last eight digits, which would make (02) 9345 6789 and (08) 9345
 * 6789 one number.
 */
export function phoneKeys(
  raw: string | undefined,
  areaCode: string,
): Array<string> {
  if (raw === undefined || raw.trim() === '') return []
  const keys: Array<string> = []
  let start = ''
  for (const part of raw.split(NUMBER_BREAK)) {
    if (NUMBER_START.test(part.replace(/[\s()]/g, ''))) {
      start += `${part} `
      continue
    }
    const key = onePhoneKey(start + part, areaCode)
    start = ''
    if (key !== null && !keys.includes(key)) keys.push(key)
  }
  return keys
}

function onePhoneKey(part: string, areaCode: string): string | null {
  const number = part.replace(EXTENSION, '').trim()
  if (number === '') return null
  const digits = nationalDigits(number)
  if (digits === null) {
    const all = number.replace(/\D/g, '')
    return all.length >= MIN_FOREIGN_DIGITS ? `+${all}` : null
  }
  if (/^13\d{4}$/.test(digits) || /^1[38]00\d{6}$/.test(digits)) {
    return `line:${digits}`
  }
  const key =
    digits.length === 10
      ? digits
      : // A local number never starts with 0 or 1 (lib/phone.ts says why).
        /^[2-9]\d{7}$/.test(digits)
        ? `${areaCode}${digits}`
        : /^4\d{8}$/.test(digits)
          ? `0${digits}`
          : null
  return key !== null && !NO_NUMBER.test(key) ? key : null
}

export type PhoneKeyKind = 'mobile' | 'landline' | 'line' | 'foreign'

/**
 * What kind of number a key is. A mobile is usually one person's; a landline
 * may be a household's or an office's, so it needs the name to agree before
 * it is anyone's. A ten-digit number that is neither 04 nor an area code is
 * read as a landline: the wary way to be wrong.
 */
export function phoneKind(key: string): PhoneKeyKind {
  if (key.startsWith('line:')) return 'line'
  if (key.startsWith('+')) return 'foreign'
  if (key.startsWith('04')) return 'mobile'
  return 'landline'
}

// ---------------------------------------------------------------- emails

/**
 * An email as Xero matching compares it: trimmed and lower-cased; empty is
 * none. One address, as Xero holds one.
 */
export function emailKey(raw: string | undefined): string | null {
  const text = (raw ?? '').trim().toLowerCase()
  return text === '' ? null : text
}

/** The part before the @ of an address nobody reads: what is typed to get
 * past a field that wants one ("noemail@noemail.com", "none@none.com"). */
const NO_EMAIL = new Set([
  'noemail',
  'no-email',
  'no_email',
  'none',
  'no',
  'na',
  'n/a',
  'nil',
  'null',
  'unknown',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
])

/**
 * Every address in an email field, as a key each: trimmed, lower-cased,
 * `mailto:` and angle brackets dropped, split on commas, semicolons and
 * spaces, and only what holds an @ kept. Gmail's dots and +tags are left as
 * they are: jane.nguyen@ and jane+pest@ may well be someone else's. An
 * address nobody reads ("noemail@…", "none@…") gives no key: held by one
 * client, it would otherwise read as that client's own.
 */
export function emailKeys(raw: string | undefined): Array<string> {
  if (raw === undefined) return []
  const keys: Array<string> = []
  for (const part of raw.toLowerCase().split(/[,;\s]+/)) {
    const key = part
      .replace(/^mailto:/, '')
      .replace(/^[<("']+/, '')
      .replace(/[>)"']+$/, '')
    const at = key.indexOf('@')
    if (at < 0 || NO_EMAIL.has(key.slice(0, at))) continue
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

// ---------------------------------------------------------------- names

/** Company endings a name may carry in one book and not the other ("Acme
 * Pty Ltd" in Xero, "ACME" on the job card). Longest first, so "pty ltd"
 * goes whole rather than leaving "pty" behind. */
const COMPANY_ENDINGS: ReadonlyArray<ReadonlyArray<string>> = [
  ['pty', 'ltd'],
  ['pty', 'limited'],
  ['ltd'],
  ['limited'],
  ['pty'],
]

/**
 * A name as matching compares it: lower-case, accents dropped, `&` read as
 * "and", punctuation gone, one trailing company ending dropped, and the words
 * SORTED — so "Smith, John" and "John Smith" agree, as do "Acme Pty Ltd" and
 * "ACME". Apostrophes and full stops join their letters ("O'Brien" is
 * "obrien", "A.B." is "ab"); any other punctuation separates words. A name of
 * nothing but punctuation or a company ending is '' — which matches nothing.
 */
export function nameKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '')
  dropCompanyEnding(words)
  return words.sort().join(' ')
}

/** As `nameKey` reads a name, with `+` as "and" too ("J + T Nguyen"), and
 * the words left in the order they were written. */
function plainWords(name: string): Array<string> {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/['’‘`.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '')
}

function dropCompanyEnding(words: Array<string>): void {
  for (const ending of COMPANY_ENDINGS) {
    if (endsWith(words, ending)) {
      words.splice(words.length - ending.length)
      return
    }
  }
}

function endsWith(
  words: ReadonlyArray<string>,
  ending: ReadonlyArray<string>,
): boolean {
  if (words.length < ending.length) return false
  const offset = words.length - ending.length
  return ending.every((word, i) => words[offset + i] === word)
}

/** Titles, which say nothing about who someone is. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr'])

/** "Tom Lee c/- Ray White", "Tom Lee c/o Ray White": care of. */
const CARE_OF = /\bc\s*\/\s*(?:-|o\b)/i

/**
 * The part of a name that names the person: what comes before "c/-" or
 * "c/o" ("Tom Lee c/- Ray White" is Tom Lee, care of the agency), or what
 * comes after it when nothing comes before.
 */
function withoutCareOf(name: string): string {
  const at = name.search(CARE_OF)
  if (at < 0) return name
  const before = name.slice(0, at)
  return before.trim() !== '' ? before : name.slice(at).replace(CARE_OF, '')
}

/**
 * A name's words for `nameNear`, in the order they were written: as
 * `nameKey` reads them, with titles, "and" (from "and", "&" and "+") and
 * "c/-" dropped, and a trailing company ending.
 */
export function nameWords(name: string): Array<string> {
  const words = plainWords(withoutCareOf(name)).filter(
    (word) => word !== 'and' && !TITLES.has(word),
  )
  dropCompanyEnding(words)
  return words
}

/** Whether a name is two or more people's: "J & T Nguyen", "Mr and Mrs
 * Nguyen". */
function isHousehold(name: string): boolean {
  return plainWords(withoutCareOf(name)).includes('and')
}

/**
 * A person's surname: the words before a comma ("Smith, John"), else the
 * last word. '' when the name has no words.
 */
export function surnameOf(name: string): string {
  return personName(name)?.surname ?? ''
}

type PersonName = {
  surname: string
  given: Array<string>
  household: boolean
  /** Every word, the surname's included. */
  words: number
}

function personName(raw: string): PersonName | null {
  const name = withoutCareOf(raw)
  const household = isHousehold(name)
  const comma = name.indexOf(',')
  if (comma > 0) {
    const surname = nameWords(name.slice(0, comma))
    if (surname.length > 0) {
      const given = nameWords(name.slice(comma + 1))
      return {
        surname: surname.join(' '),
        given,
        household,
        words: surname.length + given.length,
      }
    }
  }
  const words = nameWords(name)
  if (words.length === 0) return null
  return {
    surname: words[words.length - 1],
    given: words.slice(0, -1),
    household,
    words: words.length,
  }
}

/** Two given names agree when they are the same, or one is the other's
 * initial: "J" and "Jane". */
function givenAgrees(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length === 1) return b.startsWith(a)
  if (b.length === 1) return a.startsWith(b)
  return false
}

/**
 * Whether two names are probably the same customer's, written two ways:
 * "similar name", never "same name".
 *
 * People: both have two or more words; the surnames are equal; and every
 * given name on each side is, or is the initial of, one on the other — "J
 * Nguyen" and "Jane Nguyen". A household ("J & T Nguyen", "Mr & Mrs J
 * Nguyen") is several people, so its given names are alternatives: the other
 * side's must each agree with one of them, so "J & T Nguyen" is near "Tom
 * Nguyen". Titles and "and" are not words.
 *
 * Businesses: once company endings are dropped, every word of the shorter
 * name (two or more words) is in the longer — "Ray White" and "Ray White
 * Bayswater".
 *
 * A one-word name is never near anything: a surname alone is every Smith.
 * `kind` is the client's on the other side; a contact person is a person.
 */
export function nameNear(
  a: string,
  b: string,
  kind: 'person' | 'business' = 'person',
): boolean {
  if (kind === 'business') {
    const wa = nameWords(a)
    const wb = nameWords(b)
    const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
    if (shorter.length < 2) return false
    const words = new Set(longer)
    return shorter.every((word) => words.has(word))
  }
  const pa = personName(a)
  const pb = personName(b)
  if (!pa || !pb || pa.words < 2 || pb.words < 2) return false
  if (pa.surname !== pb.surname) return false
  const agreesWithOne = (word: string, others: ReadonlyArray<string>) =>
    others.some((other) => givenAgrees(word, other))
  if (pa.household && pb.household) {
    return (
      pa.given.length === 0 ||
      pb.given.length === 0 ||
      pa.given.some((word) => agreesWithOne(word, pb.given))
    )
  }
  if (pa.household || pb.household) {
    const [household, person] = pa.household ? [pa, pb] : [pb, pa]
    return (
      household.given.length === 0 ||
      person.given.every((word) => agreesWithOne(word, household.given))
    )
  }
  return (
    pa.given.every((word) => agreesWithOne(word, pb.given)) &&
    pb.given.every((word) => agreesWithOne(word, pa.given))
  )
}

/**
 * The words a client is saved under when nobody knew their name: "The
 * Owner/Occupier", "Tenants", "Cash Sale", "Body Corporate", "N/A", "TBC".
 * A name made of nothing else is a placeholder, in any order and any mix.
 */
const PLACEHOLDER_WORDS = new Set([
  'the',
  'a',
  'n',
  'na',
  'owner',
  'owners',
  'occupier',
  'occupiers',
  'occupant',
  'occupants',
  'tenant',
  'tenants',
  'resident',
  'residents',
  'landlord',
  'property',
  'manager',
  'body',
  'corporate',
  'corporation',
  'strata',
  'plan',
  'unknown',
  'customer',
  'customers',
  'client',
  'new',
  'cash',
  'sale',
  'tba',
  'tbc',
])

/**
 * Whether a name says nothing about who someone is: "The Owner", "The
 * Owner/Occupier", "Tenants", "Cash Sale", "N/A", or no name at all. Every
 * word is a placeholder's once titles, "and" and "c/-" are dropped ("Owner c/-
 * Ray White" is a placeholder too); one word of anything else makes it a
 * name ("Owner Smith", "Strata Plan 12345"). Never name evidence, however
 * many clients carry it.
 */
export function isPlaceholderName(name: string): boolean {
  if (nameKey(name) === '') return true
  return nameWords(name).every((word) => PLACEHOLDER_WORDS.has(word))
}

// ---------------------------------------------------------------- addresses

type SiteAddress = { addressLine: string; suburb: string; postcode: string }

/** `siteKey`'s three parts: the street, the suburb and the postcode. */
function siteParts(site: SiteAddress): {
  street: string
  suburb: string
  postcode: string
} {
  const [street = '', suburb = '', postcode = ''] = siteKey(site).split('|')
  return { street, suburb, postcode }
}

/**
 * The street and postcode, without the suburb: "12 Wattle St" typed in the
 * wrong suburb of the same postcode. A suggestion only: one postcode can
 * hold two suburbs with a street of the same name.
 */
export function streetKey(site: SiteAddress): string {
  const { street, postcode } = siteParts(site)
  return `${street}|${postcode}`
}

/** Words whose number is not the house's: "Lot 5", "Shop 3", "Level 2". */
const WITHIN = new Set([
  'lot',
  'shop',
  'level',
  'lvl',
  'suite',
  'ste',
  'kiosk',
  'office',
  'building',
  'bldg',
  'block',
  'warehouse',
  'factory',
])

/**
 * A street line's house number, unit and street name: "3/12 ocean pde" is
 * unit 3 of number 12, Ocean Pde. A Lot, Shop or Level number is part of the
 * unit, never the house's: "shop 3 12 ocean pde" is shop 3 of number 12, and
 * "lot 5 smith rd" is lot 5 with no house number. Null when the line has no
 * number.
 */
function houseOf(
  street: string,
): { unit: string; number: string; street: string } | null {
  const words = street.split(' ')
  const within: Array<string> = []
  let after = 0
  for (let at = 0; at < words.length; at++) {
    const word = words[at]
    if (!/\d/.test(word)) continue
    const rest = words.slice(at + 1).join(' ')
    const unit = /^(\d+\p{L}?)\/(\d+\p{L}?)$/u.exec(word)
    const kind = at > 0 && WITHIN.has(words[at - 1]) ? words[at - 1] : null
    if (unit) {
      // "shop 3/12" is shop 3 of number 12, as "3/12" is unit 3 of it.
      return {
        unit: [...within, kind ? `${kind} ${unit[1]}` : unit[1]].join(' '),
        number: unit[2],
        street: rest,
      }
    }
    if (kind) {
      within.push(`${kind} ${word}`)
      after = at + 1
      continue
    }
    if (/^\d+\p{L}?$/u.test(word)) {
      return { unit: within.join(' '), number: word, street: rest }
    }
    return null
  }
  if (within.length === 0) return null
  return {
    unit: within.join(' '),
    number: '',
    street: words.slice(after).join(' '),
  }
}

/** A street's name and its type: "wattle st" is Wattle, a street, and
 * "ocean pde east" is Ocean, a parade, east. The last type word is the type;
 * a name with none has no type. */
function streetParts(street: string): { name: string; type: string } {
  const words = street.split(' ')
  for (let at = words.length - 1; at > 0; at--) {
    if (STREET_TYPES.has(words[at])) {
      return {
        name: words.slice(0, at).join(' '),
        type: words.slice(at).join(' '),
      }
    }
  }
  return { name: street, type: '' }
}

/** The slips a street name may have and still be the same street: none in a
 * name of three letters or fewer, one in five or fewer, else two. */
function slipsAllowed(name: string): number {
  return name.length <= 3 ? 0 : name.length <= 5 ? 1 : 2
}

/**
 * Whether two addresses are probably one place written two ways: "12 Watle
 * St" and "12 Wattle St", "12 Ocean Pde" and "Common Property 12 Ocean Pde".
 *
 * The same house number and unit (3/12 is never 12, Shop 3 at 12 is never
 * 12, and Lot 5 is never number 5); the same postcode (810 is 0810) or the
 * same suburb; and either one street containing the other, or the same
 * street type (or none written on one side) with the names a slip or two
 * apart, fewer in a short name. Wattle St and Wattle Ct are two streets. An
 * address with no number is near nothing.
 *
 * For one client's own sites only, a handful of rows, where a wrong guess
 * costs a glance. Never enough to act on without a tap.
 */
export function addressNear(a: SiteAddress, b: SiteAddress): boolean {
  const pa = siteParts(a)
  const pb = siteParts(b)
  const samePlace =
    (pa.postcode !== '' && pa.postcode === pb.postcode) ||
    (pa.suburb !== '' && pa.suburb === pb.suburb)
  if (!samePlace) return false
  const ha = houseOf(pa.street)
  const hb = houseOf(pb.street)
  if (!ha || !hb) return false
  if (ha.number !== hb.number || ha.unit !== hb.unit) return false
  if (ha.street === hb.street) return true
  if (ha.street === '' || hb.street === '') return false
  const [shorter, longer] =
    ha.street.length <= hb.street.length
      ? [ha.street, hb.street]
      : [hb.street, ha.street]
  if (` ${longer} `.includes(` ${shorter} `)) return true
  const sa = streetParts(ha.street)
  const sb = streetParts(hb.street)
  if (sa.type !== '' && sb.type !== '') {
    return sa.type === sb.type && slipsApart(sa.name, sb.name)
  }
  // A type on one side or neither: the whole street, which may hold a
  // misspelt one ("12 Ocean Prade").
  return slipsApart(shorter, longer)
}

/** Whether two street names are within the slips the shorter allows. */
function slipsApart(a: string, b: string): boolean {
  const shorter = a.length <= b.length ? a : b
  return editDistance(a, b) <= slipsAllowed(shorter)
}
