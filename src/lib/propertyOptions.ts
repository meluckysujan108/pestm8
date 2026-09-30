import { siteContactOf } from '../../convex/lib/siteContact'
import { dayKeyOf } from '../../convex/lib/dates'
import { formatJobDate } from '#/lib/format'
import type { ComboboxOption } from '#/components/primitives/Combobox'

/**
 * "Added recently" at the top of a client or property picker: the newest
 * clients added by hand, up to eight, from the last 90 days, each with the
 * day it was added — then everyone, A–Z.
 *
 * A short fixed section above a list that stays alphabetical, rather than the
 * whole list newest first: a new client is usually booked soon after they
 * are added, and everyone else is still where their name puts them.
 * Imported clients go straight into the A–Z list: an import adds hundreds in
 * one minute, and would otherwise fill the section.
 */
export type RecentOptions = {
  /** The business's time zone, for the day each was added. */
  timezone: string
  /** Now, from the page: what "the last 90 days" counts back from. */
  now: number
}

export const RECENT_LIMIT = 8
const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
export const RECENT_GROUP = 'Added recently'
export const EVERYONE_GROUP = 'Everyone, A–Z'

function addedLabel(createdAt: number, recent: RecentOptions): string {
  return `Added ${formatJobDate(
    dayKeyOf(createdAt, recent.timezone),
    dayKeyOf(recent.now, recent.timezone),
  )}`
}

/**
 * The newest `RECENT_LIMIT` of `items` added by hand in the window, newest
 * first, as a set of keys — or none when `recent` is not given.
 */
function newest<T>(
  items: ReadonlyArray<T>,
  recent: RecentOptions | undefined,
  facts: (item: T) => {
    key: string
    createdAt?: number
    imported: boolean
    archived: boolean
  },
): Array<{ key: string; createdAt: number }> {
  if (!recent) return []
  const since = recent.now - RECENT_WINDOW_MS
  return items
    .map(facts)
    .filter(
      (f): f is typeof f & { createdAt: number } =>
        f.createdAt !== undefined &&
        f.createdAt >= since &&
        !f.imported &&
        !f.archived,
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RECENT_LIMIT)
}

/** The fields of a `properties.list` row the picker needs. */
export type PickableProperty = {
  _id: string
  addressLine: string
  suburb: string
  postcode: string
  /** When the site was added, and whether by an import — for "Added
   * recently". Absent on rows from a backend older than the section. */
  createdAt?: number
  importId?: string
  /** The import it came from, kept after an Undo clears `importId`. */
  importedFrom?: string
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
  recent?: RecentOptions,
): Array<ComboboxOption> {
  const top = newest(properties, recent, (p) => ({
    key: p._id,
    createdAt: p.createdAt,
    imported: p.importId !== undefined || p.importedFrom !== undefined,
    archived: Boolean(p.client?.archivedAt),
  }))
  const topAt = new Map(top.map((t) => [t.key, t.createdAt]))
  const option = (p: PickableProperty): ComboboxOption => {
    const base = propertyOption(p)
    const addedAt = topAt.get(p._id)
    if (top.length === 0) return base
    return addedAt === undefined
      ? { ...base, group: EVERYONE_GROUP }
      : { ...base, group: RECENT_GROUP, detail: addedLabel(addedAt, recent!) }
  }
  const byId = new Map(properties.map((p) => [p._id, p]))
  return [
    ...top.map((t) => option(byId.get(t.key)!)),
    ...alphabetical(properties.filter((p) => !topAt.has(p._id))).map(option),
  ]
}

/** Archived clients last, then by client name and street. */
function alphabetical(
  properties: ReadonlyArray<PickableProperty>,
): Array<PickableProperty> {
  return [...properties].sort((a, b) => {
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
}

/** One site as a picker row. */
function propertyOption(p: PickableProperty): ComboboxOption {
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
    /** For "Added recently", as `PickableProperty`'s. */
    createdAt?: number
    importId?: string
    importedFrom?: string
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
  recent?: RecentOptions,
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
  const top = newest(
    [...byClient.entries()],
    recent,
    ([clientId, { client }]) => ({
      key: clientId,
      createdAt: client.createdAt,
      imported:
        client.importId !== undefined || client.importedFrom !== undefined,
      archived: Boolean(client.archivedAt),
    }),
  )
  const topAt = new Map(top.map((t) => [t.key, t.createdAt]))
  const grouped = (option: ComboboxOption): ComboboxOption => {
    if (top.length === 0) return option
    const addedAt = topAt.get(option.value)
    return addedAt === undefined
      ? { ...option, group: EVERYONE_GROUP }
      : { ...option, group: RECENT_GROUP, detail: addedLabel(addedAt, recent!) }
  }
  const options = [...byClient.entries()]
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
    .map(grouped)
  // The newest first, in their own order; everyone else stays A–Z.
  const first = top.flatMap((t) => options.find((o) => o.value === t.key) ?? [])
  return [...first, ...options.filter((o) => !topAt.has(o.value))]
}
