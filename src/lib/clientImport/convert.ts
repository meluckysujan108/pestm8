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
    ...(client.clientNumber !== undefined
      ? { clientNumber: client.clientNumber }
      : {}),
    ...(client.status ? { status: client.status } : {}),
    ...(client.tags && client.tags.length > 0 ? { tags: client.tags } : {}),
  }
}

/**
 * What PestM8 already holds, from `api.clients.list` and
 * `api.properties.list`. An archived client isn't matched: the server won't
 * add sites to one. Of two with one name, the older is matched, as the list
 * comes oldest first. Each site also says whose it is, so the review can
 * tell "already yours" from "already on someone else".
 */
export function indexExisting(
  clients: Array<{
    _id: Id<'clients'>
    name: string
    archivedAt?: number
    clientNumber?: number
  }>,
  properties: Array<{
    addressLine: string
    suburb: string
    postcode: string
    clientId?: Id<'clients'>
    /** `properties.list` carries its client; an archived one's too. */
    client?: { name: string } | null
  }>,
): ExistingIndex {
  const clientsByName = new Map<string, Id<'clients'>>()
  const names = new Map<Id<'clients'>, string>()
  // Every client listed; an archived one's number is also kept (the server
  // gives the next free one), which the review just won't warn about.
  const numbers = new Map<number, string>()
  for (const client of clients) {
    names.set(client._id, client.name)
    if (client.clientNumber !== undefined) {
      numbers.set(client.clientNumber, client.name)
    }
    if (client.archivedAt !== undefined) continue
    const key = nameKey(client.name)
    if (key && !clientsByName.has(key)) clientsByName.set(key, client._id)
  }
  const siteKeys = new Set<string>()
  const siteHolders = new Map<string, string>()
  for (const property of properties) {
    const key = siteKey(property)
    siteKeys.add(key)
    const holder =
      property.client?.name ??
      (property.clientId ? names.get(property.clientId) : undefined)
    if (holder && !siteHolders.has(key)) siteHolders.set(key, holder)
  }
  return { clientsByName, siteKeys, siteHolders, numbers }
}

/** Where the review files a client: its status, or "left out" whatever its
 * status — a client the person has set aside isn't still waiting to be
 * fixed. */
export type ReviewBucket = ReviewStatus | 'excluded'

export function bucketOf(client: ReviewClient): ReviewBucket {
  return client.included ? statusOf(client) : 'excluded'
}

/** The review's counts, for its filter: each bucket, and every client. */
export function summarise(
  clients: Array<ReviewClient>,
): Record<ReviewBucket | 'all', number> {
  const counts: Record<ReviewBucket | 'all', number> = {
    all: clients.length,
    error: 0,
    duplicate: 0,
    warning: 0,
    fixed: 0,
    ready: 0,
    excluded: 0,
  }
  for (const client of clients) counts[bucketOf(client)]++
  return counts
}
