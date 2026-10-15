import { useState } from 'react'
import { siteContactOf } from '../../convex/lib/siteContact'

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
export { computeSuburbLoad } from '../../convex/lib/clientFacets'
export type { SuburbLoad } from '../../convex/lib/clientFacets'

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

/**
 * The Clients page's search: a client's name and its properties' streets and
 * suburbs, as it always matched, and for a business client its ABN and its
 * sites' contacts too (Prompt 6.1, 6.3). Only a business's: a client flipped
 * to person keeps those hidden, and must not turn up for a number nobody can
 * see on it.
 *
 * ABNs and phone numbers match on their digits, spaced or not: "51 824 753
 * 556" and "51824753556" both find the one stored as digits, and
 * "0412345678" or "+61 412 345 678" a site number saved as "0412 345 678".
 */
export function matchesClientSearch(
  row: {
    client: {
      name: string
      kind: ClientKind
      abn?: string
      clientNumber?: number
      tags?: Array<string>
    }
    properties: Array<{
      addressLine: string
      suburb: string
      siteContactName?: string
      siteContactPhone?: string
    }>
  },
  term: string,
): boolean {
  const query = term.trim().toLowerCase()
  if (query === '') return true

  const { client, properties } = row
  // A client number, typed as "#1916" or "1916": the one client, exactly.
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

  const haystack = [
    client.name,
    ...(client.tags ?? []),
    ...properties.flatMap((p) => [p.addressLine, p.suburb]),
    ...siteContacts.map((c) => c.name ?? ''),
  ]
    .join(' ')
    .toLowerCase()
  if (haystack.includes(query)) return true

  // Numbers only by their digits, and never as text: "12" would otherwise
  // find every site whose phone number has a 12 in it.
  if (!/^[\d\s()+-]+$/.test(query)) return false
  const digits = digitsOf(query)
  if (digits.length < MIN_NUMBER_DIGITS) return false

  // An ABN is read out and typed from the front.
  if (client.kind === 'business' && client.abn?.startsWith(digits)) return true

  // A phone number is compared as dialled at home. Read as +61 only when it
  // plainly is one: a Perth postcode like 6147 is also how "+61 47…" starts,
  // and would bring up every business whose site has an 047 mobile.
  const international =
    query.startsWith('+') || (digits.startsWith('61') && digits.length >= 6)
  const wanted = international ? `0${digits.slice(2)}` : digits
  return siteContacts.some(
    (c) => c.phone !== undefined && nationalDigits(c.phone).includes(wanted),
  )
}

/** What the four filters are set to. `'all'` is a filter that is not set. */
export type ClientFilterValues = {
  kind: KindFilter
  suburb: string
  status: StatusFilter
  tag: string
}

/**
 * Kind + suburb narrowing for the client list — the client-context analogue
 * of `useScheduleFilters`'s status/staff narrowing. Local state, not the URL:
 * mirrors status/staff being ephemeral per-visit while `q` (durable, "survives
 * a refresh") stays in the route's search params.
 *
 * The values only; `filterClientRows` does the narrowing. Which rows there
 * are to narrow depends on the values: the page opens on its newest clients
 * a page at a time, and any filter set reads every client instead (the
 * directory), so the page has to know the filters before it can ask for the
 * rows they apply to.
 */
export function useClientFilters() {
  const [kind, setKind] = useState<KindFilter>('all')
  const [suburb, setSuburb] = useState<string>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [tag, setTag] = useState<string>('all')

  const clearFilters = () => {
    setKind('all')
    setSuburb('all')
    setStatus('all')
    setTag('all')
  }
  const filtersActive =
    kind !== 'all' || suburb !== 'all' || status !== 'all' || tag !== 'all'

  return {
    kind,
    setKind,
    suburb,
    setSuburb,
    status,
    setStatus,
    tag,
    setTag,
    clearFilters,
    filtersActive,
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
