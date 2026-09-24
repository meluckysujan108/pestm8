import { useState } from 'react'
import { siteContactOf } from '../../convex/lib/siteContact'

export type ClientKind = 'person' | 'business'
export type KindFilter = 'all' | ClientKind

export const KIND_OPTIONS: Array<{ value: ClientKind; label: string }> = [
  { value: 'business', label: 'Business' },
  { value: 'person', label: 'Person' },
]

export type SuburbLoad = { suburb: string; count: number }

/**
 * "Which suburbs are my clients in, and how many" — the client-list analogue
 * of `scheduleFilters.ts`'s `computeStaffLoad`. A client with two properties
 * in the same suburb counts once for it; a client with properties in two
 * different suburbs counts once for each, since the filter answers "does
 * this client have work in this suburb", not "how many properties".
 */
export function computeSuburbLoad(
  rows: Array<{ properties: Array<{ suburb: string }> }>,
): Array<SuburbLoad> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const suburbs = new Set(row.properties.map((p) => p.suburb).filter(Boolean))
    for (const suburb of suburbs) {
      counts.set(suburb, (counts.get(suburb) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([suburb, count]) => ({ suburb, count }))
    .sort((a, b) => b.count - a.count || a.suburb.localeCompare(b.suburb))
}

/** Fewer digits than this and a number is more likely a street number, or
 * part of one, than an ABN or a phone: it would bring in clients whose ABN
 * happens to contain it, with nothing on their card to say why. */
const MIN_NUMBER_DIGITS = 4

const digitsOf = (text: string) => text.replace(/\D/g, '')

/** A phone number's digits in both the ways an Australian one is written,
 * 0412 345 678 and +61 412 345 678 — as the New Job picker matches them
 * (propertyOptions.ts). */
function phoneForms(phone: string): Array<string> {
  const digits = digitsOf(phone)
  if (digits.startsWith('61')) return [digits, `0${digits.slice(2)}`]
  if (digits.startsWith('0')) return [digits, `61${digits.slice(1)}`]
  return [digits]
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
    client: { name: string; kind: ClientKind; abn?: string }
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
  const numbers = [
    ...(client.kind === 'business' && client.abn ? [client.abn] : []),
    ...siteContacts.flatMap((c) => (c.phone ? phoneForms(c.phone) : [])),
  ]
  return numbers.some((n) => n.includes(digits))
}

/**
 * Kind + suburb narrowing for the client list — the client-context analogue
 * of `useScheduleFilters`'s status/staff narrowing. Local state, not the URL:
 * mirrors status/staff being ephemeral per-visit while `q` (durable, "survives
 * a refresh") stays in the route's search params.
 */
export function useClientFilters<
  T extends { client: { kind: ClientKind }; properties: Array<{ suburb: string }> },
>(rows: Array<T>) {
  const [kind, setKind] = useState<KindFilter>('all')
  const [suburb, setSuburb] = useState<string>('all')

  const filteredRows = rows.filter(
    (row) =>
      (kind === 'all' || row.client.kind === kind) &&
      (suburb === 'all' || row.properties.some((p) => p.suburb === suburb)),
  )

  return { kind, setKind, suburb, setSuburb, filteredRows }
}
