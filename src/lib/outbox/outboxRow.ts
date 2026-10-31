import { dayKeyOf } from '../../../convex/lib/dates'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DayRow } from '#/lib/offline/keeper'
import type { DirectorySiteWithClient } from '#/lib/directory'
import type { BookingArgs, OutboxDisplay, OutboxItem } from './outboxItem'

/**
 * A booking on the phone, not sent yet, as its day's list would carry it
 * (`jobs.listDay`'s row), so its card is drawn by `JobCard` itself and its
 * sheet by `KeptJobView`: the card it is now is the card the real job will
 * be, line for line, but for what only the server can say (its number, its
 * status, the note's title). Typed as the day's row, so a change to the
 * row's fields shows here as a type error, as it does for the kept views.
 *
 * Pure: what the card shows is the booking's (time, length, services,
 * price, work order, how often, who, the note) and the snapshot taken when
 * it was saved (`display`: who the client is, how to reach them, where),
 * with the people named and coloured from the team as it is now when the
 * team is in memory, so a colour changed since lands as it will.
 */

/** The team as `memberships.listForBusiness` answers, as far as a card
 * reads it. */
export type RosterPerson = { _id: string; name: string; colour: string }

export type OutboxRowLive = {
  /** Whether the person may see prices (`caps['prices.see']`): the server
   * zeroes a price for anyone else (`redactJob`), and so does this. */
  seesPrices: boolean
  /** The team, when it is in memory. */
  roster?: ReadonlyArray<RosterPerson>
}

/** The day a booking is on, in the business's time zone. */
export function bookingDay(
  item: Pick<OutboxItem, 'booking'>,
  timezone: string,
): string {
  return dayKeyOf(item.booking.scheduledAt, timezone)
}

/** A slot's key: never a real job's id, which a slot may come to draw. */
export function outboxKey(localId: string): string {
  return `outbox:${localId}`
}

export function outboxRow(item: OutboxItem, live: OutboxRowLive): DayRow {
  const { booking, display } = item
  const named = (id: string, listed: { name: string; colour: string }) => {
    const person = live.roster?.find((member) => member._id === id)
    return person
      ? { name: person.name, colour: person.colour }
      : { name: listed.name, colour: listed.colour }
  }
  const lead = named(booking.assignedMembershipId, {
    name: display.assigneeName,
    colour: display.assigneeColour,
  })
  const property = booking.property
  // A Recurring Job takes nobody else yet (`bookingCall`), so its card
  // names its lead alone, as the real visit's will.
  const alsoGoing =
    booking.repeat === null
      ? (booking.alsoGoing ?? []).map((id) => {
          const listed = display.alsoGoing.find((p) => p._id === id)
          return {
            _id: id,
            ...named(
              id,
              listed ?? { name: '', colour: display.assigneeColour },
            ),
          }
        })
      : []
  const row = {
    _id: outboxKey(item.localId) as Id<'jobs'>,
    _creationTime: item.createdAt,
    businessId: booking.businessId,
    // A site the booking makes has no id until the server makes it.
    propertyId: ('propertyId' in property
      ? property.propertyId
      : '') as Id<'properties'>,
    assignedMembershipId: booking.assignedMembershipId,
    jobType: booking.jobType,
    price: live.seesPrices ? booking.price : 0,
    pricesHidden: !live.seesPrices,
    scheduledAt: booking.scheduledAt,
    durationMinutes: booking.durationMinutes,
    // What a booking made by hand starts as: so the card offers what the
    // real one will (`cardActionsFor`), Call, Text, Email and Map.
    status: 'pending' as const,
    createdAt: item.createdAt,
    ...(booking.workOrder !== undefined && { workOrder: booking.workOrder }),
    clientRequestId: item.requestId,
    addressLine: display.addressLine,
    suburb: display.suburb,
    postcode: display.postcode,
    propertyState: display.propertyState,
    clientName: display.clientName,
    clientKind: display.clientKind,
    siteContactName: display.siteContactName,
    siteContactPhone: display.siteContactPhone,
    clientPhone: display.clientPhone,
    clientEmail: display.clientEmail,
    contactPersonName: display.contactPersonName,
    contactPersonPhone: display.contactPersonPhone,
    repeats: booking.repeat ?? undefined,
    assigneeColour: lead.colour,
    assigneeName: lead.name,
    alsoGoing,
    // The note as typed. The real card's is its title and first lines
    // (`jobNotePreview`), which may run a different length.
    notePreview: booking.notes,
  }
  return row satisfies DayRow
}

/**
 * What a booking's card shows that the booking doesn't say, taken as New
 * Job saves it (`OutboxDisplay`): from the client list for a site that
 * exists, from the booking for a client or site made with it, and from the
 * team for who is going.
 */
