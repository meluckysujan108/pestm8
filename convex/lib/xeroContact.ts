import { formatAbn } from './abn'
import { checkPhone } from './phone'
import type { Doc } from '../_generated/dataModel'
import type {
  XeroContactAddress,
  XeroContactFull,
  XeroContactPerson,
  XeroContactPhone,
} from './xeroHttp'

/**
 * A PestM8 client as a Xero contact (Release 3, convex/xeroSync.ts): which
 * of the contact's fields PestM8 fills in, what they say, which of them to
 * send this time, and the request bodies that send them. Pure — no `ctx`,
 * no rows, no clock, no `fetch` — so it runs in a query, a mutation or an
 * action alike, and every rule is tested on its own (xeroContact.test.ts).
 *
 * ── Fields ────────────────────────────────────────────────────────────────
 *
 * A contact is compared and sent field by field (`FieldKey`), each held in
 * one canonical shape on both sides — what PestM8 would put there
 * (`ownedFields`) and what Xero holds (`fieldsFromXero`) — so the two can
 * be hashed (`fieldHash`) and compared. A field absent from `ownedFields`
 * is not PestM8's to fill for this client; one present but blank ('', [])
 * is PestM8's, and PestM8 has nothing in it.
 *
 * ── Compare before set (`diff`) ───────────────────────────────────────────
 *
 * PestM8 sends a field only when PestM8 changed it since it last sent it,
 * and Xero still holds what it held then (or nothing at all). A field Xero
 * changed meanwhile — a bookkeeper's better billing email — is left alone
 * and reported (`different`), for the holder to overwrite on purpose. A
 * contact matched in Release 2 has no record of anything sent, and only
 * has its blanks filled: linking never overwrites what Xero holds.
 *
 * ── Merge-safe arrays (decided 2026-10-15) ────────────────────────────────
 *
 * Xero does not document whether a contact's Phones, Addresses or
 * ContactPersons sent in part replace the whole list. So an update never
 * sends part of one (`toXeroUpdate`): it sends Xero's own list back with
 * PestM8's changed entries in place, and keeps everything else — the DDI and
 * FAX lines, a PO box PestM8 is not changing, the bookkeeper's accounts@
 * person. The Demo Company gate (docs/xero.md) settles it; until then this
 * is right either way.
 *
 * ── Clearing ──────────────────────────────────────────────────────────────
 *
 * Whether Xero takes "" as "clear this" or "leave it" is not documented
 * either (`XERO_CLEARS_WITH_EMPTY`). Until it is proven, nothing blank is
 * ever sent: a value PestM8 removed stays in Xero, and the field is
 * reported as different.
 */

/** ContactPersons are written only on contacts PestM8 created, until the
 * Demo Company gate shows whether sending them replaces the bookkeeper's. */
export const CONTACT_PERSONS_ON_MATCHED = false as boolean

/** Whether "" clears a field in Xero. Until the Demo Company gate proves it,
 * a blank is never sent. */
export const XERO_CLEARS_WITH_EMPTY = false as boolean

/** The most people Xero keeps on a contact. */
export const MAX_CONTACT_PERSONS = 5

/** A contact's Name: Xero's limit is 255, and a name is cut to 230 so a
 * clash suffix (" (Nightcliff)", " #1916") still fits. */
const XERO_NAME_MAX = 255
const NAME_ROOM = 230
/** A suburb in a suffix: room for the longest real ones. */
const SUFFIX_PLACE_MAX = 60

/** Xero's limits on the other fields PestM8 writes. */
const LIMITS = {
  personName: 255,
  email: 255,
  taxNumber: 50,
  accountNumber: 50,
  phoneNumber: 50,
  phoneAreaCode: 10,
  addressLine: 500,
  city: 255,
  region: 255,
  postcode: 50,
} as const

/** Every address PestM8 writes is in Australia. */
const COUNTRY = 'Australia'

export type FieldKey =
  | 'name'
  | 'person'
  | 'email'
  | 'phoneDefault'
  | 'phoneMobile'
  | 'pobox'
  | 'street'
  | 'taxNumber'
  | 'accountNumber'
  | 'persons'

/** Every field, in the order they are compared and reported. */
export const FIELD_KEYS: ReadonlyArray<FieldKey> = [
  'name',
  'person',
  'email',
  'phoneDefault',
  'phoneMobile',
  'pobox',
  'street',
  'taxNumber',
  'accountNumber',
  'persons',
]

/**
 * A contact's fields in canonical shape. Absent: not PestM8's to fill.
 * Blank ('' or []): PestM8's, with nothing in it. The shapes:
 * - name, email, taxNumber, accountNumber: a trimmed string;
 * - person: `PersonName` (FirstName / LastName);
 * - phoneDefault, phoneMobile: `PhoneValue`;
 * - pobox, street: `AddressValue`;
 * - persons: `Array<PersonEntry>`, every one PestM8 has — the cap of five
 *   is applied when a body is built, so a sixth is reported, not lost
 *   silently.
 */
export type Fields = Partial<Record<FieldKey, unknown>>

