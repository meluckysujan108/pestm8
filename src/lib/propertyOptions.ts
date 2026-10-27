import { siteContactOf } from '../../convex/lib/siteContact'
import { dayKeyOf } from '../../convex/lib/dates'
import { formatJobDate } from '#/lib/format'
import { withSearchKeys } from '#/lib/searchMatch'
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

/**
 * A–Z as a person reads it: case and accents aside, and numbers by their
 * value ("2 Hay St" before "10 Hay St"). One collator for every sort, made
 * once: `localeCompare` with options builds one per call, ten thousand
 * times over for a big book.
 */
const AZ = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

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

/** A contact person of a business client, as the pickers search them. */
export type PickableContact = {
  name: string
  phone?: string
  email?: string
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
  /** Either of those, as `clients.directory` sends it: a flag, not the id. */
  imported?: boolean
  /** The site's own contact (Prompt 6.3), counted only for a business client
   * — the same rule as the job card's Call. */
  siteContactName?: string
  siteContactPhone?: string
  client: {
    name: string
    phone?: string
    email?: string
    kind?: 'person' | 'business'
    archivedAt?: number
  } | null
  /** The client's contact people, a business client's only
   * (`sitesWithClients`): an agency's property manager rings from her own
   * mobile. */
  contacts?: ReadonlyArray<PickableContact>
}

/**
 * The options for a "which client, at which address" picker: one per property,
 * because a business client with three sites is three different places to
 * send a technician.
 *
 * Each option is found by the client's name, the street, the suburb, the
 * postcode, the client's phone number — the number the office is usually
 * looking at when someone rings to book — or their email. A business site is
 * also found by its site contact's name and number, and by the business's
 * contact people's names, numbers and emails: the caretaker who rings about
 * the building, or the agency's property manager, is not head office, and
 * may not know the client's name at all.
 *
 * An archived client stays pickable, labelled and listed last. Nothing in the
 * app can unarchive a client yet, and the Clients page hides them, so leaving
 * them out here would make an archive permanent in everything but the
 * database — and the office would type them in again as a new client, giving
 * the same house a second history.
 *
 * Each option's search keys are worked out here, once per build
 * (`withSearchKeys`), not on every keystroke.
 */
export function propertyOptions(
  properties: ReadonlyArray<PickableProperty>,
  recent?: RecentOptions,
): Array<ComboboxOption> {
  const top = newest(properties, recent, (p) => ({
    key: p._id,
    createdAt: p.createdAt,
    imported:
      p.imported === true ||
      p.importId !== undefined ||
      p.importedFrom !== undefined,
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
      AZ.compare(clientName(a), clientName(b)) ||
      AZ.compare(a.addressLine, b.addressLine)
    )
  })
}

/**
 * A client's name as every picker row and action names them: "(archived)"
 * after an archived client's, so one is never offered unmarked ("New site
 * for Sam Wu (archived)").
 */
export function pickerName(client: {
  name: string
  archivedAt?: number
}): string {
  return client.archivedAt ? `${client.name} (archived)` : client.name
}

/** One site as a picker row. */
function propertyOption(p: PickableProperty): ComboboxOption {
  const name = p.client ? pickerName(p.client) : clientName(p)
  // A person client's leftover site contact is hidden everywhere else, so
  // it must not be what makes their house turn up here.
  const site = siteContactOf({
    clientKind: p.client?.kind,
    siteContactName: p.siteContactName,
    siteContactPhone: p.siteContactPhone,
  })
  return withSearchKeys({
    value: p._id,
    label: `${name} — ${p.addressLine}, ${p.suburb}`,
    searchText: [
      clientName(p),
      p.addressLine,
      p.suburb,
      p.postcode,
      phoneForms(p.client?.phone),
      p.client?.email ?? '',
      site?.name ?? '',
      phoneForms(site?.phone),
      contactsText(p.client?.kind, p.contacts),
    ].join(' '),
  })
}

/**
 * A business client's contact people as search text: each one's name, number
 * in both forms and email. None for a person client, whose contacts the app
 * hides (and the directory doesn't send).
 */
