import { siteContactOf } from '../../convex/lib/siteContact'
import { phoneKeys } from '../../convex/lib/contactKeys'
import { queryShape } from './clientSearch'
import {
  computeSuburbLoad,
  statusCounts,
  tagsInUse,
} from '../../convex/lib/clientFacets'
import type { SuburbLoad, TagLoad } from '../../convex/lib/clientFacets'

export type ClientKind = 'person' | 'business'
export type KindFilter = 'all' | ClientKind
export type StatusFilter = 'all' | 'active' | 'lead' | 'inactive'

export const STATUS_FILTER_OPTIONS: Array<{
  value: StatusFilter
  label: string
}> = [
  { value: 'all', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'lead', label: 'Lead' },
  { value: 'inactive', label: 'Inactive' },
]

/**
 * What a client's kind is called on screen. Stored as `person` and
 * `business` (the schema's words, unchanged); shown as residential and
 * commercial, as a pest business speaks of its jobs.
 */
export const KIND_LABELS: Record<ClientKind, string> = {
  person: 'Residential',
  business: 'Commercial',
}

/** The type question on a client form, in the order it is asked. */
export const KIND_CHOICES: Array<{ value: ClientKind; label: string }> = [
  { value: 'person', label: KIND_LABELS.person },
  { value: 'business', label: KIND_LABELS.business },
]

export const KIND_OPTIONS: Array<{ value: ClientKind; label: string }> = [
  { value: 'business', label: KIND_LABELS.business },
  { value: 'person', label: KIND_LABELS.person },
]

/**
 * "Which suburbs are my clients in, and how many" lives with the rest of the
 * filter counting in convex/lib/clientFacets.ts, so that `clients.overview`
 * counts the whole book exactly as this page counts the clients a search has
 * found. Re-exported here, where the page and its tests have always found it.
 */
export { computeSuburbLoad }
export type { SuburbLoad }

/** Fewer digits than this and a number is more likely a street number, or
 * part of one, than an ABN or a phone: it would bring in clients whose ABN
 * happens to contain it, with nothing on their card to say why. */
const MIN_NUMBER_DIGITS = 4

const digitsOf = (text: string) => text.replace(/\D/g, '')

/** A phone number's digits as dialled at home: +61 412 345 678 as
 * 0412345678. */
function nationalDigits(phone: string): string {
  const digits = digitsOf(phone)
  return digits.startsWith('61') ? `0${digits.slice(2)}` : digits
}

/** A client as the Clients page's search reads them. */
export type ClientSearchRow = {
  client: {
    name: string
    kind: ClientKind
    abn?: string
    phone?: string
    email?: string
    clientNumber?: number
    tags?: ReadonlyArray<string>
  }
  properties: ReadonlyArray<{
    addressLine: string
    suburb: string
    siteContactName?: string
    siteContactPhone?: string
  }>
  /** A business client's contact people. */
  contacts?: ReadonlyArray<{ name: string; phone?: string; email?: string }>
}

/**
 * The Clients page's search: a client's name, tags, phone and email and its
 * properties' streets and suburbs, and for a business client its ABN, its
 * sites' contacts and its contact people (names, numbers and emails) too
 * (Prompt 6.1, 6.3; the plan's "search first"). Only a business's: a client
 * flipped to person keeps those hidden, and must not turn up for a number
 * nobody can see on it.
 *
 * ABNs and phone numbers match on their digits, spaced or not: "51 824 753
 * 556" and "51824753556" both find the one stored as digits, and
 * "0412345678" or "+61 412 345 678" a number saved as "0412 345 678". A
 * whole number (`queryShape`) is also compared as a key, as the matcher
 * compares it, under the business's area code: "08 9345 6789" finds one
 * saved as "9345 6789", which its digits never could.
 */