export type PersonName = { first: string; last: string }
export type PhoneValue = { areaCode: string; number: string }
export type AddressValue = {
  line1: string
  line2?: string
  line3?: string
  line4?: string
  city: string
  region: string
  postcode: string
  country: string
}
export type PersonEntry = { first: string; last: string; email: string }

/**
 * One client, as much of it as its contact is made from. Gathered by the
 * sync (convex/xeroSync.ts `nextWork`) in a query.
 */
export type ContactInput = {
  client: Doc<'clients'>
  /** A business's contact person (lib/contactPerson.ts `contactPersonOf`)
   * with their email; null for a person, or a business with none. */
  primary: { name: string; email?: string } | null
  /** A business's other contacts: not in the Recycle bin, not the primary,
   * named, oldest first. */
  others: Array<{ name: string; email?: string }>
  /** The client's oldest site not in the Recycle bin (`by_client` order). */
  oldestSite: {
    addressLine: string
    suburb: string
    state: string
    postcode: string
  } | null
  /** The pest business's own state: the area code a local landline is
   * given (lib/phone.ts `checkPhone`). */
  businessState?: string
  /** Brought in by an import being undone: about to be deleted, or kept and
   * queued again when the undo gets to it (convex/clientImports.ts
   * `undoStep`). */
  undoing?: boolean
}

/** What a client is in one organisation (schema.ts `xeroLinkState`, with
 * Release 3's own). */
export type LinkState =
  | 'linked'
  | 'needs_review'
  | 'separate'
  | 'new'
  | 'archived_in_xero'
  | 'gdpr'
  | 'failed'
  | 'shared'

/** How a linked client came to be its contact. */
export type LinkHow = 'matched' | 'chosen' | 'created' | 'relinked'

/** The part of a `xeroContactLinks` row eligibility reads. */
export type LinkLike = {
  state: LinkState
  xeroContactId?: string
  how?: LinkHow
}

/** FieldKey → `fieldHash`. */
export type FieldHashes = Record<string, string>

/**
 * The part of a `xeroContactLinks` row `diff` reads:
 * - `sent[F]`: the hash of PestM8's value of F as last settled with Xero —
 *   sent, or found already there;
 * - `seen[F]`: the hash of Xero's value of F right after that (its own
 *   normalised form of what PestM8 sent);
 * - `how`: whether PestM8 created the contact.
 */
export type LinkHashes = {
  sent?: FieldHashes
  seen?: FieldHashes
  how?: LinkHow
}

/**
 * Whether a client is sent to one organisation, and how:
 * - `gone`: the client no longer exists;
 * - `binned`: in the Recycle bin — syncing stops until it is restored;
 * - `archived`: archived the legacy way (`archivedAt`) — never sent;
 * - `undoing`: its import is being undone — nothing sent meanwhile, so a
 *   list the person took back isn't added to Xero while it goes;
 * - `stopped`: archived in Xero, or frozen there by a GDPR request;
 * - `shared`: the same customer as another client, whose contact it uses
 *   (Keep both): never sent — that client's changes are, and two clients
 *   writing one contact would undo each other;
 * - `review`: waiting on the holder's Same / Different;
 * - `lead`: a lead with no contact yet — added when first booked;
 * - `create`: no contact yet, so one is made;
 * - `update`: linked to a contact, which is kept in step.
 */
export type Eligibility =
  | 'gone'
  | 'binned'
  | 'archived'
  | 'undoing'
  | 'stopped'
  | 'shared'
  | 'review'
  | 'lead'
  | 'create'
  | 'update'

/**
 * Why a contact is not quite what PestM8 has, as a code the screen words
 * (src/components/xero/xeroCopy.ts):
 * - `email_not_ascii`: Xero refuses an email with letters outside ASCII
 *   ("jürgen@…"), so the contact is sent without it;
 * - `name_invalid`: nothing is left of the name once what Xero refuses is
 *   taken out;
 * - `persons_full`: Xero keeps five people on a contact, and some of
 *   PestM8's did not fit.
 */
export type MapperProblem = 'email_not_ascii' | 'name_invalid' | 'persons_full'

// ─────────────────────────────────────────────────────────── eligibility

/**
 * The plan's eligibility table, in order. A link that names a contact keeps
 * it in step whatever the client's status: a linked client turned back into
 * a lead is still that contact. A `failed` link with a contact is an update
 * that Xero refused, tried again on the next change; one without is a create
 * tried again.
 */
export function eligibility(
  input: ContactInput | null,
  link: LinkLike | null,
): Eligibility {
  if (input === null) return 'gone'
  const { client } = input
  if (client.deletedAt !== undefined) return 'binned'
  if (client.archivedAt !== undefined) return 'archived'
  if (input.undoing === true) return 'undoing'
  if (link?.state === 'archived_in_xero' || link?.state === 'gdpr') {
    return 'stopped'
  }
  // Ahead of `update`: a shared link names a contact — its holder's.
  if (link?.state === 'shared') return 'shared'
  if (link?.state === 'needs_review') return 'review'
  if (
    link?.xeroContactId &&
    (link.state === 'linked' || link.state === 'failed')
  ) {
    return 'update'
  }
  if (client.status === 'lead') return 'lead'
  return 'create'
}

