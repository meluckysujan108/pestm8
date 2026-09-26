import { nameKey, siteKey } from '../../../convex/lib/clientImport'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ImportClient, ImportSite } from '../../../convex/lib/clientImport'
import type { ExistingIndex, ReviewClient, ReviewStatus } from './types'

/**
 * Between the review and the server: how a reviewed client is filed, and
 * what is sent for it. The server re-checks everything (convex/lib/
 * clientImport.ts `checkImportClient`), so what is sent is the review's
 * values as they stand, with nothing the review alone uses.
 */

/** The issues that count: one about a site already in PestM8 doesn't, as
 * that site isn't sent. */
function liveIssues(client: ReviewClient) {
  return client.issues.filter(
    (issue) =>
      issue.siteIndex === undefined ||
      !client.sites[issue.siteIndex]?.duplicate,
  )
}

/** How the review files a client: the worst of its issues, with "every
 * site already here" between an error and a warning (types.ts). */
export function statusOf(client: ReviewClient): ReviewStatus {
  const issues = liveIssues(client)
  if (issues.some((i) => i.level === 'error')) return 'error'
  if (client.sites.length > 0 && client.sites.every((s) => s.duplicate)) {
    return 'duplicate'
  }
  if (issues.some((i) => i.level === 'warning')) return 'warning'
  if (issues.some((i) => i.level === 'fixed')) return 'fixed'
  return 'ready'
}

/** Whether the client goes in the import: kept in, and nothing stopping it. */
export function importable(client: ReviewClient): boolean {
  if (!client.included) return false
  const status = statusOf(client)
  return status !== 'error' && status !== 'duplicate'
}

const filled = (text: string | undefined) => {
  const value = text?.trim()
  return value ? value : undefined
}

/**
 * A reviewed client as the server takes it: sites already in PestM8 left
 * out, and no blank or undefined fields (Convex takes neither as "none").
 * A person has no contact person, ABN or site contacts — the server drops
 * them too, but they shouldn't be sent.
 */
export function toImportClient(client: ReviewClient): ImportClient {
  const business = client.kind === 'business'
  const sites: Array<ImportSite> = client.sites
    .filter((site) => !site.duplicate)
    .map((site) => {
      const siteContactName = business
        ? filled(site.siteContactName)
        : undefined
      const siteContactPhone = business
        ? filled(site.siteContactPhone)
        : undefined
      const note = filled(site.note)
      return {
        addressLine: site.addressLine.trim(),
        suburb: site.suburb.trim(),
        state: site.state.trim().toUpperCase(),
        postcode: site.postcode.trim(),
        ...(siteContactName ? { siteContactName } : {}),
        ...(siteContactPhone ? { siteContactPhone } : {}),
        ...(note ? { note } : {}),
      }
    })

  const contactPerson = business ? filled(client.contactPerson) : undefined
  const phone = filled(client.phone)
  const email = filled(client.email)
  const abn = business ? filled(client.abn) : undefined
  return {
    key: client.key,
    kind: client.kind,
    name: client.name.trim(),
    ...(contactPerson ? { contactPerson } : {}),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(abn ? { abn } : {}),
    ...(client.existingClientId
      ? { existingClientId: client.existingClientId }
      : {}),
    sites,
  }
}

/**
 * What PestM8 already holds, from `api.clients.list` and
 * `api.properties.list`. An archived client isn't matched: the server won't
 * add sites to one. Of two with one name, the older is matched, as the list
 * comes oldest first.
 */
export function indexExisting(
  clients: Array<{ _id: Id<'clients'>; name: string; archivedAt?: number }>,
  properties: Array<{ addressLine: string; suburb: string; postcode: string }>,
): ExistingIndex {
  const clientsByName = new Map<string, Id<'clients'>>()
  for (const client of clients) {
    if (client.archivedAt !== undefined) continue
    const key = nameKey(client.name)
    if (key && !clientsByName.has(key)) clientsByName.set(key, client._id)
  }
  return {
    clientsByName,
    siteKeys: new Set(properties.map((p) => siteKey(p))),
  }
}

/** The review's counts, for its filter: each status, and every client. */
export function summarise(
  clients: Array<ReviewClient>,
): Record<ReviewStatus | 'all', number> {
  const counts: Record<ReviewStatus | 'all', number> = {
    all: clients.length,
    error: 0,
    duplicate: 0,
    warning: 0,
    fixed: 0,
    ready: 0,
  }
  for (const client of clients) counts[statusOf(client)]++
  return counts
}
