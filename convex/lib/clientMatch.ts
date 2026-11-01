import {
  addressNear,
  emailKeys,
  isPlaceholderName,
  nameKey,
  nameNear,
  nameWords,
  phoneKeys,
  phoneKind,
  siteKey,
  streetKey,
} from './contactKeys'
import type { Id } from '../_generated/dataModel'

/**
 * Is the caller already a client? Pure: the client book in (the directory's
 * rows, as the phone keeps them or as the server reads them), candidates
 * out. The phone runs it as New Job is filled in; the server runs it again,
 * on the same rows with the same code, when the booking saves.
 *
 * The domain trap it is built around: real-estate agencies, strata managers
 * and property managers book for many owners and tenants with one phone and
 * email; one client has many sites; families share a mobile. So a matching
 * number or email is evidence, not identity, and everything here is a
 * suggestion someone confirms. The one automatic step (`autoRule`) is the
 * server's, for a booking sent later, on the strictest evidence.
 *
 * Who holds a number or an email is counted from the client's own fields and
 * its contact people only (a business client's: a person's are hidden in the
 * app, and not sent). Never from site contacts, who are tenants and
 * caretakers: their numbers are looked up for one suggestion only, and never
 * counted. Never the business's or the team's own numbers and emails, which
 * offices put on clients who have none: the caller passes them in (`ours`,
 * from `oursFor`), and a field holding one is left out.
 *
 * Deterministic: the same rows, in any order, give the same answer.
 */

/** Match rows shown at once; any more are "and 2 more", with Show them. */
export const MATCH_ROWS_MAX = 3

/** A name on more clients than this is not evidence: three John Smiths. */
const NAME_HOLDERS_MAX = 2

/** The two fields a key comes from. */
export type KeyField = 'phone' | 'email'

/** A client, as the directory sends it: only what matching reads. */
export type MatchClient = {
  _id: Id<'clients'>
  name: string
  kind: 'person' | 'business'
  phone?: string
  email?: string
  status?: 'active' | 'lead' | 'inactive'
  archivedAt?: number
}

export type MatchSite = {
  _id: Id<'properties'>
  clientId: Id<'clients'>
  addressLine: string
  suburb: string
  postcode: string
  siteContactName?: string
  siteContactPhone?: string
}

export type MatchContact = {
  _id: Id<'clientContacts'>
  clientId: Id<'clients'>
  name: string
  phone?: string
  email?: string
}

export type MatchDirectory = {
  clients: ReadonlyArray<MatchClient>
  sites: ReadonlyArray<MatchSite>
  /** Business clients' contact people. Absent from a copy kept before they
   * were sent, or for someone not given them. */
  contacts?: ReadonlyArray<MatchContact>
  /**
   * Whether the copy holds everything matching reads: emails and contact
   * people. Defaults to whether `contacts` is there. Without it, an email is
   * no evidence, and nothing is more than Likely: the copy can't say who
   * else holds a number.
   */
  complete?: boolean
}

/**
 * The business's own numbers and emails, and its team's, as they are
 * stored: what an office puts on a client who has none, so never evidence
 * of who a caller is. A client's or a contact person's field holding one is
 * left out of the index whole (`oursFields`).
 *
 * Passed in by whoever builds the index, never sent in the directory. The
 * directory reads no business row and no team on purpose: every booking,
 * Recurring Job visit and numbered report patches the business row (its job
 * and report numbers), so reading it would re-run every member's whole
 * directory on each. The phone already holds what it needs (`oursFor`); the
 * server's check reads the same for the person saving (lib/ours.ts).
 */
export type OursSource = {
  phones: ReadonlyArray<string>
  emails: ReadonlyArray<string>
}

/** None: for a book with no business or team numbers to leave out. */
export const NO_OURS: OursSource = { phones: [], emails: [] }

/** A phone and an email, as a roster row or the person's own row holds
 * them. */
export type OwnDetails = {
  phone?: string | null
  email?: string | null
}

/**
 * What someone may know of the business's and the team's own numbers, for
 * `oursFor`. On the phone: the business's from `businesses.getBySlug`, the
 * person's own phone and sign-in email, and the roster
 * (`memberships.listForBusiness`) for someone who manages the team.
 */