// ──────────────────────────────────────────────────────────── text rules

/** Control characters become spaces, invisible formatting characters (zero
 * widths, direction marks) go, spaces collapse. */
function clean(text: string | undefined): string {
  return (text ?? '')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** At most `max` UTF-16 units (Xero's lengths are .NET's), never cutting a
 * character in half. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end).trimEnd()
}

/**
 * A client's name as a contact's Name: trimmed, spaces collapsed, control
 * characters and `< >` taken out (Xero refuses markup), and at most 230
 * characters — leaving room for a clash suffix within Xero's 255.
 */
export function sanitiseName(name: string): string {
  return cut(clean(name.replace(/[<>]/g, ' ')), NAME_ROOM)
}

/**
 * First and last names, split at the last word: "Mary Jane Watson" is Mary
 * Jane / Watson; a single word is a first name alone. Whatever the name, no
 * guess is made about titles or particles ("van der Berg"): the person can
 * correct Xero's copy, and the Name is the one that prints.
 */
export function splitPersonName(name: string): {
  first: string
  last?: string
} {
  const words = clean(name)
    .split(' ')
    .filter((word) => word !== '')
  if (words.length === 0) return { first: '' }
  if (words.length === 1) return { first: words[0] }
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] }
}

/** A suburb as a suffix shows it: one written all in capitals or all in
 * lower case (as address lookups and imports often give it) in title case,
 * otherwise as typed. */
