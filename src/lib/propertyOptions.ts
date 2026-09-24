import { siteContactOf } from '../../convex/lib/siteContact'
import type { ComboboxOption } from '#/components/primitives/Combobox'

/** The fields of a `properties.list` row the picker needs. */
export type PickableProperty = {
  _id: string
  addressLine: string
  suburb: string
  postcode: string
  /** The site's own contact (Prompt 6.3), counted only for a business client
   * — the same rule as the job card's Call. */
  siteContactName?: string
  siteContactPhone?: string
  client: {
    name: string
    phone?: string
    kind?: 'person' | 'business'
    archivedAt?: number
  } | null
}

/**
 * The options for a "which client, at which address" picker: one per property,
 * because a business client with three sites is three different places to
 * send a technician.
 *
 * Each option is found by the client's name, the street, the suburb, the
 * postcode or the client's phone number — the number the office is usually
 * looking at when someone rings to book. A business site is also found by its
 * site contact's name and number: the caretaker who rings about the building
 * is not head office, and may not know the client's name at all.
 *
 * An archived client stays pickable, labelled and listed last. Nothing in the
 * app can unarchive a client yet, and the Clients page hides them, so leaving
 * them out here would make an archive permanent in everything but the
 * database — and the office would type them in again as a new client, giving
 * the same house a second history.
 */
export function propertyOptions(
  properties: ReadonlyArray<PickableProperty>,
): Array<ComboboxOption> {
  return [...properties]
    .sort((a, b) => {
      const archived =
        Number(Boolean(a.client?.archivedAt)) -
        Number(Boolean(b.client?.archivedAt))
      if (archived !== 0) return archived
      return (
        clientName(a).localeCompare(clientName(b), undefined, {
          sensitivity: 'base',
        }) ||
        a.addressLine.localeCompare(b.addressLine, undefined, {
          sensitivity: 'base',
          numeric: true,
        })
      )
    })
    .map((p) => {
      const name = p.client?.archivedAt
        ? `${clientName(p)} (archived)`
        : clientName(p)
      // A person client's leftover site contact is hidden everywhere else, so
      // it must not be what makes their house turn up here.
      const site = siteContactOf({
        clientKind: p.client?.kind,
        siteContactName: p.siteContactName,
        siteContactPhone: p.siteContactPhone,
      })
      return {
        value: p._id,
        label: `${name} — ${p.addressLine}, ${p.suburb}`,
        searchText: [
          clientName(p),
          p.addressLine,
          p.suburb,
          p.postcode,
          phoneForms(p.client?.phone),
          site?.name ?? '',
          phoneForms(site?.phone),
        ].join(' '),
      }
    })
}

/**
 * A phone number as digits, in both the ways an Australian number gets
 * written — 0412 345 678 and +61 412 345 678 — so whichever the office
 * types finds whichever was saved. Phone fields are free text.
 */
function phoneForms(phone: string | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.startsWith('61')) return `${digits} 0${digits.slice(2)}`
  if (digits.startsWith('0')) return `${digits} 61${digits.slice(1)}`
  return digits
}

function clientName(p: PickableProperty): string {
  return p.client?.name ?? 'Unknown client'
}

/** The fields of a `properties.list` row the client picker needs. */
export type PickableClientSite = {
  clientId: string
  addressLine: string
  suburb: string
  client: {
    name: string
    phone?: string
    kind?: 'person' | 'business'
    archivedAt?: number
  } | null
}

/**
 * The options for "whose new site is this" (Prompt 6.3): one per client,
 * built from the sites already loaded for the Property picker.
 *
 * From the sites rather than the client list, for two reasons. An archived
 * client is still here, labelled and last, as in the Property picker: the
 * office found them there, and turning them away would leave "New client"
 * as the only way on — a second record for the same business. And each
 * option says where the client's sites are, because two clients can share a
 * name, and a new site filed under the wrong one sends its reports and its
 * Call to someone else.
 *
 * Found by the name, the client's number in either form, or any of their
 * streets and suburbs.
 */
export function clientOptions(
  properties: ReadonlyArray<PickableClientSite>,
): Array<ComboboxOption> {
  const byClient = new Map<
    string,
    {
      client: NonNullable<PickableClientSite['client']>
      sites: Array<PickableClientSite>
    }
  >()
  for (const p of properties) {
    if (!p.client) continue
    const entry = byClient.get(p.clientId)
    if (entry) entry.sites.push(p)
    else byClient.set(p.clientId, { client: p.client, sites: [p] })
  }
  return [...byClient.entries()]
    .sort(([, a], [, b]) => {
      const archived =
        Number(Boolean(a.client.archivedAt)) -
        Number(Boolean(b.client.archivedAt))
      if (archived !== 0) return archived
      return (
        a.client.name.localeCompare(b.client.name, undefined, {
          sensitivity: 'base',
        }) ||
        a.sites[0].suburb.localeCompare(b.sites[0].suburb, undefined, {
          sensitivity: 'base',
        })
      )
    })
    .map(([clientId, { client, sites }]) => {
      const suburbs = [...new Set(sites.map((s) => s.suburb.trim()))].filter(
        Boolean,
      )
      const where =
        suburbs.length > 2
          ? `${suburbs.slice(0, 2).join(', ')} +${suburbs.length - 2}`
          : suburbs.join(', ')
      const name = client.archivedAt ? `${client.name} (archived)` : client.name
      return {
        value: clientId,
        label: where ? `${name} — ${where}` : name,
        searchText: [
          client.name,
          phoneForms(client.phone),
          ...sites.flatMap((s) => [s.addressLine, s.suburb]),
        ].join(' '),
      }
    })
}
