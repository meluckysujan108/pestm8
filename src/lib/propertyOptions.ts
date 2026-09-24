import type { ComboboxOption } from '#/components/primitives/Combobox'

/** The fields of a `properties.list` row the picker needs. */
export type PickableProperty = {
  _id: string
  addressLine: string
  suburb: string
  postcode: string
  client: {
    name: string
    phone?: string
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
 * looking at when someone rings to book.
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
      return {
        value: p._id,
        label: `${name} — ${p.addressLine}, ${p.suburb}`,
        searchText: [
          clientName(p),
          p.addressLine,
          p.suburb,
          p.postcode,
          phoneForms(p.client?.phone),
        ].join(' '),
      }
    })
}

/**
 * The client's number as digits, in both the ways an Australian number gets
 * written — 0412 345 678 and +61 412 345 678 — so whichever the office
 * types finds whichever was saved. The phone field is free text.
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
