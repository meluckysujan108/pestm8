import { matchNewClient } from '../../convex/lib/clientMatch'
import { MAY_BE_SAME_GROUP, mergeNames } from './clientMergeCopy'
import { evidencePhrase, throughContact } from './clientMatchRows'
import { clientsForPicker } from './directory'
import { EVERYONE_GROUP, clientOptions } from './propertyOptions'
import { searchKeyOf } from './searchMatch'
import type {
  Evidence,
  MatchIndex,
  TypedAddress,
  TypedClient,
} from '../../convex/lib/clientMatch'
import type { ComboboxOption } from '#/components/primitives/Combobox'
import type { NormalisedDirectory } from './directory'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * Merge into… and the possible-duplicate line on a client's sheet (the
 * matching plan's M8): which clients the one on the sheet may be, from the
 * matcher New Job and Clients → New client use (lib/clientMatch.ts), and
 * the list to choose the client to keep from. Pure, so the order and the
 * words are tested without a sheet.
 */

/** What makes two clients alike enough to list first: the kinds of
 * evidence a server's hint holds too (`matchEvidence`), an address only
 * beside another of them (`saysSameCustomer`). A street, a near address, a
 * site contact or a number many share is not. */
const ALIKE: ReadonlyArray<Evidence> = [
  'name',
  'nameNear',
  'site',
  'mobile',
  'email',
  'landline',
]

/** Evidence of the person themselves, whatever the name: their own
 * mobile, email or landline. */
const PERSON: ReadonlyArray<Evidence> = ['mobile', 'email', 'landline']

/**
 * Whether what two clients agree on says they may be one customer. An
 * address counts only as the server's own hints count it (`hintsOf`,
 * convex/lib/findSame.ts): with a name like theirs, or a number or email of
 * theirs, beside it. Never an address under another name: a tenant, the
 * house's last owner, an agency's site — New Job's "Already a site", not
 * the same customer. A name like theirs alone still counts here, where the
 * hints don't: this list is opened on purpose, to find the other record of
 * a customer who came back under a new number, at a new address.
 */
function saysSameCustomer(evidence: ReadonlySet<Evidence>): boolean {
  return (
    PERSON.some((e) => evidence.has(e)) ||
    evidence.has('name') ||
    evidence.has('nameNear')
  )
}

const TIER_RANK = { same: 0, likely: 1, maybe: 2 } as const

/**
 * The client book as the merge's matcher reads it: without the client being
 * merged, and without anyone archived. Built without them, not filtered
 * after, because the matcher counts who holds a number or a name: with the
 * client in it, their own mobile would be one two clients hold, and so
 * evidence of no one (`many`) — and so with an archived record of theirs,
 * which a merge can't take anyway.
 */
export function mergeBook(
  directory: NormalisedDirectory,
  clientId: string,
): NormalisedDirectory {
  const left = new Set(
    directory.clients
      .filter((c) => c._id === clientId || c.archivedAt !== undefined)
      .map((c) => c._id as string),
  )
  return {
    ...directory,
    clients: directory.clients.filter((c) => !left.has(c._id)),
    sites: directory.sites.filter((s) => !left.has(s.clientId)),
    contacts: directory.contacts.filter((c) => !left.has(c.clientId)),
  }
}

/** One client the matcher finds alike, with what they agree on. */
export type MergeMatch = {
  clientId: Id<'clients'>
  /** In the matcher's fixed order: name, nameNear, site, mobile, email,
   * landline. */
  evidence: Array<Evidence>
  /** The contact person of theirs a name agreed with, rather than their
   * own name (Sarah Lee at Ray White Bayswater), as the matcher found it. */
  contactId?: Id<'clientContacts'>
}

/**
 * The clients `client` may be, from an index of the merge's book
 * (`mergeBook`): their name, number and email with each of their sites
 * in turn, as if typed into New client, and then their name alone. Same
 * first, then Likely, then Maybe; within a tier, more evidence first, then
 * as the matcher ordered them. Never an archived client: a merge refuses
 * one. Nor someone who only has an address of theirs (`saysSameCustomer`):
 * they are everyone else, A–Z.
 */