function contactsText(
  kind: 'person' | 'business' | undefined,
  contacts: ReadonlyArray<PickableContact> | undefined,
): string {
  if (kind !== 'business' || !contacts) return ''
  return contacts
    .map((c) => [c.name, phoneForms(c.phone), c.email ?? ''].join(' '))
    .join(' ')
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

/** A client as the "whose new site is this" picker needs them
 * (`clientsForPicker`): their own fields, sites and contact people. */
export type PickableClient = {
  _id: string
  name: string
  phone?: string
  email?: string
  kind?: 'person' | 'business'
  archivedAt?: number
  /** For "Added recently", as `PickableProperty`'s. */
  createdAt?: number
  importId?: string
  importedFrom?: string
  imported?: boolean
  /** Oldest first. None for a client with no site yet. */
  sites: ReadonlyArray<{
    addressLine: string
    suburb: string
    siteContactName?: string
    siteContactPhone?: string
  }>
  contacts?: ReadonlyArray<PickableContact>
}

/** Said where a client's suburbs would be, for one with no site yet. */
export const NO_SITES = 'No sites'

/**
 * The options for "whose new site is this" (Prompt 6.3): one per client,
 * from the client list, so a client with no site yet is there, labelled "No
 * sites": the one New site for is most often for.
 *
 * An archived client is still here, labelled and last, as in the Property
 * picker: the office found them there, and turning them away would leave
 * "New client" as the only way on — a second record for the same business.
 * And each option says where the client's sites are, because two clients can
 * share a name, and a new site filed under the wrong one sends its reports
 * and its Call to someone else.
 *
 * Found by the name, the client's number in either form, their email, any of
 * their streets and suburbs, and for a business its sites' contacts and its
 * contact people.
 */
export function clientOptions(
  clients: ReadonlyArray<PickableClient>,
  recent?: RecentOptions,
): Array<ComboboxOption> {
  const top = newest(clients, recent, (client) => ({
    key: client._id,
    createdAt: client.createdAt,
    imported:
      client.imported === true ||
      client.importId !== undefined ||
      client.importedFrom !== undefined,
    archived: Boolean(client.archivedAt),
  }))
  const topAt = new Map(top.map((t) => [t.key, t.createdAt]))
  const grouped = (option: ComboboxOption): ComboboxOption => {
    if (top.length === 0) return option
    const addedAt = topAt.get(option.value)
    return addedAt === undefined
      ? { ...option, group: EVERYONE_GROUP }
      : { ...option, group: RECENT_GROUP, detail: addedLabel(addedAt, recent!) }
  }
  const options = [...clients]
    .sort((a, b) => {
      const archived =
        Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt))
      if (archived !== 0) return archived
      return (
        AZ.compare(a.name, b.name) ||
        AZ.compare(a.sites[0]?.suburb ?? '', b.sites[0]?.suburb ?? '')
      )
    })
    .map((client) => grouped(clientOption(client)))
  // The newest first, in their own order; everyone else stays A–Z.
  const byValue = new Map(options.map((o) => [o.value, o]))
  return [
    ...top.flatMap((t) => byValue.get(t.key) ?? []),
    ...options.filter((o) => !topAt.has(o.value)),
  ]
}

/** One client as a picker row. */
function clientOption(client: PickableClient): ComboboxOption {
  const suburbs = [...new Set(client.sites.map((s) => s.suburb.trim()))].filter(
    Boolean,
  )
  const where =
    client.sites.length === 0
      ? NO_SITES
      : suburbs.length > 2
        ? `${suburbs.slice(0, 2).join(', ')} +${suburbs.length - 2}`
        : suburbs.join(', ')
  const name = pickerName(client)
  // A person client's leftover site contacts are hidden everywhere else.
  const siteContacts = client.sites.flatMap((s) => {
    const contact = siteContactOf({
      clientKind: client.kind,
      siteContactName: s.siteContactName,
      siteContactPhone: s.siteContactPhone,
    })
    return contact ? [contact.name ?? '', phoneForms(contact.phone)] : []
  })
  return withSearchKeys({
    value: client._id,
    label: where ? `${name} — ${where}` : name,
    searchText: [
      client.name,
      phoneForms(client.phone),
      client.email ?? '',
      ...client.sites.flatMap((s) => [s.addressLine, s.suburb]),
      ...siteContacts,
      contactsText(client.kind, client.contacts),
    ].join(' '),
  })
}