export type OursReader = {
  /** The business's own phone and email, which every member reads, and its
   * report copy address where it is known. */
  business?: (OwnDetails & { reportCopyEmail?: string | null }) | null
  /** Their own phone and sign-in email. */
  self?: OwnDetails | null
  /** Whether they may see the team's numbers: `team.manage`, the test the
   * roster gives every member's phone and email by. */
  seesTeam: boolean
  /** The roster. Read only when `seesTeam`, and only its active members: a
   * former employee may well be a customer now. */
  team?: ReadonlyArray<
    OwnDetails & { status: 'active' | 'invited' | 'removed' }
  > | null
}

/**
 * The numbers and emails to leave out of the index, for this reader. The
 * business's own, which every member reads, and their own; every active
 * member's too for someone who manages the team, and for nobody else, even
 * when a roster with them is passed.
 *
 * Leaving another member's number out on a subcontractor's phone would tell
 * them it is a team member's, the very thing the roster keeps from them; and
 * since any member may save a client with any number, it would let them
 * test a number or an email against the team's. So on their phone another
 * member's number on a client counts as the client's. The server's own
 * check, when a booking saves, works it out for the person saving in just
 * this way (lib/ours.ts `oursOfCaller`), or whether it refused, or moved a
 * booking onto a client, would say what the phone keeps quiet.
 */
export function oursFor(reader: OursReader): OursSource {
  const phones: Array<string> = []
  const emails: Array<string> = []
  const take = (row: OwnDetails | null | undefined) => {
    if (row?.phone) phones.push(row.phone)
    if (row?.email) emails.push(row.email)
  }
  take(reader.business)
  if (reader.business?.reportCopyEmail) {
    emails.push(reader.business.reportCopyEmail)
  }
  take(reader.self)
  if (reader.seesTeam) {
    for (const member of reader.team ?? []) {
      if (member.status === 'active') take(member)
    }
  }
  return { phones, emails }
}

/** `OursSource` as match keys, under the index's area code. */
export type OursKeys = {
  phones: ReadonlySet<string>
  emails: ReadonlySet<string>
}

export function oursKeys(ours: OursSource, areaCode: string): OursKeys {
  return {
    phones: new Set(ours.phones.flatMap((raw) => phoneKeys(raw, areaCode))),
    emails: new Set(ours.emails.flatMap((raw) => emailKeys(raw))),
  }
}

/**
 * Which of a row's fields hold one of `ours`, or undefined when none does.
 * A field holding several numbers is marked when any of them is ours, and
 * matching then leaves the whole field out: the wary way to be wrong.
 */
export function oursFields(
  ours: OursKeys,
  row: { phone?: string; email?: string },
  areaCode: string,
): Array<KeyField> | undefined {
  const fields: Array<KeyField> = []
  if (phoneKeys(row.phone, areaCode).some((key) => ours.phones.has(key))) {
    fields.push('phone')
  }
  if (emailKeys(row.email).some((key) => ours.emails.has(key))) {
    fields.push('email')
  }
  return fields.length > 0 ? fields : undefined
}

/**
 * What ties a client to what was typed.
 *
 * - `name` / `nameNear`: the name, exactly or similar; on a client held by
 *   at most two clients, and not a placeholder. For a number or email held
 *   through a contact person, that person's name counts.
 * - `site`: the typed address is one of the client's sites. A place.
 * - `mobile` / `email`: a typed mobile or email the client alone holds. A
 *   person.
 * - `landline`: a typed landline (or another country's number) the client
 *   alone holds. A household's or an office's: it needs the name.
 * - `street`: the street and postcode, in another suburb. A suggestion.
 * - `addressNear`: like one of the client's own sites ("12 Watle St"). A
 *   suggestion.
 * - `siteContact`: the typed number and name are a site contact's on one of
 *   the client's sites. Usually a tenant. A suggestion.
 * - `shared`: a typed number or email others hold too. Not evidence.
 */
export type Evidence =
  | 'name'
  | 'nameNear'
  | 'site'
  | 'mobile'
  | 'email'
  | 'landline'
  | 'street'
  | 'addressNear'
  | 'siteContact'
  | 'shared'