export function mergeMatches(
  index: MatchIndex,
  client: { name: string; phone?: string; email?: string },
  sites: ReadonlyArray<TypedAddress>,
): Array<MergeMatch> {
  const found = new Map<
    Id<'clients'>,
    {
      rank: number
      order: number
      evidence: Set<Evidence>
      contactId?: Id<'clientContacts'>
    }
  >()
  const typed = sites.length > 0 ? sites : [undefined]
  const passes: Array<TypedClient> = [
    ...typed.map((site) => ({
      name: client.name,
      phone: client.phone,
      email: client.email,
      site,
    })),
    // The name alone too: the matcher keeps a client of a name like theirs
    // and nothing else only where nothing stronger turned up, and what did
    // may be someone this list leaves out (a tenant at their address) or
    // someone else with their number. Either would lose the other record
    // of a customer who came back under a new number, at a new address.
    { name: client.name },
  ]
  for (const pass of passes) {
    const result = matchNewClient(index, pass)
    for (const candidate of result.candidates) {
      if (index.clients.get(candidate.clientId)?.archivedAt !== undefined) {
        continue
      }
      const alike = candidate.evidence.filter((e) => ALIKE.includes(e))
      if (alike.length === 0) continue
      const rank = TIER_RANK[candidate.tier]
      const at = found.get(candidate.clientId)
      if (at) {
        at.rank = Math.min(at.rank, rank)
        for (const e of alike) at.evidence.add(e)
        at.contactId ??= candidate.contactId
      } else {
        found.set(candidate.clientId, {
          rank,
          order: found.size,
          evidence: new Set(alike),
          contactId: candidate.contactId,
        })
      }
    }
  }
  return [...found.entries()]
    .filter(([, at]) => saysSameCustomer(at.evidence))
    .sort(
      ([, a], [, b]) =>
        a.rank - b.rank ||
        b.evidence.size - a.evidence.size ||
        a.order - b.order,
    )
    .map(([clientId, at]) => ({
      clientId,
      evidence: ALIKE.filter((e) => at.evidence.has(e)),
      ...(at.contactId ? { contactId: at.contactId } : {}),
    }))
}

/**
 * The list's line for a client the matcher finds alike: "Same mobile"; or,
 * where the name agreed with a contact person of theirs rather than their
 * own (`contact`), that person first, as the match rows name them ("Sarah
 * Lee is a contact at Ray White Bayswater"): "Contact Sarah Lee: same name
 * and mobile", never "Same name" for an agency called nothing like it.
 */
