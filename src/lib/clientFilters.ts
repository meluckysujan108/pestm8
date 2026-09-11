import { useState } from 'react'

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

/**
 * Kind + suburb narrowing for the client list — the client-context analogue
 * of `useScheduleFilters`'s status/staff narrowing. Local state, not the URL:
 * mirrors status/staff being ephemeral per-visit while `view`/`q` (durable,
 * "survives a refresh") stay in the route's search params.
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