function placeName(suburb: string): string {
  const text = cut(clean(suburb.replace(/[<>()]/g, ' ')), SUFFIX_PLACE_MAX)
  if (text !== text.toUpperCase() && text !== text.toLowerCase()) return text
  return text
    .toLowerCase()
    .replace(
      /(^|[\s'’-])(\p{L})/gu,
      (_all, before: string, letter: string) =>
        `${before}${letter.toUpperCase()}`,
    )
}

/**
 * The names to try, in order, when a client's Name is already another
 * contact's in Xero (decision 4): "John Smith (Nightcliff)" from the oldest
 * live site's suburb, then "John Smith #1916" from the client number. A
 * suffix with nothing to go on is skipped, and each fits Xero's 255 by
 * cutting the name, never the suffix.
 */
export function suffixNames(
  name: string,
  suburb?: string,
  clientNumber?: number,
): Array<string> {
  const base = sanitiseName(name)
  const suffixes: Array<string> = []
  const place = placeName(suburb ?? '')
  if (place !== '') suffixes.push(` (${place})`)
  if (clientNumber !== undefined && Number.isSafeInteger(clientNumber)) {
    suffixes.push(` #${clientNumber}`)
  }
  const names = suffixes.map(
    (suffix) => `${cut(base, XERO_NAME_MAX - suffix.length)}${suffix}`,
  )
  return [...new Set(names)].filter((candidate) => candidate !== base)
}

/** Any letter outside ASCII, which Xero refuses in an email address. */
function hasNonAscii(text: string): boolean {
  return /[^\p{ASCII}]/u.test(text)
}

// ─────────────────────────────────────────────────────────── field rules

/** The email the contact gets: the client's own; a business with none uses
 * its contact person's. Null when it cannot be sent (non-ASCII). */
function emailFor(input: ContactInput): string | null {
  const own = clean(input.client.email)
  const email =
    own !== '' || input.client.kind !== 'business'
      ? own
      : clean(input.primary?.email)
  if (hasNonAscii(email)) return null
  return cut(email, LIMITS.email)
}

/**
 * The client's phone in the slot Xero keeps it in (lib/phone.ts
 * `checkPhone`): a mobile in MOBILE, written the usual way; a landline in
 * DEFAULT with its two-digit area code apart — and a local number missing
 * its area code given the business's own state's, as the form's one-tap fix
 * would (a printed invoice is read from anywhere); anything else in DEFAULT
 * as typed.
 */
function phoneSlots(
  raw: string | undefined,
  businessState: string | undefined,
): { phoneDefault?: PhoneValue; phoneMobile?: PhoneValue } {
  const text = clean(raw)
  if (text === '') return {}
  const check = checkPhone(text, { businessState })
  const written = check.tidy ?? text
  const slot = (areaCode: string, number: string): PhoneValue => ({
    areaCode: cut(areaCode, LIMITS.phoneAreaCode),
    number: cut(number, LIMITS.phoneNumber),
  })
  if (check.kind === 'mobile') return { phoneMobile: slot('', written) }
  if (check.kind === 'landline' || check.kind === 'local') {
    const split = /^(0\d) (.+)$/.exec(written)
    if (split) return { phoneDefault: slot(split[1], split[2]) }
  }
  return { phoneDefault: slot('', text) }
}

function address(parts: {
  addressLine?: string
  suburb?: string
  state?: string
  postcode?: string
}): AddressValue | '' {
  const line1 = cut(clean(parts.addressLine), LIMITS.addressLine)
  const city = cut(clean(parts.suburb), LIMITS.city)
  // As the client sheet and the reports have it (lib/reportContext.ts): an
  // address is a street or a suburb. A State on its own, which an older
  // edit form saved, is not one.
  if (line1 === '' && city === '') return ''
  return {
    line1,
    city,
    region: cut(clean(parts.state), LIMITS.region),
    postcode: cut(clean(parts.postcode), LIMITS.postcode),
    country: COUNTRY,
  }
}

function personName(raw: string | undefined): PersonName | '' {
  const { first, last } = splitPersonName(sanitiseName(raw ?? ''))
  if (first === '' && !last) return ''
  return {
    first: cut(first, LIMITS.personName),
    last: cut(last ?? '', LIMITS.personName),
  }
}

/** A business's other contacts as Xero's people, every one of them (named
 * only), oldest first. An email Xero would refuse is left off that person. */
function personEntries(others: ContactInput['others']): Array<PersonEntry> {
  return others.flatMap((other) => {
    const name = personName(other.name)
    if (name === '') return []
    const email = clean(other.email)
    return [
      {
        ...name,
        email: hasNonAscii(email) ? '' : cut(email, LIMITS.email),
      },
    ]
  })
}

/**
 * The fields PestM8 fills in on this client's contact, in canonical shape
 * (absent: not PestM8's; blank: PestM8's, and empty). The plan's mapper
 * table, with §11b's address rules:
 *
 * | Field | From |
 * |---|---|
 * | name | `sanitiseName(client.name)` |
 * | person | a person's own name; a business's contact person; split at the last word |
 * | email | the client's; a business with none, its contact person's. Not ASCII: not PestM8's (`email_not_ascii`) |
 * | phoneMobile / phoneDefault | `client.phone` in the one slot `checkPhone` says; the other blank |
 * | pobox, street (business) | the head office when it has a street or suburb, else blank — never a site, which for a business is often a rental |
 * | street (person) | the oldest live site |
 * | pobox (person) | that site, only when creating or while Xero's PO box is blank (`xeroPoboxBlank`): it is what invoices print, and the bookkeeper may know better |
 * | taxNumber | a business's ABN, `formatAbn` |
 * | accountNumber | `String(clientNumber)`; `diff` sends it on an update only into a blank |
 * | persons | a business's other named contacts; `diff` sends them on an update only to a contact PestM8 created |
 *
 * Never sent: ContactNumber, bank details, IsCustomer, groups, status.
 *
 * Release 2's rule for AccountNumber stands on top of this: the number is
 * not written into a linked contact while another ACTIVE contact in the
 * organisation already holds it (Xero refuses it). The sync checks that —
 * it needs Xero — and deletes `accountNumber` from these fields when so.
 */
export function ownedFields(
  input: ContactInput,
  opts: { creating: boolean; xeroPoboxBlank: boolean },
): Fields {
  const { client } = input
  const business = client.kind === 'business'
  const fields: Fields = {
    name: sanitiseName(client.name),
    person: personName(business ? input.primary?.name : client.name),
  }

  const email = emailFor(input)
  if (email !== null) fields.email = email

  const phones = phoneSlots(client.phone, input.businessState)
  fields.phoneDefault = phones.phoneDefault ?? ''
  fields.phoneMobile = phones.phoneMobile ?? ''

  if (business) {
    const office = address(client)
    fields.pobox = office
    fields.street = office
    fields.taxNumber = client.abn
      ? cut(formatAbn(client.abn), LIMITS.taxNumber)
      : ''
  } else {
    const site = input.oldestSite ? address(input.oldestSite) : ''
    fields.street = site
    if (opts.creating || opts.xeroPoboxBlank) fields.pobox = site
  }

  if (client.clientNumber !== undefined) {
    fields.accountNumber = cut(
      String(client.clientNumber),
      LIMITS.accountNumber,
    )
  }
  if (business) fields.persons = personEntries(input.others)
  return fields
}

/**
 * What about this client keeps its contact from being exactly what PestM8
 * has, before anything is sent: an email Xero would refuse (left out), a
 * name with nothing left once sanitised (Xero will refuse the contact).
 */
export function fieldProblems(input: ContactInput): Array<MapperProblem> {
  const problems: Array<MapperProblem> = []
  if (sanitiseName(input.client.name) === '') problems.push('name_invalid')
  if (emailFor(input) === null) problems.push('email_not_ascii')
  return problems
}

/**
 * What about a body about to be sent leaves PestM8's people out: more than
 * five to create with, or more than fit beside the people Xero already has
 * (`toXeroUpdate` keeps Xero's and drops PestM8's newest).
 */
export function payloadProblems(
  send: Fields,
  xeroCurrent: XeroContactFull | null,
): Array<MapperProblem> {
  const people = personsOf(send.persons)
  if (people.length === 0) return []
  const dropped =
    xeroCurrent === null
      ? people.length - MAX_CONTACT_PERSONS
      : mergePersons(xeroCurrent.ContactPersons, people).dropped
  return dropped > 0 ? ['persons_full'] : []
}

// ──────────────────────────────────────────────────────────────── hashing

/** Whether a field holds nothing: undefined, null, a blank string, or a
 * list or object of nothing but blanks. */
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.every(isBlank)
  if (typeof value === 'object') return Object.values(value).every(isBlank)
  return false
}

/** JSON with every object's keys sorted and its blank members left out, so
 * a field hashes the same whichever side built it and in whatever order. */
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return '""'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const members = Object.keys(record)
      .filter((key) => !isBlank(record[key]))
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value)
}

