/**
 * The Clients page's filter choices, worked out from client rows: which
 * suburbs, tags and statuses there are, and how many clients have each.
 *
 * Shared by the page and the server. The page counts the clients a search
 * has found; `clients.overview` counts the whole book for the first screen,
 * which no longer has every client in hand. One definition, so the two can
 * never offer different choices for the same clients.
 */

export type SuburbLoad = { suburb: string; count: number }
export type TagLoad = { tag: string; count: number }
export type StatusCounts = { active: number; lead: number; inactive: number }

export type ClientFacets = {
  suburbs: Array<SuburbLoad>
  tags: Array<TagLoad>
  statuses: StatusCounts
}

/**
 * "Which suburbs are my clients in, and how many" — the client-list analogue
 * of `scheduleFilters.ts`'s `computeStaffLoad`. A client with two properties
 * in the same suburb counts once for it; a client with properties in two
 * different suburbs counts once for each, since the filter answers "does
 * this client have work in this suburb", not "how many properties".
 */
export function computeSuburbLoad(
  rows: ReadonlyArray<{ properties: ReadonlyArray<{ suburb: string }> }>,
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

/** Every tag a business's clients carry, the most used first. */
export function tagsInUse(
  clients: ReadonlyArray<{ tags?: ReadonlyArray<string> }>,
): Array<TagLoad> {
  const counts = new Map<string, TagLoad>()
  for (const client of clients) {
    for (const tag of client.tags ?? []) {
      const key = tag.toLowerCase()
      const entry = counts.get(key)
      if (entry) entry.count++
      else counts.set(key, { tag, count: 1 })
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
  )
}

/** How many clients are in each status. No status is active. */
export function statusCounts(
  clients: ReadonlyArray<{ status?: 'active' | 'lead' | 'inactive' }>,
): StatusCounts {
  const counts: StatusCounts = { active: 0, lead: 0, inactive: 0 }
  for (const client of clients) counts[client.status ?? 'active']++
  return counts
}

/** All three, for one set of rows. */
export function clientFacets(
  rows: ReadonlyArray<{
    client: {
      status?: 'active' | 'lead' | 'inactive'
      tags?: ReadonlyArray<string>
    }
    properties: ReadonlyArray<{ suburb: string }>
  }>,
): ClientFacets {
  const clients = rows.map((row) => row.client)
  return {
    suburbs: computeSuburbLoad(rows),
    tags: tagsInUse(clients),
    statuses: statusCounts(clients),
  }
}
