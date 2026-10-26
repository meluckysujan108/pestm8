import { emailKey, nameKey } from './contactKeys'
import type { Id } from '../_generated/dataModel'

/**
 * Which PestM8 client is which Xero contact (Release 2, convex/xeroMatch.ts).
 * Pure: the clients and the contacts in, a proposal per client out. No `ctx`,
 * no rows, no clock — so the rules are tested here, one by one
 * (xeroMatch.test.ts), and the run only fetches and stores.
 *
 * The rules, strongest first. A contact Xero holds as ARCHIVED or
 * GDPRREQUEST is never a candidate: linking to one would have Release 3
 * write into a contact the business put away, or one Xero is erasing.
 *
 *  1. AccountNumber = client number, and the name or an email agrees: linked.
 *  2. AccountNumber alone: to check, `account_number_only` — unless another
 *     contact has the client's unique email AND its name, which is linked.
 *     (A departure from the first spec, which asked about the numbered
 *     contact: asked about a stranger who happens to carry the number, the
 *     holder says Different, and Release 3 adds a second contact for
 *     someone Xero already holds by email and name. The numbered contact
 *     still holds the number, so Release 3 must not copy the client's
 *     number into the linked one: Xero refuses an AccountNumber another
 *     contact has.)
 *  3. A unique email, and the name agrees: linked.
 *  4. A unique email alone: to check, `email_only`.
 *  5. The name alone: to check, `name_only`. A name more than one contact
 *     has: to check, `name_shared`, against one of them — not one already
 *     another client's (that could only be refused), then the one whose
 *     phone or place agrees with the client's, if only one does, else the
 *     first.
 *  6. One contact proposed for two clients: every one of them to check,
 *     `contested`.
 *  7. Nothing: new — Release 3 creates it.
 *
 * Only "linked" is ever automatic, and only on two pieces of evidence that
 * agree. Anything weaker is put to the holder (Same / Different), because a
 * wrong link would have Release 3 rewrite a stranger's contact with this
 * client's details.
 *
 * Evidence that cannot pick out one contact is not evidence: an account
 * number two contacts share is ignored, and an email two contacts share
 * leaves only their names to go on.
 *
 * A client the holder already decided (`decided`) is not proposed again —
 * their word stands — and the contact it is linked to is RESERVED: no other
 * client may be linked to it, so one that would be is put to the holder as
 * contested instead.
 *
 * Deterministic: the same clients and contacts, in any order, give the same
 * proposals, ordered by client id. Where a rule has to pick one contact of
 * several, it picks by contact id.
 */

export type XeroContactForMatch = {
  contactId: string
  name: string
  email?: string
  accountNumber?: string
  status: 'ACTIVE' | 'ARCHIVED' | 'GDPRREQUEST'
  /** First non-empty of its phones, as Xero holds it. */
  phone?: string
  /** City of its first address that has one. */
  place?: string
}

export type ClientForMatch = {
  clientId: Id<'clients'>
  name: string
  clientNumber?: number
  /** The client's email and its contact person's, lower-cased, deduped. */
  emails: string[]
  phone?: string
  suburb?: string
  /** A decision to keep (Same, Different, Unlink): not proposed again. */
  decided?: { state: 'linked' | 'separate'; xeroContactId?: string }
}

export type CandidateReason =
  | 'account_number_only'
  | 'email_only'
  | 'name_only'
  | 'name_shared'
  | 'contested'

export type Proposal =
  | {
      clientId: Id<'clients'>
      outcome: 'linked'
      contact: XeroContactForMatch
    }
  | {
      clientId: Id<'clients'>
      outcome: 'review'
      contact: XeroContactForMatch
      reason: CandidateReason
    }
  | { clientId: Id<'clients'>; outcome: 'new' }

/** A name and an email as matching compares them now live in
 * lib/contactKeys.ts, shared with New Job's "already a client?". `nameKey`
 * is still answered from here, unchanged. */
export { nameKey }

/**
 * Xero's AccountNumber as a client number: trimmed, all digits, leading
 * zeros allowed ("0042" is 42). Anything else — letters, a dash, nothing, a
 * number too big to be exact — is null, and is no evidence.
 */