/** cyrb53 (bryc, public domain): a fast 53-bit hash, plenty to tell one
 * value of one field of one contact from the next. Not for secrets. */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * One field's value as a short string, for `sent` and `seen`. Canonical
 * JSON, so key order never matters; every blank — '', undefined, [], an
 * address of empty strings — hashes alike, so "PestM8 has none" and "Xero
 * has none" agree.
 */
export function fieldHash(value: unknown): string {
  return cyrb53(isBlank(value) ? '' : canonicalJson(value))
}

/** `fieldHash` of every field present. */
export function fieldHashes(fields: Fields): FieldHashes {
  const hashes: FieldHashes = {}
  for (const key of FIELD_KEYS) {
    if (key in fields) hashes[key] = fieldHash(fields[key])
  }
  return hashes
}

// ─────────────────────────────────────────────────────── what Xero holds

function slotOf<T>(
  list: ReadonlyArray<T>,
  typeOf: (item: T) => string,
  type: string,
): T | undefined {
  return list.find((item) => typeOf(item).toUpperCase() === type)
}

function xeroPhone(phone: XeroContactPhone | undefined): PhoneValue | '' {
  const number = clean(phone?.PhoneNumber)
  if (number === '') return ''
  return { areaCode: clean(phone?.PhoneAreaCode), number }
}

function xeroAddress(held: XeroContactAddress | undefined): AddressValue | '' {
  if (!held) return ''
  const value: AddressValue = {
    line1: clean(held.AddressLine1),
    line2: clean(held.AddressLine2),
    line3: clean(held.AddressLine3),
    line4: clean(held.AddressLine4),
    city: clean(held.City),
    region: clean(held.Region),
    postcode: clean(held.PostalCode),
    country: clean(held.Country),
  }
  // A country on its own is not an address: Xero fills one in for an
  // organisation in Australia whether or not there is anything else.
  const { country: _country, ...place } = value
  return isBlank(place) ? '' : value
}

function xeroPersonEntry(person: XeroContactPerson): PersonEntry {
  return {
    first: clean(person.FirstName),
    last: clean(person.LastName),
    email: clean(person.EmailAddress),
  }
}

/**
 * What Xero holds for this contact, every field, in the same canonical
 * shapes as `ownedFields` (blank as '' or []): what `diff` compares with,
 * and what `seen` is hashed from. Xero's ContactPersons are all of them,
 * the bookkeeper's included.
 */
export function fieldsFromXero(contact: XeroContactFull): Fields {
  const first = clean(contact.FirstName)
  const last = clean(contact.LastName)
  const phoneType = (phone: XeroContactPhone) => phone.PhoneType
  const addressType = (held: XeroContactAddress) => held.AddressType
  return {
    name: clean(contact.Name),
    person: first === '' && last === '' ? '' : { first, last },
    email: clean(contact.EmailAddress),
    phoneDefault: xeroPhone(slotOf(contact.Phones, phoneType, 'DEFAULT')),
    phoneMobile: xeroPhone(slotOf(contact.Phones, phoneType, 'MOBILE')),
    pobox: xeroAddress(slotOf(contact.Addresses, addressType, 'POBOX')),
    street: xeroAddress(slotOf(contact.Addresses, addressType, 'STREET')),
    taxNumber: clean(contact.TaxNumber),
    accountNumber: clean(contact.AccountNumber),
    persons: contact.ContactPersons.map(xeroPersonEntry).filter(
      (person) => !isBlank(person),
    ),
  }
}

// ─────────────────────────────────────────────────────────────────── diff

/** Whether PestM8 writes people onto this contact on an update. */
function personsOnUpdate(link: LinkHashes | null): boolean {
  return CONTACT_PERSONS_ON_MATCHED || link?.how === 'created'
}

/**
 * Which fields to send, and which PestM8 changed but Xero holds something
 * else in (`different`, left alone).
 *
 * Creating (`xeroCurrent` null): every field PestM8 owns that has
 * something in it. Nothing a link may hold from before (a failed try) is
 * consulted: a new contact is made whole.
 *
 * Updating, field by field, of those PestM8 owns:
 * - AccountNumber fills a blank and nothing else (the bookkeeper's numbering
 *   wins), and people go only to a contact PestM8 created
 *   (`CONTACT_PERSONS_ON_MATCHED`).
 * - Nothing on record as sent (`sent[F]` absent: a contact Release 2
 *   matched, or a field newly PestM8's): fill a blank in Xero, else leave it
 *   — linking never overwrites what Xero holds. Never `different`.
 * - PestM8 has not changed it since (`hash(ours) === sent[F]`): nothing.
 * - Xero already holds PestM8's value: nothing to send.
 * - PestM8 cleared it: never sent while `XERO_CLEARS_WITH_EMPTY` is off —
 *   `different` if Xero still has something.
 * - Xero holds nothing, or still what it held after PestM8 last sent
 *   (`seen[F]`): send.
 * - Otherwise Xero was changed there since: `different`.
 *
 * Nothing to send means no call to Xero at all.
 */
