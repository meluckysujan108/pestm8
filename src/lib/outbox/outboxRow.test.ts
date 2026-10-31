import { describe, expect, expectTypeOf, test } from 'vitest'
import {
  bookingDay,
  bookingDisplay,
  contactPersonFor,
  outboxKey,
  outboxRow,
} from './outboxRow'
import { DISPLAY, bookingFor, itemFor } from './outboxStore.fixtures'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DayRow } from '#/lib/offline/keeper'
import type { DirectorySiteWithClient } from '#/lib/directory'
import type { OutboxItem } from './outboxItem'

/**
 * A booking on the phone as its day's list would carry it, so `JobCard`
 * draws it as the card its job will be; and what New Job takes, as it
 * saves, for what that card shows that the booking doesn't say.
 */

const TZ = 'Australia/Perth'
const M_KEV = 'm-kev' as Id<'memberships'>
const M_PRIYA = 'm-priya' as Id<'memberships'>
const ROSTER = [
  { _id: 'm-u1', name: 'Kevin Doyle', colour: '#2563eb' },
  { _id: M_KEV, name: 'Kev Lin', colour: '#16a34a' },
  { _id: M_PRIYA, name: 'Priya Shah', colour: '#9333ea' },
]

function item(extra: Partial<OutboxItem> = {}): OutboxItem {
  return itemFor('u1', extra, Date.UTC(2026, 9, 27, 0))
}

describe('a booking’s card', () => {
  test('is typed as the day’s row, so a field the row gains or loses is a type error here', () => {
    expectTypeOf(outboxRow).returns.toEqualTypeOf<DayRow>()
  })

  test('an existing site: what the booking says, the snapshot for the rest, and the Pending status a booking made by hand starts as', () => {
    const it = item({
      booking: bookingFor({
        workOrder: 'WO-448120',
        notes: 'Ring first',
        alsoGoing: [M_KEV],
      }),
      display: {
        ...DISPLAY,
        alsoGoing: [{ _id: M_KEV, name: 'Kev', colour: '#000000' }],
      },
    })
    const row = outboxRow(it, { seesPrices: true })
    expect(row).toMatchObject({
      _id: outboxKey(it.localId),
      businessId: 'b1',
      propertyId: 'p1',
      jobType: 'General Pest Control',
      price: 18_000,
      pricesHidden: false,
      scheduledAt: it.booking.scheduledAt,
      durationMinutes: 60,
      status: 'pending',
      workOrder: 'WO-448120',
      clientName: 'Jane Nguyen',
      clientPhone: '0400 000 000',
      suburb: 'Perth',
      postcode: '6000',
      propertyState: 'WA',
      assigneeName: 'Kevin',
      assigneeColour: '#2563eb',
      alsoGoing: [{ _id: M_KEV, name: 'Kev', colour: '#000000' }],
      notePreview: 'Ring first',
      clientRequestId: it.requestId,
    })
    expect(row.jobNumber).toBeUndefined()
    expect(row.repeats).toBeUndefined()
  })

  test('its key is never a real job’s id', () => {
    expect(outboxKey('abc')).toBe('outbox:abc')
    expect(outboxRow(item(), { seesPrices: true })._id).toMatch(/^outbox:/)
  })

  test('a price the person may not see is zeroed and marked, as the server does', () => {
    const row = outboxRow(item(), { seesPrices: false })
    expect(row.price).toBe(0)
    expect(row.pricesHidden).toBe(true)
  })

  test('the people are named and coloured from the team as it is now, when it is in memory', () => {
    const it = item({
      booking: bookingFor({ alsoGoing: [M_PRIYA] }),
      display: {
        ...DISPLAY,
        alsoGoing: [{ _id: M_PRIYA, name: 'P', colour: '#111111' }],
      },
    })
    const row = outboxRow(it, { seesPrices: true, roster: ROSTER })
    expect(row.assigneeName).toBe('Kevin Doyle')
    expect(row.alsoGoing).toEqual([
      { _id: M_PRIYA, name: 'Priya Shah', colour: '#9333ea' },
    ])
  })

  test('a Recurring Job says how often, and takes nobody also going', () => {
    const it = item({
      kind: 'series',
      booking: bookingFor({
        repeat: { count: 3, unit: 'month' },
        alsoGoing: [M_KEV],
      }),
    })
    const row = outboxRow(it, { seesPrices: true })
    expect(row.repeats).toEqual({ count: 3, unit: 'month' })
    expect(row.alsoGoing).toEqual([])
  })

  test('a new client or site has no site id yet', () => {
    const it = item({
      booking: bookingFor({
        property: {
          newClient: {
            clientName: 'Sam Wu',
            kind: 'person',
            addressLine: '3 Rose St',
            suburb: 'Morley',
            state: 'WA',
            postcode: '6062',
          },
        },
      }),
    })
    expect(outboxRow(it, { seesPrices: true }).propertyId).toBe('')
  })

  test('the day it is on is the business’s', () => {
    // 5pm on the 27th in UTC is 1am on the 28th in Perth.
    const late = item({
      booking: bookingFor({ scheduledAt: Date.UTC(2026, 9, 27, 17) }),
    })
    expect(bookingDay(late, TZ)).toBe('2026-10-28')
  })
})