export function sameAsDetail(
  evidence: ReadonlyArray<Evidence>,
  contact?: string,
): string {
  const phrase = evidencePhrase(evidence)
  if (contact) return `Contact ${contact}: ${phrase}`
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/** A possible duplicate's name that agreed through a contact person
 * (`hintThroughContact`): the contact, by the name their client is called;
 * `exact` for the same name; and whose contact they are, by name, or null
 * for the other client, whom the line names first. */
export type HintContact = { contact: string; exact: boolean; at: string | null }

/**
 * Where a possible duplicate's name agreed through a contact person rather
 * than the two clients' own names: the server's matcher takes a contact's
 * name with a number or email they hold (convex/lib/clientMatch.ts), and a
 * hint keeps the evidence, not the contact. So Sarah Lee, booked with the
 * mobile Ray White Bayswater's contact Sarah Lee holds, is "same name and
 * mobile" as the agency. Read as the match rows read it (`throughContact`),
 * from the two names. The contact is the client's that was there before
 * the hint: the client the booking made, called as typed, wasn't in the
 * book it was matched against, so had no contacts to match through. And a
 * contact counts only on a business (`buildMatchIndex`): where that client
 * is a person (by the client list in memory, if it is there), the name
 * agreed with their own, by a person's rule — an initial, or a household
 * like "J & T Nguyen" — and no contact is in it. Null then, where their
 * own names agree, or nothing says a contact: the line says what they
 * agree on as it is.
 */
export function hintThroughContact(
  here: {
    name: string
    kind: 'person' | 'business'
    _creationTime: number
  },
  other: { name: string; kind?: 'person' | 'business' },
  hint: { evidence: ReadonlyArray<Evidence>; madeAt: number },
): HintContact | null {
  const madeWithHint =
    Math.abs(here._creationTime - hint.madeAt) <= HINT_SAME_SAVE_MS
  const holder = madeWithHint ? 'other' : 'here'
  const [at, by] = holder === 'here' ? [here, other] : [other, here]
  if (at.kind === 'person') return null
  const through = throughContact(
    { name: at.name, evidence: hint.evidence },
    by.name,
    at.kind,
  )
  if (!through) return null
  return {
    contact: through.typed,
    exact: through.exact,
    at: holder === 'here' ? here.name : null,
  }
}

/**
 * "May be the same customer as Jane Nguyen: same mobile." — a possible
 * duplicate the server's check let through when a booking made a client
 * (`clientMatchHints.forClient`), with what the two agree on in the words
 * the match rows use (`evidencePhrase`). Where the name agreed through a
 * contact person (`through`), who that is first, as the match rows say it:
 * "May be the same customer as Ray White Bayswater: Sarah Lee is a contact
 * there, with the same mobile."
 */
export function maybeSameLine(
  otherName: string,
  evidence: ReadonlyArray<Evidence>,
  through: HintContact | null = null,
): string {
  const opening = `May be the same customer as ${otherName}`
  if (!through) return `${opening}: ${evidencePhrase(evidence)}.`
  const keys = evidence.filter((e) => e !== 'name' && e !== 'nameNear')
  return `${opening}: ${through.contact} ${through.exact ? 'is' : 'may be'} a contact ${
    through.at === null ? 'there' : `at ${through.at}`
  }, with the ${evidencePhrase(keys)}.`
}

/**
 * The other client as a possible-duplicate line names them. Where the two
 * are called the same — the usual duplicate — with their number, "Jane
 * Nguyen #12", as a merge names them (`mergeNames`), so the line on Jane
 * Nguyen's sheet says which other record it means; bare where the number
 * isn't known (`otherNumber` from the client list in memory as the line
 * first draws, kept for the opening: one that came later would change the
 * line's length under a thumb).
 */
export function maybeSameName(
  hereName: string,
  otherName: string,
  otherNumber: number | null | undefined,
): string {
  return mergeNames(
    { name: hereName, clientNumber: null },
    { name: otherName, clientNumber: otherNumber ?? null },
  ).into
}

/**
 * The possible-duplicate lines a sheet draws: of those it first drew
 * (`hints`), each the server still lists between the same two clients
 * (`live`: each open hint's id to its other client), and each answered
 * here, which stays saying so. A hint answered, binned or merged away
 * elsewhere is gone from `live`; one whose other client was merged into a
 * third keeps its id (`settleHintsOnMerge` hands it over) but now pairs
 * this client with that third, whom the line doesn't name, so it goes too.
 */
export function shownHints<T extends { _id: string; otherClientId: string }>(
  hints: ReadonlyArray<T>,
  live: ReadonlyMap<string, string>,
  answered: ReadonlySet<string>,
): Array<T> {
  return hints.filter(
    (hint) =>
      live.get(hint._id) === hint.otherClientId || answered.has(hint._id),
  )
}

/**
 * How long after the client sheet first draws its client the
 * possible-duplicate lines may still come in. The two are asked for
 * together, but each is its own subscription, answered in turn, so the
 * lines can land a moment after the record; past this, one that comes would
 * push Book a job and the tabs down under a thumb, and waits for the next
 * opening. As a day's bookings on the phone may still come in under its
 * first drawing (`ADD_AFTER_DRAW_MS`).
 */
export const HINTS_AFTER_DRAW_MS = 500

/**
 * Which lines the client sheet shows this opening: null while that isn't
 * decided yet, then the hints there by then, or false for none, kept for
 * the opening. Nothing is decided before the client is (a kept view or a
 * placeholder in its place); an archived client has none (a merge refuses
 * one); otherwise the lines as they come, or none once they can't
 * (`settled`: not read for this person, or refused) or are late (`waited`:
 * HINTS_AFTER_DRAW_MS since the client drew).
 */
export function firstHintsNow<T>({
  client,
  hints,
  settled,
  waited,
}: {
  client: { archivedAt?: number } | null | undefined
  hints: ReadonlyArray<T> | undefined
  settled: boolean
  waited: boolean
}): ReadonlyArray<T> | false | null {
  if (!client) return null
  if (client.archivedAt !== undefined) return false
  if (hints !== undefined) return hints
  return settled || waited ? false : null
}

function numberOf(clientNumber: number | undefined): string | undefined {
  return clientNumber === undefined ? undefined : `#${clientNumber}`
}

/**
 * The rows to choose the client to keep from: everyone but the client
 * being merged, never one archived (a merge refuses one), each as New Job's
 * client picker has them (`clientOptions`: the name, where their sites are,
 * found by name, number, email, street or contact person), with their
 * client number. The ones the matcher finds alike come first, under "May be
 * the same customer", each saying why ("Same mobile · #12"); then everyone
 * else, A–Z. With nobody alike, one list without headings.
 */
export function mergeOptions(
  directory: NormalisedDirectory,
  clientId: string,
  matches: ReadonlyArray<MergeMatch>,
): Array<ComboboxOption> {
  const pickable = clientsForPicker(directory).filter(
    (c) => c._id !== clientId && c.archivedAt === undefined,
  )
  const numbers = new Map<string, number | undefined>(
    pickable.map((c) => [c._id, c.clientNumber]),
  )
  // Found by their number too, bare or as shown ("12", "#12"): it is all a
  // row shows beyond the name and suburb, and how the pair, the confirm and
  // the office tell two of a name apart.
  const options = clientOptions(pickable).map((option) => {
    const number = numberOf(numbers.get(option.value))
    return {
      ...option,
      detail: number,
      searchKey: number
        ? `${searchKeyOf(option)} ${number.slice(1)} ${number}`
        : option.searchKey,
    }
  })
  const byValue = new Map(options.map((o) => [o.value, o]))
  const first = matches.flatMap((match) => {
    const option = byValue.get(match.clientId)
    if (!option) return []
    const contact =
      match.contactId === undefined
        ? undefined
        : directory.contacts.find((c) => c._id === match.contactId)?.name
    const detail = [sameAsDetail(match.evidence, contact), option.detail]
      .filter(Boolean)
      .join(' · ')
    return [{ ...option, group: MAY_BE_SAME_GROUP, detail }]
  })
  if (first.length === 0) return options
  const put = new Set(first.map((o) => o.value))
  return [
    ...first,
    ...options
      .filter((o) => !put.has(o.value))
      .map((o) => ({ ...o, group: EVERYONE_GROUP })),
  ]
}

/** How far a client a booking made can be from its hint's own time: both
 * are written in the one save, well within this. */
const HINT_SAME_SAVE_MS = 2_000

/**
 * Which of a possible duplicate's two clients Merge… keeps unless told
 * otherwise: the one there first, by when each was made. Without the other
 * client's own time yet, the line's: a hint is made with the client a
 * booking made, so a client made well before it is the older one.
 */
export function keepsByDefault(
  here: { _creationTime: number },
  other: { _creationTime: number } | null | undefined,
  hintMadeAt: number,
): 'here' | 'other' {
  if (other) return here._creationTime <= other._creationTime ? 'here' : 'other'
  return here._creationTime < hintMadeAt - HINT_SAME_SAVE_MS ? 'here' : 'other'
}