export function accountNumberKey(raw: string | undefined): number | null {
  const text = (raw ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

/** A phone as a tie-break compares it: its last eight digits, so "08 9345
 * 6789", "(08) 9345 6789" and "+61 8 9345 6789" agree. Fewer than eight
 * digits is no phone. */
function phoneKey(raw: string | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  return digits.length < 8 ? null : digits.slice(-8)
}

/** A suburb or city, as a tie-break compares it. */
function placeKey(raw: string | undefined): string | null {
  const text = (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return text === '' ? null : text
}

function byContactId(a: XeroContactForMatch, b: XeroContactForMatch): number {
  return compare(a.contactId, b.contactId)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Contacts by a key, each list in contact-id order. A null key is left
 * out. */
function groupBy<TKey>(
  contacts: ReadonlyArray<XeroContactForMatch>,
  keyOf: (contact: XeroContactForMatch) => TKey | null,
): Map<TKey, Array<XeroContactForMatch>> {
  const groups = new Map<TKey, Array<XeroContactForMatch>>()
  for (const contact of contacts) {
    const key = keyOf(contact)
    if (key === null) continue
    const group = groups.get(key)
    if (group) group.push(contact)
    else groups.set(key, [contact])
  }
  return groups
}

/**
 * One proposal for every client the holder has not decided, ordered by
 * client id. Decided clients are left out (their links stand), and reserve
 * the contacts they are linked to.
 */
export function matchClients(
  clients: ReadonlyArray<ClientForMatch>,
  contacts: ReadonlyArray<XeroContactForMatch>,
): Array<Proposal> {
  const candidates = contacts
    .filter((contact) => contact.status === 'ACTIVE')
    .sort(byContactId)

  const byAccount = groupBy(candidates, (contact) =>
    accountNumberKey(contact.accountNumber),
  )
  const byEmail = groupBy(candidates, (contact) => emailKey(contact.email))
  const byName = groupBy(candidates, (contact) => nameKey(contact.name) || null)

  const reserved = new Set<string>()
  for (const client of clients) {
    if (client.decided?.xeroContactId) {
      reserved.add(client.decided.xeroContactId)
    }
  }

  const proposals = clients
    .filter((client) => !client.decided)
    .sort((a, b) => compare(a.clientId, b.clientId))
    .map((client) => propose(client, { byAccount, byEmail, byName, reserved }))

  // One contact, proposed for two clients — or for one while another is
  // already linked to it — is a question for the holder, never a link: at
  // most one of them can be that contact.
  const proposedFor = new Map<string, number>()
  for (const proposal of proposals) {
    if (proposal.outcome === 'new') continue
    const id = proposal.contact.contactId
    proposedFor.set(id, (proposedFor.get(id) ?? 0) + 1)
  }
  return proposals.map((proposal): Proposal => {
    if (proposal.outcome === 'new') return proposal
    const id = proposal.contact.contactId
    if ((proposedFor.get(id) ?? 0) < 2 && !reserved.has(id)) return proposal
    return {
      clientId: proposal.clientId,
      outcome: 'review',
      contact: proposal.contact,
      reason: 'contested',
    }
  })
}

type Indexes = {
  byAccount: Map<number, Array<XeroContactForMatch>>
  byEmail: Map<string, Array<XeroContactForMatch>>
  byName: Map<string, Array<XeroContactForMatch>>
  /** Contacts already another client's, by the holder's word. */
  reserved: ReadonlySet<string>
}

/** One client's proposal on its own, before contests between clients. */
function propose(
  client: ClientForMatch,
  { byAccount, byEmail, byName, reserved }: Indexes,
): Proposal {
  const { clientId } = client
  const key = nameKey(client.name)
  const emails = new Set(
    client.emails.flatMap((email) => {
      const k = emailKey(email)
      return k === null ? [] : [k]
    }),
  )
  const nameAgrees = (contact: XeroContactForMatch) =>
    key !== '' && nameKey(contact.name) === key
  const emailAgrees = (contact: XeroContactForMatch) => {
    const k = emailKey(contact.email)
    return k !== null && emails.has(k)
  }
  const linked = (contact: XeroContactForMatch): Proposal => ({
    clientId,
    outcome: 'linked',
    contact,
  })
  const review = (
    contact: XeroContactForMatch,
    reason: CandidateReason,
  ): Proposal => ({ clientId, outcome: 'review', contact, reason })

  // A unique email, in the client's own order (its own email first, then its
  // contact person's): those are the contacts it could be by email.
  const byMail: Array<XeroContactForMatch> = []
  for (const email of emails) {
    const held = byEmail.get(email)
    if (held?.length === 1 && !byMail.includes(held[0])) byMail.push(held[0])
  }
  const mailAndName = byMail.find(nameAgrees)

  const numbered =
    client.clientNumber === undefined
      ? undefined
      : byAccount.get(client.clientNumber)
  if (numbered?.length === 1) {
    const contact = numbered[0]
    if (nameAgrees(contact) || emailAgrees(contact)) return linked(contact)
    // The number alone, against another contact with this client's own
    // unique email AND its name: that one is the client. Xero's
    // AccountNumber is a free field, and asking about the numbered stranger
    // would have Different create a second contact for someone Xero already
    // holds.
    if (mailAndName) return linked(mailAndName)
    return review(contact, 'account_number_only')
  }

  if (mailAndName) return linked(mailAndName)
  if (byMail.length > 0) return review(byMail[0], 'email_only')

  const named = key === '' ? undefined : byName.get(key)
  if (named?.length === 1) return review(named[0], 'name_only')
  if (named && named.length > 1) {
    return review(sharedNameCandidate(client, named, reserved), 'name_shared')
  }

  return { clientId, outcome: 'new' }
}

/**
 * Which of several contacts of the client's name to ask about. Not one
 * already another client's, if any is free: Same on it could only be
 * refused, and asking about it again every run would leave the client's own
 * contact never offered. Of those, the one whose phone or place agrees with
 * the client's, if just one does; else the first by contact id. Once the
 * holder has answered one client of the name, the next Check Xero again
 * offers its namesakes the contacts that are left.
 */
function sharedNameCandidate(
  client: ClientForMatch,
  named: ReadonlyArray<XeroContactForMatch>,
  reserved: ReadonlySet<string>,
): XeroContactForMatch {
  const free = named.filter((contact) => !reserved.has(contact.contactId))
  const pool = free.length > 0 ? free : named
  const phone = phoneKey(client.phone)
  const place = placeKey(client.suburb)
  const agreeing = pool.filter(
    (contact) =>
      (phone !== null && phoneKey(contact.phone) === phone) ||
      (place !== null && placeKey(contact.place) === place),
  )
  return agreeing.length === 1 ? agreeing[0] : pool[0]
}