export function diff(
  ours: Fields,
  link: LinkHashes | null,
  xeroCurrent: Fields | null,
): { send: Fields; different: Array<FieldKey> } {
  const send: Fields = {}
  const different: Array<FieldKey> = []

  for (const key of FIELD_KEYS) {
    if (!(key in ours)) continue
    const mine = ours[key]
    const mineBlank = isBlank(mine)

    if (xeroCurrent === null) {
      if (!mineBlank) send[key] = mine
      continue
    }
    if (key === 'persons' && !personsOnUpdate(link)) continue

    const theirs = xeroCurrent[key]
    const theirsBlank = isBlank(theirs)
    const fill = theirsBlank && !mineBlank
    const sent = link?.sent?.[key]

    if (key === 'accountNumber' || sent === undefined) {
      if (fill) send[key] = mine
      continue
    }
    const mineHash = fieldHash(mine)
    if (mineHash === sent) continue
    const theirsHash = fieldHash(theirs)
    if (mineHash === theirsHash) continue
    if (mineBlank && !XERO_CLEARS_WITH_EMPTY) {
      if (!theirsBlank) different.push(key)
      continue
    }
    if (theirsBlank || theirsHash === link?.seen?.[key]) send[key] = mine
    else different.push(key)
  }
  return { send, different }
}

/**
 * A link's `sent` and `seen` once a pass over the contact is done — a
 * create, an update, or a look that sent nothing — for the sync to store
 * (convex/xeroSync.ts `recordResults`). `xeroAfter` is
 * `fieldsFromXero` of the contact as Xero answered the write (its normalised
 * forms), or as it was read when nothing was written. For a contact just
 * created, pass `link` null: its record starts afresh. Not after a write Xero
 * refused: nothing changed there, so the record stays as it was.
 *
 * For each field PestM8 owns:
 * - sent now: `sent` = PestM8's value, `seen` = Xero's answer;
 * - `different`: both kept, so it stays different until Xero agrees or the
 *   holder overwrites (`seen` moved to Xero's value then);
 * - Xero already holding PestM8's value: settled as it stands;
 * - nothing on record as sent: PestM8's value is taken as sent, and Xero's
 *   as seen — unless something was seen there before (a resync that forgot
 *   what was sent, `xeroSync.resyncAll`'s `force`) and Xero holds something
 *   else now, when that is kept: the bookkeeper changed it, and a later
 *   change in PestM8 is Different, not sent over it. So a contact Release 2
 *   matched has its baselines from the first look, and a later change in
 *   PestM8 is sent;
 * - otherwise kept: PestM8's value is not in Xero and is still to go (a
 *   clear waiting on `XERO_CLEARS_WITH_EMPTY`, a number Xero keeps).
 *
 * `seen` is never moved to a value Xero was changed to behind PestM8's
 * back: that would take the bookkeeper's edit for PestM8's and overwrite it
 * with the next change.
 */
export function nextHashes(
  ours: Fields,
  link: LinkHashes | null,
  result: { send: Fields; different: ReadonlyArray<FieldKey> },
  xeroAfter: Fields,
): { sent: FieldHashes; seen: FieldHashes } {
  const sent: FieldHashes = { ...link?.sent }
  const seen: FieldHashes = { ...link?.seen }
  for (const key of FIELD_KEYS) {
    if (!(key in ours)) continue
    if (result.different.includes(key)) continue
    const mineHash = fieldHash(ours[key])
    const theirsHash = fieldHash(xeroAfter[key])
    if (key in result.send || mineHash === theirsHash) {
      sent[key] = mineHash
      seen[key] = theirsHash
    } else if (!(key in sent)) {
      sent[key] = mineHash
      if (!(key in seen)) seen[key] = theirsHash
    }
  }
  return { sent, seen }
}

// ──────────────────────────────────────────────────────────────── bodies

function textField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function personNameOf(value: unknown): PersonName | null {
  if (isBlank(value) || typeof value !== 'object' || value === null) {
    return null
  }
  const name = value as Partial<PersonName>
  return { first: textField(name.first), last: textField(name.last) }
}

function phoneOf(value: unknown): PhoneValue | null {
  if (isBlank(value) || typeof value !== 'object' || value === null) {
    return null
  }
  const phone = value as Partial<PhoneValue>
  return {
    areaCode: textField(phone.areaCode),
    number: textField(phone.number),
  }
}

function addressOf(value: unknown): AddressValue | null {
  if (isBlank(value) || typeof value !== 'object' || value === null) {
    return null
  }
  const held = value as Partial<AddressValue>
  return {
    line1: textField(held.line1),
    city: textField(held.city),
    region: textField(held.region),
    postcode: textField(held.postcode),
    country: textField(held.country),
  }
}

function personsOf(value: unknown): Array<PersonEntry> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) => {
    if (isBlank(entry) || typeof entry !== 'object' || entry === null) {
      return []
    }
    const person = entry as Partial<PersonEntry>
    return [
      {
        first: textField(person.first),
        last: textField(person.last),
        email: textField(person.email),
      },
    ]
  })
}