export function matchesClientSearch(
  row: ClientSearchRow,
  term: string,
  /** The business's area code (`areaCodeOf` its state), for a local
   * number typed or saved without one. Perth's when not given. */
  areaCode = '08',
): boolean {
  const query = term.trim().toLowerCase()
  if (query === '') return true

  const { client, properties } = row
  const business = client.kind === 'business'
  // A client number, typed as "#1916" or "1916". Bare, it may also be part
  // of someone's phone: `searchClientRows` lists the client with that number
  // alone.
  const asNumber = /^#\s*(\d+)$/.exec(query) ?? /^(\d{1,4})$/.exec(query)
  if (asNumber && Number(asNumber[1]) === client.clientNumber) return true
  const siteContacts = properties.flatMap((p) => {
    const contact = siteContactOf({
      clientKind: client.kind,
      siteContactName: p.siteContactName,
      siteContactPhone: p.siteContactPhone,
    })
    return contact ? [contact] : []
  })
  const contacts = business ? (row.contacts ?? []) : []

  const haystack = [
    client.name,
    client.email ?? '',
    ...(client.tags ?? []),
    ...properties.flatMap((p) => [p.addressLine, p.suburb]),
    ...siteContacts.map((c) => c.name ?? ''),
    ...contacts.flatMap((c) => [c.name, c.email ?? '']),
  ]
    .join(' ')
    .toLowerCase()
  if (haystack.includes(query)) return true

  // Numbers only by their digits, and never as text: "12" would otherwise
  // find every site whose phone number has a 12 in it.
  if (!/^[\d\s()+.-]+$/.test(query)) return false
  const digits = digitsOf(query)
  if (digits.length < MIN_NUMBER_DIGITS) return false

  // An ABN is read out and typed from the front.
  if (business && client.abn?.startsWith(digits)) return true

  const phones = [
    client.phone,
    ...siteContacts.map((c) => c.phone),
    ...contacts.map((c) => c.phone),
  ].filter((phone): phone is string => phone !== undefined && phone !== '')

  // A whole number, as a key: the area code a local one was saved without.
  if (queryShape(query, areaCode) === 'phone') {
    const typed = new Set(phoneKeys(query, areaCode))
    if (
      typed.size > 0 &&
      phones.some((phone) =>
        phoneKeys(phone, areaCode).some((key) => typed.has(key)),
      )
    ) {
      return true
    }
  }

  // A phone number is compared as dialled at home. Read as +61 only when it
  // plainly is one: a Perth postcode like 6147 is also how "+61 47…" starts,
  // and would bring up every business whose site has an 047 mobile.
  const international =
    query.startsWith('+') || (digits.startsWith('61') && digits.length >= 6)
  const wanted = international ? `0${digits.slice(2)}` : digits
  return phones.some((phone) => nationalDigits(phone).includes(wanted))
}

/**
 * The rows the Clients page's search finds (`matchesClientSearch`), in the
 * order given. A client number typed bare ("2041") that is a client's finds
 * that client alone: four digits are in many a phone number (0420 418 888),
 * and once phones are searched, every client whose number held them would
 * come too. "#2041" is always the number; "0478", written as no client
 * number is, is still the start of a mobile.
 */
export function searchClientRows<T extends ClientSearchRow>(
  rows: ReadonlyArray<T>,
  term: string,
  areaCode = '08',
): Array<T> {
  const typed = term.trim()
  if (/^[1-9]\d{0,3}$/.test(typed)) {
    const numbered = rows.filter(
      (row) => row.client.clientNumber === Number(typed),
    )
    if (numbered.length > 0) return numbered
  }
  return rows.filter((row) => matchesClientSearch(row, term, areaCode))
}

/** What the four filters are set to. `'all'` is a filter that is not set. */
export type ClientFilterValues = {
  kind: KindFilter
  suburb: string
  status: StatusFilter
  tag: string
}

/** Each filter left at its default. */
export const NO_CLIENT_FILTERS: ClientFilterValues = {
  kind: 'all',
  suburb: 'all',
  status: 'all',
  tag: 'all',
}

/**
 * The client types as the address names them: as they are said, rather than
 * the schema's `person` and `business`, so a shared link reads as what it
 * shows.
 */
export const CLIENT_TYPE_PARAMS = ['residential', 'commercial'] as const
export type ClientTypeParam = (typeof CLIENT_TYPE_PARAMS)[number]
const KIND_OF_PARAM: Record<ClientTypeParam, ClientKind> = {
  residential: 'person',
  commercial: 'business',
}
const PARAM_OF_KIND: Record<ClientKind, ClientTypeParam> = {
  person: 'residential',
  business: 'commercial',
}

export const CLIENT_STATUS_PARAMS = ['active', 'lead', 'inactive'] as const

/** The filters as the Clients page's address holds them, each left out at
 * its default. */
export type ClientFilterSearch = {
  type?: ClientTypeParam
  status?: (typeof CLIENT_STATUS_PARAMS)[number]
  tag?: string
  suburb?: string
}

/** What the address asks for, as the four filters' values. */
export function clientFilterValuesOf(
  search: ClientFilterSearch,
): ClientFilterValues {
  return {
    kind: search.type ? KIND_OF_PARAM[search.type] : 'all',
    status: search.status ?? 'all',
    tag: search.tag?.trim() || 'all',
    suburb: search.suburb?.trim() || 'all',
  }
}