const EVIDENCE_ORDER: ReadonlyArray<Evidence> = [
  'name',
  'nameNear',
  'site',
  'mobile',
  'email',
  'landline',
  'street',
  'addressNear',
  'siteContact',
  'shared',
]

/**
 * - `same`: the name agrees, and so does a place or a person (site, mobile,
 *   email or landline). A landline is a household's or an office's: a
 *   person's name agreeing only as similar ("T Lee" for Tom Lee, maybe his
 *   wife Tina) leaves it Likely.
 * - `likely`: a place or a person without the name; or the name with a
 *   suggestion, a shared key or a landline it is only similar to; or a site
 *   contact.
 * - `maybe`: the name alone, and only when nothing stronger turned up.
 */
export type Tier = 'same' | 'likely' | 'maybe'

const TIER_RANK: Record<Tier, number> = { same: 0, likely: 1, maybe: 2 }

export type Candidate = {
  clientId: Id<'clients'>
  tier: Tier
  /** In a fixed order: name, nameNear, site, mobile, email, landline,
   * street, addressNear, siteContact, shared. */
  evidence: Array<Evidence>
  /** The client's sites at the typed address. */
  siteIds: Array<Id<'properties'>>
  /** The client's sites on the typed street, in another suburb. */
  streetSiteIds: Array<Id<'properties'>>
  /** The client's sites like the typed address. */
  nearSiteIds: Array<Id<'properties'>>
  /** The client's sites whose site contact has the typed number and name. */
  siteContactSiteIds: Array<Id<'properties'>>
  /** The contact person a number or email was matched through, whose name
   * agreed: "Sarah Lee is a contact at Ray White Bayswater". */
  contactId?: Id<'clientContacts'>
  /** Typed numbers and emails this client holds with others. */
  shared: Array<{ field: KeyField; key: string; holders: number }>
}

/**
 * Why a key is shared:
 * - `many`: two or more clients hold it.
 * - `line`: a 13, 1300 or 1800 number, a business's line.
 * - `business`: one business client holds it (on its own fields or a contact
 *   person's) and the name doesn't agree: an agency's.
 * - `landline`: one person client holds it as a landline, and the name
 *   doesn't agree: a household's or an office's.
 */
export type SharedReason = 'many' | 'line' | 'business' | 'landline'

/** Typed keys others hold, one row per set of holders: an agency's office
 * number and its rentals@ on the same six clients are one row. Never stops
 * a booking on its own. */
export type SharedRow = {
  keys: Array<{ field: KeyField; key: string; reason: SharedReason }>
  /** Business clients first, then by id. */
  clientIds: Array<Id<'clients'>>
  /** The one business client among them, for "New site for Ray White
   * Bayswater". */
  businessClientId?: Id<'clients'>
}

export type MatchResult = {
  /** One per client, Same first; Maybe only when there is nothing else.
   * Every one of them, however many are shown. */
  candidates: Array<Candidate>
  shared: Array<SharedRow>
  /** As the index's: whether the copy held everything matching reads. */
  complete: boolean
}

export type TypedAddress = {
  addressLine: string
  suburb: string
  postcode: string
}

/** A new client as typed. A site contact's number is not here on purpose:
 * it is a tenant's or a manager's, never the client's. */
export type TypedClient = {
  name?: string
  phone?: string
  email?: string
  site?: TypedAddress
}

/** Who holds a key: a client, through its own field or a contact person. */
type Holding = {
  clientId: Id<'clients'>
  contactId?: Id<'clientContacts'>
  /** The holder's name: the contact person's, or the client's. */
  name: string
}

export type MatchIndex = {
  readonly areaCode: string
  readonly complete: boolean
  readonly clients: ReadonlyMap<Id<'clients'>, MatchClient>
  readonly sitesOf: ReadonlyMap<Id<'clients'>, ReadonlyArray<MatchSite>>
  readonly siteKeys: ReadonlyMap<Id<'properties'>, string>
  readonly phones: ReadonlyMap<string, ReadonlyArray<Holding>>
  readonly emails: ReadonlyMap<string, ReadonlyArray<Holding>>
  readonly sites: ReadonlyMap<string, ReadonlyArray<MatchSite>>
  readonly streets: ReadonlyMap<string, ReadonlyArray<MatchSite>>
  readonly names: ReadonlyMap<string, ReadonlyArray<Id<'clients'>>>
  /** Site contacts' numbers: looked up for `siteContact`, never counted. */
  readonly siteContacts: ReadonlyMap<string, ReadonlyArray<MatchSite>>
}