export function bookingDisplay(
  booking: BookingArgs,
  from: {
    /** Every site with its client (`sitesWithClients`). */
    sites: ReadonlyArray<DirectorySiteWithClient>
    /** The client a new site is for, from the client list. */
    siteClient?: {
      name: string
      kind: 'person' | 'business'
      phone?: string
      email?: string
      clientNumber?: number
    }
    roster: ReadonlyArray<RosterPerson>
    /** The business's own state, for a site whose state the list doesn't
     * carry. */
    businessState: string
    /** The contact person a business client's card names, where the phone
     * can tell (a day it holds lists the site): the client list carries
     * contact people, but not which of them is the one. */
    contactPerson?: { name: string; phone: string }
  },
): OutboxDisplay {
  const person = (id: string) => from.roster.find((m) => m._id === id)
  const lead = person(booking.assignedMembershipId)
  const people = {
    assigneeName: lead?.name ?? '',
    assigneeColour: lead?.colour ?? '',
    alsoGoing: (booking.repeat === null ? (booking.alsoGoing ?? []) : []).map(
      (id) => {
        const p = person(id)
        return { _id: id, name: p?.name ?? '', colour: p?.colour ?? '' }
      },
    ),
  }
  const property = booking.property
  if ('newClient' in property) {
    const c = property.newClient
    return {
      clientName: c.clientName,
      clientKind: c.kind,
      clientPhone: c.phone ?? '',
      clientEmail: c.email ?? '',
      contactPersonName: c.kind === 'business' ? (c.contactPerson ?? '') : '',
      // A contact person typed in with a new client has no number of their
      // own yet.
      contactPersonPhone: '',
      siteContactName: c.siteContactName ?? '',
      siteContactPhone: c.siteContactPhone ?? '',
      addressLine: c.addressLine,
      suburb: c.suburb,
      postcode: c.postcode,
      propertyState: c.state,
      ...people,
    }
  }
  if ('newProperty' in property) {
    const s = property.newProperty
    const client = from.siteClient
    return {
      clientName: client?.name ?? '',
      clientKind: client?.kind,
      ...(client?.clientNumber !== undefined && {
        clientNumber: client.clientNumber,
      }),
      clientPhone: client?.phone ?? '',
      clientEmail: client?.email ?? '',
      contactPersonName: from.contactPerson?.name ?? '',
      contactPersonPhone: from.contactPerson?.phone ?? '',
      siteContactName: s.siteContactName ?? '',
      siteContactPhone: s.siteContactPhone ?? '',
      addressLine: s.addressLine,
      suburb: s.suburb,
      postcode: s.postcode,
      propertyState: s.state,
      ...people,
    }
  }
  const site =
    'propertyId' in property
      ? from.sites.find((p) => p._id === property.propertyId)
      : undefined
  const client = site?.client
  return {
    clientName: client?.name ?? '',
    clientKind: client?.kind,
    ...(client?.clientNumber !== undefined && {
      clientNumber: client.clientNumber,
    }),
    clientPhone: client?.phone ?? '',
    // The client list carries each client's email (since 28 Oct 2026), as
    // the day's row does: so Email is there before the real card lands.
    clientEmail: client?.email ?? '',
    contactPersonName: from.contactPerson?.name ?? '',
    contactPersonPhone: from.contactPerson?.phone ?? '',
    siteContactName: site?.siteContactName ?? '',
    siteContactPhone: site?.siteContactPhone ?? '',
    addressLine: site?.addressLine ?? '',
    suburb: site?.suburb ?? '',
    postcode: site?.postcode ?? '',
    // The client list doesn't say a site's state: the business's own,
    // which is where most of its sites are, and what the forecast falls
    // back to for a card without one.
    propertyState: from.businessState,
    ...people,
  }
}

/**
 * The contact person a business client's card names, as far as the phone
 * can tell before the booking is sent: the one a day it holds lists for
 * that site, or the client's only contact person. None otherwise: the
 * client list doesn't say which of several is the one (`isPrimary`), and a
 * card that named the wrong one would be worse than one naming nobody until
 * the real card lands.
 */
export function contactPersonFor(
  client: { kind: 'person' | 'business' } | undefined,
  contacts: ReadonlyArray<{ name: string; phone?: string }>,
  listed: { contactPersonName?: string; contactPersonPhone?: string } | null,
): { name: string; phone: string } | undefined {
  if (!client || client.kind !== 'business') return undefined
  if (listed?.contactPersonName) {
    return {
      name: listed.contactPersonName,
      phone: listed.contactPersonPhone ?? '',
    }
  }
  if (contacts.length === 1) {
    const only = contacts[0]
    return { name: only.name, phone: only.phone ?? '' }
  }
  return undefined
}
