import { emailKeys, phoneKeys } from '../../convex/lib/contactKeys'
import { filterByWords } from './searchMatch'
import type { MatchIndex } from '../../convex/lib/clientMatch'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * Searching for the caller in New Job's pickers (the plan's "search first"):
 * what a query looks like, who holds the number or email typed, and what
 * the picker offers when nothing matches. Pure, so the rules are tested
 * without a sheet.
 *
 * A number is found by its key, through the match index (lib/clientMatch.ts):
 * "08 9345 6789" finds a client saved as "9345 6789", which the words of the
 * two never could. Finding is not matching: a number held by six clients
 * lists all six, and nothing here says the caller is any of them.
 */

/** What a query typed into a client or property picker looks like. */
export type QueryShape = 'phone' | 'email' | 'address' | 'name' | 'other'

/**
 * - `phone`: only digits, spaces, brackets, dots, `+` and `-`, and a number
 *   a key can be made of (`phoneKeys`, under the business's `areaCode`): ten
 *   digits once +61 is read as 0; eight, a local number starting 2–9; nine
 *   starting with 4, a mobile missing its 0; a 13, 1300 or 1800 number; or
 *   after a +, another country's. Not an ABN's eleven digits, nor a number
 *   a digit short ("08 9345 678"): Phone is not where either goes.
 * - `email`: it has an @.
 * - `address`: a number, then a word ("12 Wattle St", "3/12 Ocean Pde").
 * - `name`: letters only (with spaces, apostrophes, hyphens, full stops and
 *   "&"), two or more of them.
 * - `other`: anything else ("6014", "J", "51 824 753 556").
 */