function add<TKey, TValue>(
  map: Map<TKey, Array<TValue>>,
  key: TKey,
  value: TValue,
): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** What an index is built with, besides the book. */
export type MatchIndexOptions = {
  /** The business's (`areaCodeOf` its state), so a local number is matched
   * as it would dial. */
  areaCode: string
  /** The business's and the team's own numbers and emails to leave out
   * (`oursFor`, or the server's `oursOfCaller`). `NO_OURS` for none. */
  ours: OursSource
}

/**
 * Every key the book holds, to who holds it. A contact person counts only on
 * a business client in the book; a site only under a client in the book. A
 * client's or a contact person's field holding one of `ours` is left out.
 */
export function buildMatchIndex(
  directory: MatchDirectory,
  { areaCode, ours }: MatchIndexOptions,
): MatchIndex {
  const complete = directory.complete ?? directory.contacts !== undefined
  const own = oursKeys(ours, areaCode)
  const clients = new Map<Id<'clients'>, MatchClient>()
  const names = new Map<string, Array<Id<'clients'>>>()
  const phones = new Map<string, Array<Holding>>()
  const emails = new Map<string, Array<Holding>>()
  const sitesOf = new Map<Id<'clients'>, Array<MatchSite>>()
  const siteKeys = new Map<Id<'properties'>, string>()
  const sites = new Map<string, Array<MatchSite>>()
  const streets = new Map<string, Array<MatchSite>>()
  const siteContacts = new Map<string, Array<MatchSite>>()

  const hold = (row: { phone?: string; email?: string }, holding: Holding) => {
    const marked = oursFields(own, row, areaCode) ?? []
    if (!marked.includes('phone')) {
      for (const key of phoneKeys(row.phone, areaCode)) {
        add(phones, key, holding)
      }
    }
    if (complete && !marked.includes('email')) {
      for (const key of emailKeys(row.email)) add(emails, key, holding)
    }
  }

  for (const client of directory.clients) {
    if (clients.has(client._id)) continue
    clients.set(client._id, client)
    const key = nameKey(client.name)
    if (key !== '') add(names, key, client._id)
    hold(client, { clientId: client._id, name: client.name })
  }
  for (const contact of directory.contacts ?? []) {
    if (clients.get(contact.clientId)?.kind !== 'business') continue
    hold(contact, {
      clientId: contact.clientId,
      contactId: contact._id,
      name: contact.name,
    })
  }
  for (const site of directory.sites) {
    if (!clients.has(site.clientId) || siteKeys.has(site._id)) continue
    const key = siteKey(site)
    siteKeys.set(site._id, key)
    add(sitesOf, site.clientId, site)
    add(sites, key, site)
    add(streets, streetKey(site), site)
    for (const phone of phoneKeys(site.siteContactPhone, areaCode)) {
      add(siteContacts, phone, site)
    }
  }

  return {
    areaCode,
    complete,
    clients,
    sitesOf,
    siteKeys,
    phones,
    emails,
    sites,
    streets,
    names,
    siteContacts,
  }
}

/** The options an index was built with, as one string: two calls with the
 * same area code and the same numbers to leave out, in any order, agree. */
function optionsKey({ areaCode, ours }: MatchIndexOptions): string {
  const own = oursKeys(ours, areaCode)
  return [
    areaCode,
    [...own.phones].sort().join(' '),
    [...own.emails].sort().join(' '),
  ].join('|')
}

const indexes = new WeakMap<object, { key: string; index: MatchIndex }>()

/**
 * `buildMatchIndex`, once per directory answer: the same answer object with
 * the same options gives the same index, so a re-render costs nothing, and a
 * new answer (a push) or a change to `ours` (the roster's) builds a new one.
 */
export function matchIndexFor(
  directory: MatchDirectory,
  opts: MatchIndexOptions,
): MatchIndex {
  const key = optionsKey(opts)
  const hit = indexes.get(directory)
  if (hit && hit.key === key) return hit.index
  const index = buildMatchIndex(directory, opts)
  indexes.set(directory, { key, index })
  return index
}