/** Keeps only what has something in it — unless blanks clear in Xero and
 * this is an update, when '' is how a value is cleared. */
function present(
  body: Record<string, unknown>,
  values: Record<string, string>,
  clears: boolean,
): void {
  for (const [field, value] of Object.entries(values)) {
    if (value.trim() !== '' || clears) body[field] = value
  }
}

function phoneBody(
  type: 'DEFAULT' | 'MOBILE',
  phone: PhoneValue,
  clears: boolean,
): XeroContactPhone {
  const body: Record<string, unknown> = { PhoneType: type }
  present(
    body,
    { PhoneNumber: phone.number, PhoneAreaCode: phone.areaCode },
    clears,
  )
  return body as XeroContactPhone
}

function addressBody(
  type: 'POBOX' | 'STREET',
  held: AddressValue,
  clears: boolean,
): XeroContactAddress {
  const body: Record<string, unknown> = { AddressType: type }
  present(
    body,
    {
      AddressLine1: held.line1,
      City: held.city,
      Region: held.region,
      PostalCode: held.postcode,
      Country: held.country,
    },
    clears,
  )
  return body as XeroContactAddress
}

function personBody(person: PersonEntry): XeroContactPerson {
  const body: Record<string, unknown> = {}
  present(
    body,
    {
      FirstName: person.first,
      LastName: person.last,
      EmailAddress: person.email,
    },
    false,
  )
  body.IncludeInEmails = false
  return body
}

/** The plain fields of a body: Name, FirstName / LastName, EmailAddress,
 * TaxNumber, AccountNumber — whichever `fields` has. */
function scalarBody(fields: Fields, clears: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const strings: Record<string, string> = {}
  if ('name' in fields) strings.Name = textField(fields.name)
  if ('email' in fields) strings.EmailAddress = textField(fields.email)
  if ('taxNumber' in fields) strings.TaxNumber = textField(fields.taxNumber)
  if ('accountNumber' in fields) {
    strings.AccountNumber = textField(fields.accountNumber)
  }
  if ('person' in fields) {
    const name = personNameOf(fields.person)
    strings.FirstName = name?.first ?? ''
    strings.LastName = name?.last ?? ''
  }
  present(body, strings, clears)
  return body
}

/**
 * The body that creates a contact (one element of a `PUT /Contacts`): its
 * Name — the client's, or the suffixed one a clash called for — and every
 * field PestM8 owns that has something in it. People at most five, oldest
 * first (`payloadProblems` says when some did not fit), none of them on
 * the contact's emails.
 */
export function toXeroCreate(name: string, ours: Fields): object {
  const { name: _ours, ...rest } = ours
  const body: Record<string, unknown> = {
    Name: name,
    ...scalarBody(rest, false),
  }

  const phones: Array<XeroContactPhone> = []
  const fixed = phoneOf(ours.phoneDefault)
  if (fixed) phones.push(phoneBody('DEFAULT', fixed, false))
  const mobile = phoneOf(ours.phoneMobile)
  if (mobile) phones.push(phoneBody('MOBILE', mobile, false))
  if (phones.length > 0) body.Phones = phones

  const addresses: Array<XeroContactAddress> = []
  const pobox = addressOf(ours.pobox)
  if (pobox) addresses.push(addressBody('POBOX', pobox, false))
  const street = addressOf(ours.street)
  if (street) addresses.push(addressBody('STREET', street, false))
  if (addresses.length > 0) body.Addresses = addresses

  const people = personsOf(ours.persons).slice(0, MAX_CONTACT_PERSONS)
  if (people.length > 0) body.ContactPersons = people.map(personBody)
  return body
}

/** A list of Xero's, as Xero holds it, with PestM8's changed entries put in
 * place of the ones of their type and any type Xero lacks added at the
 * end. Nothing of Xero's is left out. */
function mergeTyped<T>(
  held: ReadonlyArray<T>,
  typeOf: (item: T) => string,
  mine: Map<string, T>,
): Array<T> {
  const placed = new Set<string>()
  const merged = held.map((item) => {
    const type = typeOf(item).toUpperCase()
    const replacement = mine.get(type)
    if (replacement === undefined || placed.has(type)) return item
    placed.add(type)
    return replacement
  })
  for (const [type, replacement] of mine) {
    if (!placed.has(type)) merged.push(replacement)
  }
  return merged
}

/** A name as two people's are compared: spaces collapsed, any case. */
function personKey(first: string | undefined, last: string | undefined) {
  return clean(`${first ?? ''} ${last ?? ''}`).toLowerCase()
}

/**
 * Xero's people with PestM8's merged in: each of PestM8's that Xero already
 * has — the same email (any case), else the same name — updated where it
 * is, keeping whether it is on the contact's emails; the rest added after,
 * not on the emails. Xero's own people are never dropped; PestM8's newest
 * are, past five.
 */