/** The four filters as the address holds them: a default is left out. */
export function clientFilterSearchOf(
  values: ClientFilterValues,
): ClientFilterSearch {
  return {
    type: values.kind === 'all' ? undefined : PARAM_OF_KIND[values.kind],
    status: values.status === 'all' ? undefined : values.status,
    tag: values.tag === 'all' ? undefined : values.tag,
    suburb: values.suburb === 'all' ? undefined : values.suburb,
  }
}

/** How many of the four are set: the filter icon's badge. */
export function clientFiltersOn(values: ClientFilterValues): number {
  return (
    Number(values.kind !== 'all') +
    Number(values.status !== 'all') +
    Number(values.tag !== 'all') +
    Number(values.suburb !== 'all')
  )
}

/**
 * Type, status, tag and suburb narrowing for the client list — the
 * client-context analogue of `useScheduleFilters`. In the address (`?type=`,
 * `?status=`, `?tag=`, `?suburb=`) beside the search and the sort, as every
 * list's filters are (§5, Filters and views): a filtered list survives a
 * refresh and can be sent to someone. They were local state, lost with the
 * page, until 7 Nov 2026.
 *
 * The values only; `filterClientRows` does the narrowing. Which rows there
 * are to narrow depends on the values: the page opens on its newest clients
 * a page at a time, and any filter set reads every client instead (the
 * directory), so the page has to know the filters before it can ask for the
 * rows they apply to.
 */
export function useClientFilters(
  search: ClientFilterSearch,
  write: (next: ClientFilterSearch) => void,
) {
  const values = clientFilterValuesOf(search)
  const set = (next: Partial<ClientFilterValues>) =>
    write(clientFilterSearchOf({ ...values, ...next }))
  return {
    ...values,
    setKind: (kind: KindFilter) => set({ kind }),
    setSuburb: (suburb: string) => set({ suburb }),
    setStatus: (status: StatusFilter) => set({ status }),
    setTag: (tag: string) => set({ tag }),
    clearFilters: () => write(clientFilterSearchOf(NO_CLIENT_FILTERS)),
    filtersOn: clientFiltersOn(values),
    filtersActive: clientFiltersOn(values) > 0,
  }
}

type FilterableRow = {
  client: {
    kind: ClientKind
    status?: 'active' | 'lead' | 'inactive'
    tags?: ReadonlyArray<string>
  }
  properties: ReadonlyArray<{ suburb: string }>
}

/**
 * What each choice in the filter sheet would show: each section counted
 * among the clients the other three filters let through, so a count is what
 * picking it leaves. `all` is that section's whole.
 */
export function clientFilterCounts(
  rows: ReadonlyArray<FilterableRow>,
  values: ClientFilterValues,
): {
  kinds: Record<KindFilter, number>
  statuses: Record<StatusFilter, number>
  tags: { all: number; each: Array<TagLoad> }
  suburbs: { all: number; each: Array<SuburbLoad> }
} {
  const byKind = filterClientRows(rows, { ...values, kind: 'all' })
  const byStatus = filterClientRows(rows, { ...values, status: 'all' })
  const byTag = filterClientRows(rows, { ...values, tag: 'all' })
  const bySuburb = filterClientRows(rows, { ...values, suburb: 'all' })
  const kinds: Record<KindFilter, number> = {
    all: byKind.length,
    person: 0,
    business: 0,
  }
  for (const row of byKind) kinds[row.client.kind]++
  return {
    kinds,
    statuses: {
      all: byStatus.length,
      ...statusCounts(byStatus.map((row) => row.client)),
    },
    tags: {
      all: byTag.length,
      each: tagsInUse(byTag.map((row) => row.client)),
    },
    suburbs: { all: bySuburb.length, each: computeSuburbLoad(bySuburb) },
  }
}

/** The rows the filters keep: every one set has to match. */
export function filterClientRows<
  T extends {
    client: {
      kind: ClientKind
      status?: 'active' | 'lead' | 'inactive'
      tags?: ReadonlyArray<string>
    }
    properties: ReadonlyArray<{ suburb: string }>
  },
>(
  rows: ReadonlyArray<T>,
  { kind, suburb, status, tag }: ClientFilterValues,
): Array<T> {
  return rows.filter(
    (row) =>
      (kind === 'all' || row.client.kind === kind) &&
      (suburb === 'all' || row.properties.some((p) => p.suburb === suburb)) &&
      // No status is active.
      (status === 'all' || (row.client.status ?? 'active') === status) &&
      (tag === 'all' ||
        (row.client.tags ?? []).some(
          (t) => t.toLowerCase() === tag.toLowerCase(),
        )),
  )
}