describe('what New Job takes as it saves', () => {
  const site: DirectorySiteWithClient = {
    _id: 'p1',
    clientId: 'c1',
    addressLine: '12 Wattle St',
    suburb: 'Bayswater',
    postcode: '6053',
    siteContactName: 'Front desk',
    siteContactPhone: '08 9200 0000',
    createdAt: 1,
    client: {
      _id: 'c1',
      _creationTime: 1,
      name: 'Harbourside Strata',
      kind: 'business',
      phone: '08 9300 0000',
      email: 'office@harbourside.example',
      clientNumber: 2041,
      createdAt: 1,
    },
    contacts: [],
  } as unknown as DirectorySiteWithClient
  const from = {
    sites: [site],
    roster: ROSTER,
    businessState: 'WA',
  }

  test('an existing site: the client and site from the client list, its email included, and the business’s state', () => {
    const display = bookingDisplay(
      bookingFor({ property: { propertyId: 'p1' as Id<'properties'> } }),
      from,
    )
    expect(display).toMatchObject({
      clientName: 'Harbourside Strata',
      clientKind: 'business',
      clientNumber: 2041,
      clientPhone: '08 9300 0000',
      clientEmail: 'office@harbourside.example',
      siteContactName: 'Front desk',
      siteContactPhone: '08 9200 0000',
      addressLine: '12 Wattle St',
      suburb: 'Bayswater',
      postcode: '6053',
      propertyState: 'WA',
      assigneeName: 'Kevin Doyle',
      assigneeColour: '#2563eb',
      contactPersonName: '',
    })
  })

  test('a new client: everything from what was typed, its email included', () => {
    const display = bookingDisplay(
      bookingFor({
        property: {
          newClient: {
            clientName: 'Rose Agency',
            kind: 'business',
            addressLine: '3 Rose St',
            suburb: 'Morley',
            state: 'NT',
            postcode: '0810',
            phone: '0412 345 678',
            email: 'rose@example.com',
            contactPerson: 'Jan Morris',
            siteContactName: 'Gate',
            siteContactPhone: '0499 000 000',
          },
        },
      }),
      from,
    )
    expect(display).toMatchObject({
      clientName: 'Rose Agency',
      clientKind: 'business',
      clientPhone: '0412 345 678',
      clientEmail: 'rose@example.com',
      contactPersonName: 'Jan Morris',
      contactPersonPhone: '',
      siteContactName: 'Gate',
      siteContactPhone: '0499 000 000',
      suburb: 'Morley',
      propertyState: 'NT',
    })
  })

  test('a new site: the client from the client list, the site as typed', () => {
    const display = bookingDisplay(
      bookingFor({
        property: {
          newProperty: {
            clientId: 'c1' as Id<'clients'>,
            addressLine: '9 Bay Rd',
            suburb: 'Fremantle',
            state: 'WA',
            postcode: '6160',
          },
        },
      }),
      {
        ...from,
        siteClient: site.client,
        contactPerson: { name: 'Jan Morris', phone: '0411 111 111' },
      },
    )
    expect(display).toMatchObject({
      clientName: 'Harbourside Strata',
      clientNumber: 2041,
      clientEmail: 'office@harbourside.example',
      contactPersonName: 'Jan Morris',
      contactPersonPhone: '0411 111 111',
      addressLine: '9 Bay Rd',
      suburb: 'Fremantle',
    })
  })

  test('who is also going, a one-off’s only, from the team', () => {
    const one = bookingDisplay(bookingFor({ alsoGoing: [M_PRIYA] }), from)
    expect(one.alsoGoing).toEqual([
      { _id: M_PRIYA, name: 'Priya Shah', colour: '#9333ea' },
    ])
    const series = bookingDisplay(
      bookingFor({ alsoGoing: [M_PRIYA], repeat: { count: 1, unit: 'week' } }),
      from,
    )
    expect(series.alsoGoing).toEqual([])
  })

  describe('the contact person a business’s card names', () => {
    const business = { kind: 'business' as const }
    test('the one a day the phone holds lists for the site', () => {
      expect(
        contactPersonFor(business, [{ name: 'A' }, { name: 'B' }], {
          contactPersonName: 'B',
          contactPersonPhone: '0400 111 222',
        }),
      ).toEqual({ name: 'B', phone: '0400 111 222' })
    })
    test('else the client’s only one', () => {
      expect(
        contactPersonFor(business, [{ name: 'A', phone: '0400 1' }], null),
      ).toEqual({ name: 'A', phone: '0400 1' })
    })
    test('never a guess among several, nor anyone for a person', () => {
      expect(
        contactPersonFor(business, [{ name: 'A' }, { name: 'B' }], null),
      ).toBeUndefined()
      expect(
        contactPersonFor({ kind: 'person' }, [{ name: 'A' }], {
          contactPersonName: 'A',
        }),
      ).toBeUndefined()
    })
  })
})