function mergePersons(
  held: ReadonlyArray<XeroContactPerson>,
  mine: ReadonlyArray<PersonEntry>,
): { persons: Array<XeroContactPerson>; dropped: number } {
  const persons = held.map((person) => ({ ...person }))
  const matched = new Set<number>()
  const added: Array<XeroContactPerson> = []

  for (const person of mine) {
    const email = person.email.toLowerCase()
    const name = personKey(person.first, person.last)
    const byEmail = (other: XeroContactPerson) =>
      email !== '' && clean(other.EmailAddress).toLowerCase() === email
    const byName = (other: XeroContactPerson) =>
      name !== '' && personKey(other.FirstName, other.LastName) === name
    const free = (index: number) => !matched.has(index)
    let at = persons.findIndex((other, i) => free(i) && byEmail(other))
    if (at === -1)
      at = persons.findIndex((other, i) => free(i) && byName(other))

    if (at === -1) {
      added.push(personBody(person))
      continue
    }
    matched.add(at)
    const updated: Record<string, unknown> = { ...persons[at] }
    present(
      updated,
      {
        FirstName: person.first,
        LastName: person.last,
        EmailAddress: person.email,
      },
      XERO_CLEARS_WITH_EMPTY,
    )
    persons[at] = updated
  }

  const room = Math.max(0, MAX_CONTACT_PERSONS - persons.length)
  return {
    persons: [...persons, ...added.slice(0, room)],
    dropped: Math.max(0, added.length - room),
  }
}

/** What a slot is cleared with, once "" is proven to clear. */
const blankPhone: PhoneValue = { areaCode: '', number: '' }
const blankAddress: AddressValue = {
  line1: '',
  city: '',
  region: '',
  postcode: '',
  country: '',
}

/**
 * The body that updates a contact (one element of a `POST /Contacts`): its
 * ContactID and the fields in `send` (from `diff`), over `xeroCurrent` as
 * just read.
 *
 * Merge-safe: Phones, Addresses and ContactPersons go as Xero's whole list
 * with PestM8's changed entries in place — a new mobile keeps the DEFAULT,
 * DDI and FAX lines; a new street address keeps the PO box, and the
 * address's own AttentionTo; PestM8's people join the bookkeeper's — and
 * only when one of them is being sent. Blanks are left out while
 * `XERO_CLEARS_WITH_EMPTY` is off.
 */
export function toXeroUpdate(
  contactId: string,
  send: Fields,
  xeroCurrent: XeroContactFull,
): object {
  const clears = XERO_CLEARS_WITH_EMPTY
  const body: Record<string, unknown> = {
    ContactID: contactId,
    ...scalarBody(send, clears),
  }

  const phones = new Map<string, XeroContactPhone>()
  for (const [key, type] of [
    ['phoneDefault', 'DEFAULT'],
    ['phoneMobile', 'MOBILE'],
  ] as const) {
    if (!(key in send)) continue
    const phone = phoneOf(send[key])
    if (phone) phones.set(type, phoneBody(type, phone, clears))
    else if (clears) phones.set(type, phoneBody(type, blankPhone, true))
  }
  if (phones.size > 0) {
    body.Phones = mergeTyped(
      xeroCurrent.Phones,
      (phone) => phone.PhoneType,
      phones,
    )
  }

  const addresses = new Map<string, XeroContactAddress>()
  for (const [key, type] of [
    ['pobox', 'POBOX'],
    ['street', 'STREET'],
  ] as const) {
    if (!(key in send)) continue
    const held = addressOf(send[key])
    const entry = held
      ? addressBody(type, held, clears)
      : clears
        ? addressBody(type, blankAddress, true)
        : null
    if (!entry) continue
    // Who it is for at that address is the bookkeeper's, never PestM8's:
    // kept, whether Xero replaces the entry or merges into it.
    const attention = slotOf(
      xeroCurrent.Addresses,
      (current) => current.AddressType,
      type,
    )?.AttentionTo
    if (attention !== undefined && attention.trim() !== '') {
      entry.AttentionTo = attention
    }
    addresses.set(type, entry)
  }
  if (addresses.size > 0) {
    body.Addresses = mergeTyped(
      xeroCurrent.Addresses,
      (held) => held.AddressType,
      addresses,
    )
  }

  if ('persons' in send) {
    const people = personsOf(send.persons)
    if (people.length > 0) {
      body.ContactPersons = mergePersons(
        xeroCurrent.ContactPersons,
        people,
      ).persons
    }
  }
  return body
}

/** Xero's id for "no contact". */
const NO_CONTACT_ID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/

/**
 * The body of a `POST /Contacts`: updates only. Throws if any element does
 * not name a real ContactID, or two name the same one — a POST without one
 * is "create, or update whoever has this Name", which is how a stranger's
 * contact gets this client's details.
 */
export function buildUpdateBatch(items: Array<object>): {
  Contacts: Array<object>
} {
  const ids = new Set<string>()
  for (const item of items) {
    const id = (item as { ContactID?: unknown }).ContactID
    if (typeof id !== 'string' || id.trim() === '' || NO_CONTACT_ID.test(id)) {
      throw new Error('An update to Xero needs every contact’s ContactID')
    }
    if (ids.has(id)) {
      throw new Error('An update to Xero names the same contact twice')
    }
    ids.add(id)
  }
  return { Contacts: items }
}