/** What has been found for one client so far. */
type Found = {
  evidence: Set<Evidence>
  /** `nameNear` came from a person's name (the client's, or a contact
   * person's): initials or a household, not a business's shorter name. */
  nearPerson?: boolean
  siteIds: Array<Id<'properties'>>
  streetSiteIds: Array<Id<'properties'>>
  nearSiteIds: Array<Id<'properties'>>
  siteContactSiteIds: Array<Id<'properties'>>
  contactId?: Id<'clientContacts'>
  shared: Array<{ field: KeyField; key: string; holders: number }>
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Phone keys before emails, wherever both are listed. */
const FIELD_RANK: Record<KeyField, number> = { phone: 0, email: 1 }

function distinctClients(
  holdings: ReadonlyArray<Holding>,
): Array<Id<'clients'>> {
  return [...new Set(holdings.map((h) => h.clientId))]
}

/** A typed address worth comparing: one with a street line. */
function usableAddress(site: TypedAddress | undefined): TypedAddress | null {
  return site && site.addressLine.trim() !== '' ? site : null
}

export type MatchOptions = {
  /** When each client was last booked, newest first among equals. Clients
   * not in it sort after those that are. */
  lastBookedAt?: ReadonlyMap<Id<'clients'>, number>
}

/**
 * The clients a new client, as typed, may already be: each with its
 * evidence and tier, and the keys others share. See `Evidence` and `Tier`.
 *
 * Ordered by tier, then by how much evidence, then the newest booking, then
 * client id.
 */
export function matchNewClient(
  index: MatchIndex,
  typed: TypedClient,
  opts: MatchOptions = {},
): MatchResult {
  const found = new Map<Id<'clients'>, Found>()
  const at = (clientId: Id<'clients'>): Found => {
    let f = found.get(clientId)
    if (!f) {
      f = {
        evidence: new Set(),
        siteIds: [],
        streetSiteIds: [],
        nearSiteIds: [],
        siteContactSiteIds: [],
        shared: [],
      }
      found.set(clientId, f)
    }
    return f
  }
  const rows: Array<{
    field: KeyField
    key: string
    reason: SharedReason
    clientIds: Array<Id<'clients'>>
  }> = []

  const name = typed.name?.trim() ?? ''
  const typedName = nameKey(name)
  const nameUsable = !isPlaceholderName(name)

  /** Whether the typed name agrees with `other`: exactly, similar, or not.
   * A placeholder, or a name more than two clients have, never agrees. */
  const agreement = (
    other: string,
    kind: 'person' | 'business',
  ): 'name' | 'nameNear' | null => {
    if (!nameUsable || isPlaceholderName(other)) return null
    const key = nameKey(other)
    if ((index.names.get(key)?.length ?? 0) > NAME_HOLDERS_MAX) return null
    if (key === typedName) return 'name'
    return nameNear(name, other, kind) ? 'nameNear' : null
  }

  const keyEvidence = (
    field: KeyField,
    key: string,
    holdings: ReadonlyArray<Holding>,
  ) => {
    const holders = distinctClients(holdings)
    if (holders.length === 0) return
    const kind = field === 'phone' ? phoneKind(key) : 'email'
    if (kind === 'line' || holders.length > 1) {
      rows.push({
        field,
        key,
        reason: kind === 'line' ? 'line' : 'many',
        clientIds: holders,
      })
      for (const clientId of holders) {
        const f = at(clientId)
        f.evidence.add('shared')
        f.shared.push({ field, key, holders: holders.length })
      }
      return
    }

    const clientId = holders[0]
    const client = index.clients.get(clientId)
    if (!client) return
    // Whose name agrees: the client's own, else that of a contact person
    // holding the key. Exact before similar.
    let agreed = agreement(client.name, client.kind)
    let via: Id<'clientContacts'> | undefined
    if (agreed !== 'name') {
      const byContactId = holdings
        .filter((holding) => holding.contactId !== undefined)
        .sort((a, b) => compare(a.contactId ?? '', b.contactId ?? ''))
      for (const holding of byContactId) {
        const byContact = agreement(holding.name, 'person')
        if (byContact === 'name' || (byContact && !agreed && !via)) {
          agreed = byContact
          via = holding.contactId
          if (byContact === 'name') break
        }
      }
    }

    const f = at(clientId)
    if (client.kind === 'business' && !agreed) {
      // An agency's line or rentals@: the business holds it for everyone
      // it books for.
      rows.push({ field, key, reason: 'business', clientIds: holders })
      f.evidence.add('shared')
      f.shared.push({ field, key, holders: 1 })
      return
    }
    f.evidence.add(
      kind === 'mobile' ? 'mobile' : kind === 'email' ? 'email' : 'landline',
    )
    if (agreed) {
      f.evidence.add(agreed)
      if (agreed === 'nameNear' && (via || client.kind === 'person')) {
        f.nearPerson = true
      }
      if (via && !f.contactId) f.contactId = via
    } else if (kind !== 'mobile' && kind !== 'email') {
      rows.push({ field, key, reason: 'landline', clientIds: holders })
    }
  }

  const typedPhones = phoneKeys(typed.phone, index.areaCode)
  for (const key of typedPhones) {
    keyEvidence('phone', key, index.phones.get(key) ?? [])
  }
  if (index.complete) {
    for (const key of emailKeys(typed.email)) {
      keyEvidence('email', key, index.emails.get(key) ?? [])
    }
  }

  const address = usableAddress(typed.site)
  const addressKey = address ? siteKey(address) : null
  if (address && addressKey !== null) {
    for (const site of index.sites.get(addressKey) ?? []) {
      const f = at(site.clientId)
      f.evidence.add('site')
      f.siteIds.push(site._id)
    }
    for (const site of index.streets.get(streetKey(address)) ?? []) {
      if (index.siteKeys.get(site._id) === addressKey) continue
      const f = at(site.clientId)
      f.evidence.add('street')
      f.streetSiteIds.push(site._id)
    }
  }

  if (nameUsable) {
    const named = index.names.get(typedName) ?? []
    if (named.length <= NAME_HOLDERS_MAX) {
      for (const clientId of named) at(clientId).evidence.add('name')
    }
  }

  // A similar name, for a client something else has already turned up:
  // never looked for across the whole book.
  for (const [clientId, f] of found) {
    if (f.evidence.has('name')) continue
    const client = index.clients.get(clientId)
    if (client && agreement(client.name, client.kind) === 'nameNear') {
      f.evidence.add('nameNear')
      if (client.kind === 'person') f.nearPerson = true
    }
  }

  if (nameUsable) {
    for (const key of typedPhones) {
      for (const site of index.siteContacts.get(key) ?? []) {
        const contact = site.siteContactName ?? ''
        if (isPlaceholderName(contact)) continue
        if (nameKey(contact) === typedName || nameNear(name, contact)) {
          const f = at(site.clientId)
          f.evidence.add('siteContact')
          f.siteContactSiteIds.push(site._id)
        }
      }
    }
  }

  // Like one of their own sites: only for clients already candidates, a
  // handful of rows each, where a wrong guess costs a glance. A site already
  // matched, exactly or on the street, is not like itself as well.
  if (address && addressKey !== null) {
    for (const [clientId, f] of found) {
      for (const site of index.sitesOf.get(clientId) ?? []) {
        if (index.siteKeys.get(site._id) === addressKey) continue
        if (f.streetSiteIds.includes(site._id)) continue
        if (addressNear(address, site)) {
          f.evidence.add('addressNear')
          f.nearSiteIds.push(site._id)
        }
      }
    }
  }

  const all: Array<Candidate> = []
  for (const [clientId, f] of found) {
    const tier = tierOf(f.evidence, index.complete, f.nearPerson ?? false)
    if (tier) all.push(candidateOf(clientId, tier, f))
  }
  const candidates = all.some((c) => c.tier !== 'maybe')
    ? all.filter((c) => c.tier !== 'maybe')
    : all
  candidates.sort(byStrength(opts.lastBookedAt))

  // A one-holder row says nothing a candidate row for that client doesn't.
  const listed = new Set(candidates.map((c) => c.clientId))
  const kept = rows.filter(
    (row) =>
      row.reason === 'many' ||
      row.reason === 'line' ||
      !listed.has(row.clientIds[0]),
  )
  return {
    candidates,
    shared: sharedRows(index, kept),
    complete: index.complete,
  }
}

/**
 * A candidate's tier (`Tier`). The server's sheet refusal reads it
 * (`candidate.tier === 'same'`, lib/findSame.ts), so a change here is a
 * change to what the backstop refuses once Convex is deployed with it, not
 * only to what the phone shows: deploy the backend with the frontend that
 * shows it. The landline rule (a person's initial and surname is Likely)
 * came with the matching plan's M3, 1 Nov 2026.
 */
function tierOf(
  evidence: ReadonlySet<Evidence>,
  complete: boolean,
  nearPerson: boolean,
): Tier | null {
  const agrees = evidence.has('name') || evidence.has('nameNear')
  const strong =
    evidence.has('site') || evidence.has('mobile') || evidence.has('email')
  // A landline needs the name itself, or a business's shorter name: a
  // person's initial and surname may be anyone in the house.
  const landlineAgrees =
    evidence.has('landline') && (evidence.has('name') || !nearPerson)
  let tier: Tier
  if (agrees && (strong || landlineAgrees)) tier = 'same'
  else if (strong) tier = 'likely'
  else if (
    agrees &&
    (evidence.has('street') ||
      evidence.has('addressNear') ||
      evidence.has('shared') ||
      evidence.has('landline'))
  ) {
    tier = 'likely'
  } else if (evidence.has('siteContact')) tier = 'likely'
  else if (evidence.has('name')) tier = 'maybe'
  else return null
  // An old copy can't say who else holds a number: never more than Likely.
  return !complete && tier === 'same' ? 'likely' : tier
}

const byId = <T extends string>(ids: Array<T>) => [...ids].sort(compare)

function candidateOf(clientId: Id<'clients'>, tier: Tier, f: Found): Candidate {
  return {
    clientId,
    tier,
    evidence: EVIDENCE_ORDER.filter((e) => f.evidence.has(e)),
    siteIds: byId(f.siteIds),
    streetSiteIds: byId(f.streetSiteIds),
    nearSiteIds: byId(f.nearSiteIds),
    siteContactSiteIds: byId(f.siteContactSiteIds),
    ...(f.contactId ? { contactId: f.contactId } : {}),
    shared: [...f.shared].sort(
      (a, b) =>
        FIELD_RANK[a.field] - FIELD_RANK[b.field] || compare(a.key, b.key),
    ),
  }
}

/** Evidence that counts towards order: everything but a shared key. */
const weight = (c: Candidate) => c.evidence.filter((e) => e !== 'shared').length

function byStrength(
  lastBookedAt: ReadonlyMap<Id<'clients'>, number> | undefined,
): (a: Candidate, b: Candidate) => number {
  const booked = (c: Candidate) => lastBookedAt?.get(c.clientId) ?? 0
  return (a, b) =>
    TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
    weight(b) - weight(a) ||
    booked(b) - booked(a) ||
    compare(a.clientId, b.clientId)
}

/** One row per set of holders, business clients first; phone keys before
 * emails. */
function sharedRows(
  index: MatchIndex,
  rows: ReadonlyArray<{
    field: KeyField
    key: string
    reason: SharedReason
    clientIds: ReadonlyArray<Id<'clients'>>
  }>,
): Array<SharedRow> {
  const isBusiness = (id: Id<'clients'>) =>
    index.clients.get(id)?.kind === 'business'
  const bySet = new Map<string, SharedRow>()
  const ordered = [...rows].sort(
    (a, b) =>
      FIELD_RANK[a.field] - FIELD_RANK[b.field] || compare(a.key, b.key),
  )
  for (const row of ordered) {
    const clientIds = [...row.clientIds].sort(
      (a, b) => Number(isBusiness(b)) - Number(isBusiness(a)) || compare(a, b),
    )
    const set = clientIds.join(' ')
    const existing = bySet.get(set)
    const key = { field: row.field, key: row.key, reason: row.reason }
    if (existing) {
      existing.keys.push(key)
      continue
    }
    const businesses = clientIds.filter(isBusiness)
    bySet.set(set, {
      keys: [key],
      clientIds,
      ...(businesses.length === 1 ? { businessClientId: businesses[0] } : {}),
    })
  }
  return [...bySet.values()]
}

/**
 * Whether the chosen client already has a site at, or like, the typed
 * address, for New site for {client}. Another client holding the address is
 * not a match here: the person chose the client, and a sold house or a
 * managing agency is the usual reason.
 *
 * At most one candidate, the chosen client: Same when one of its sites is
 * the typed address, Likely when one is only like it.
 */
export function matchNewSite(
  index: MatchIndex,
  clientId: Id<'clients'>,
  typed: TypedAddress,
): MatchResult {
  const none: MatchResult = {
    candidates: [],
    shared: [],
    complete: index.complete,
  }
  const address = usableAddress(typed)
  if (!address) return none
  const key = siteKey(address)
  const f: Found = {
    evidence: new Set(),
    siteIds: [],
    streetSiteIds: [],
    nearSiteIds: [],
    siteContactSiteIds: [],
    shared: [],
  }
  for (const site of index.sitesOf.get(clientId) ?? []) {
    if (index.siteKeys.get(site._id) === key) {
      f.evidence.add('site')
      f.siteIds.push(site._id)
    } else if (addressNear(address, site)) {
      f.evidence.add('addressNear')
      f.nearSiteIds.push(site._id)
    }
  }
  if (f.evidence.size === 0) return none
  const exact: Tier = index.complete ? 'same' : 'likely'
  const tier: Tier = f.evidence.has('site') ? exact : 'likely'
  return { ...none, candidates: [candidateOf(clientId, tier, f)] }
}

/**
 * Whether a booking sent later, with nobody there to answer, may be moved
 * onto this candidate without a tap (the server's, on its own complete
 * read). All of:
 *
 *  1. a place or a person: the exact address, or a mobile or email this
 *     client alone holds. A landline is not enough; a street or an address
 *     that is only like one never is.
 *  2. the exact name, of two or more words once titles and "and" are
 *     dropped (`nameWords`: "Mrs Smith" is one), not a placeholder, and no
 *     other client's.
 *  3. a client still served: not inactive, not archived. A lead is fine.
 *  4. not one the person already booked past (`dismissed`), nor, for a new
 *     client, the one this resend was already moved onto (`applied`).
 *
 * And never from a copy missing emails and contact people (`complete`):
 * who else holds a number can't be judged from it.
 *
 * In New site for {client} (`mode: 'site'`), only the chosen client's own
 * site at the exact address: booking there instead of adding it again.
 * That holds for the client a resend was moved onto as well: the resend is
 * a new site for them only because they had none there, so if they have
 * one by now, another phone's booking of the same caller made it, and a
 * second would be the same address twice.
 */
export function autoRule(
  index: MatchIndex,
  candidate: Candidate,
  typed: TypedClient,
  opts: {
    mode?: 'new' | 'site'
    dismissed?: ReadonlyArray<Id<'clients'>>
    applied?: Id<'clients'>
  } = {},
): boolean {
  if (opts.dismissed?.includes(candidate.clientId)) return false
  const evidence = new Set(candidate.evidence)
  if (opts.mode === 'site') return evidence.has('site')
  if (opts.applied === candidate.clientId) return false
  if (!index.complete) return false
  if (
    !evidence.has('site') &&
    !evidence.has('mobile') &&
    !evidence.has('email')
  ) {
    return false
  }
  const client = index.clients.get(candidate.clientId)
  if (!client) return false
  if (client.status === 'inactive' || client.archivedAt !== undefined) {
    return false
  }
  // Two words of name on both sides, titles and "and" not counted: "Mrs
  // Smith" and "Mr & Mrs Brown" are a surname alone.
  const name = typed.name ?? ''
  const key = nameKey(name)
  if (isPlaceholderName(name) || nameWords(name).length < 2) return false
  if (nameKey(client.name) !== key || nameWords(client.name).length < 2) {
    return false
  }
  return (index.names.get(key)?.length ?? 0) === 1
}

/** The rows shown at once, and how many more there are ("and 2 more"). */
export function shownRows<T>(rows: ReadonlyArray<T>): {
  shown: Array<T>
  more: number
} {
  return {
    shown: rows.slice(0, MATCH_ROWS_MAX),
    more: Math.max(0, rows.length - MATCH_ROWS_MAX),
  }
}