export function queryShape(query: string, areaCode: string): QueryShape {
  const typed = query.trim()
  if (typed === '') return 'other'
  if (/^[\d\s()+\-.]+$/.test(typed)) {
    return phoneKeys(typed, areaCode).length > 0 ? 'phone' : 'other'
  }
  if (typed.includes('@')) return 'email'
  if (/^\d+[a-z]?(?:\/\d+[a-z]?)?\s+\p{L}/iu.test(typed)) return 'address'
  if (
    /^[\p{L}\s'’.\-&]+$/u.test(typed) &&
    (typed.match(/\p{L}/gu)?.length ?? 0) >= 2
  ) {
    return 'name'
  }
  return 'other'
}

/** The New client field a no-match action fills. */
export type NewClientField = 'phone' | 'email' | 'addressLine' | 'clientName'

/** What "nothing matches" offers: a new client, with what was typed put
 * where it belongs, and a label naming that field. */
export type NoMatchRoute = {
  label: string
  /** The field it fills, or null for a new client with nothing filled. */
  fills: NewClientField | null
  /** What goes in it: the query, trimmed. */
  value: string
}

/**
 * A query with no match, as the way in to a new client (RK13): a number
 * goes in Phone, an email in Email, an address in the street line, a name in
 * Name, and anything else ("6014", which could be a postcode or the start
 * of a number) nowhere. The label says which, so nothing lands in a field
 * unseen: "New client, phone “0412 345 678”".
 */
export function noMatchRoute(query: string, areaCode: string): NoMatchRoute {
  const value = query.trim()
  switch (queryShape(value, areaCode)) {
    case 'phone':
      return {
        label: `New client, phone “${value}”`,
        fills: 'phone',
        value,
      }
    case 'email':
      return {
        label: `New client, email “${value}”`,
        fills: 'email',
        value,
      }
    case 'address':
      return { label: `New client at “${value}”`, fills: 'addressLine', value }
    case 'name':
      return {
        label: `New client named “${value}”`,
        fills: 'clientName',
        value,
      }
    default:
      return { label: 'New client', fills: null, value }
  }
}

/**
 * Who holds a typed number or email, by its key (`phoneKeys`, `emailKeys`):
 * the clients holding it on their own fields or through a contact person,
 * as the match index counts them (the business's own and the person's own
 * left out, and the team's on the phone of someone who manages the team),
 * and the business sites whose site contact has it, which are found but
 * never counted. Null for a query that is neither.
 *
 * An email is looked up only in a copy that has them all (`complete`); a
 * copy without still finds one by its words.
 */
export type QueryHolders = {
  /** In key order, then by id: who holds it. */
  clientIds: Array<Id<'clients'>>
  /** Business sites whose site contact has the typed number. */
  siteContactSiteIds: Array<Id<'properties'>>
}

export function queryHolders(
  index: MatchIndex,
  query: string,
): QueryHolders | null {
  const shape = queryShape(query, index.areaCode)
  if (shape !== 'phone' && shape !== 'email') return null
  const clientIds: Array<Id<'clients'>> = []
  const siteContactSiteIds: Array<Id<'properties'>> = []
  const take = (id: Id<'clients'>) => {
    if (!clientIds.includes(id)) clientIds.push(id)
  }
  if (shape === 'phone') {
    for (const key of phoneKeys(query, index.areaCode)) {
      const held = [...(index.phones.get(key) ?? [])].map((h) => h.clientId)
      for (const id of held.sort()) take(id)
      for (const site of index.siteContacts.get(key) ?? []) {
        if (index.clients.get(site.clientId)?.kind !== 'business') continue
        if (!siteContactSiteIds.includes(site._id)) {
          siteContactSiteIds.push(site._id)
        }
      }
    }
  } else if (index.complete) {
    for (const key of emailKeys(query)) {
      const held = [...(index.emails.get(key) ?? [])].map((h) => h.clientId)
      for (const id of held.sort()) take(id)
    }
  }
  return { clientIds, siteContactSiteIds }
}

/**
 * The Property picker's rows to list first for a query, in the picker's
 * own order: each holder's sites, then the sites whose site contact has the
 * number. `sites` is every site, in the order the picker lists them.
 */
export function holdersFirst(
  holders: QueryHolders,
  sites: ReadonlyArray<{ _id: string; clientId: string }>,
): Array<string> {
  const held = new Set<string>(holders.clientIds)
  const first = sites.filter((s) => held.has(s.clientId)).map((s) => s._id)
  const atSite = holders.siteContactSiteIds.filter((id) => !first.includes(id))
  return [...first, ...atSite]
}

/**
 * The clients a Property picker query finds that it has no row for: a client
 * with no site yet, whom a picker of sites can never list, by name or by
 * number. A number or an email (`holders` not null) by who holds it, in
 * their order, so the business's own number on a client who has none finds
 * nobody, as it does everywhere; anything else by the words of their row in
 * the client picker (`siteLess`: the client picker's rows for those clients
 * alone).
 */
export function siteLessFound(
  query: string,
  holders: QueryHolders | null,
  siteLess: ReadonlyArray<{
    value: string
    label: string
    searchKey?: string
    labelKey?: string
  }>,
): Array<string> {
  if (holders) {
    const ids = new Set(siteLess.map((o) => o.value))
    return holders.clientIds.filter((id) => ids.has(id))
  }
  return filterByWords(siteLess, query).map((o) => o.value)
}

/**
 * How the Property picker's list ends for a query: "New site for {client}"
 * for the one client holding the number or email typed, whether or not they
 * have sites, or for the one client it finds with no site
 * (`siteLessFound`); a way to choose among several with none; or nothing.
 * Either is in place of "New client": a client the list can't show is still
 * a client, and a second record is what a new one would make of them.
 */
export type PropertyListEnd =
  { kind: 'one'; clientId: string } | { kind: 'several'; count: number } | null

export function propertyListEnd(
  holders: QueryHolders | null,
  siteLess: ReadonlyArray<string>,
): PropertyListEnd {
  if (holders?.clientIds.length === 1) {
    return { kind: 'one', clientId: holders.clientIds[0] }
  }
  if (siteLess.length === 1) return { kind: 'one', clientId: siteLess[0] }
  if (siteLess.length > 1) return { kind: 'several', count: siteLess.length }
  return null
}
