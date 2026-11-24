import { describe, expect, test } from 'vitest'
import { LEFT_ON_PHONE } from '#/lib/outbox/book'
import { itemFor } from '#/lib/outbox/outboxStore.fixtures'
import {
  asKept,
  bookingFromForm,
  formFromBooking,
  offersNewSite,
  unsentLocalId,
  unsentSites,
  unsentStatus,
  unsentValue,
} from './newJobEdit'
import type { ClientKind } from '#/components/clients/NewClientFields'
import type { BookingArgs, SendableBooking } from '#/lib/outbox/outboxItem'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * An Edit of a booking on the phone opens New Job on exactly what it would
 * book again (plan part 2c §10.3): for every way in, the form made from the
 * booking books the booking it was made from, while nothing is changed
 * (`bookingArgs(initialFrom(item)) ≡ item.booking`).
 */

const TZ = 'Australia/Perth'
const B = 'b1' as Id<'businesses'>

function booking(extra: Partial<SendableBooking>): SendableBooking {
  return {
    businessId: B,
    property: { propertyId: 'p1' as Id<'properties'> },
    assignedMembershipId: 'm1' as Id<'memberships'>,
    jobType: 'General Pest Control',
    price: 18_000,
    scheduledAt: Date.UTC(2026, 9, 27, 1, 30),
    durationMinutes: 90,
    repeat: null,
    ...extra,
  }
}

/** The form opened on it, booked as it opened (`useJobTimes` books the
 * length it opened with while neither time changes). */
function roundTrip(
  original: SendableBooking,
  clientKind?: ClientKind,
): SendableBooking {
  const form = formFromBooking(original, { timezone: TZ, businessState: 'WA' })
  return bookingFromForm(form, {
    businessId: B,
    timezone: TZ,
    durationMinutes: form.length,
    clientKind,
  })
}

describe('an Edit’s form, booked unchanged, is the booking it opened on', () => {
  test('an existing site, every field filled', () => {
    const original = booking({
      jobType: 'General Pest Control, Termite Inspection',
      price: 1_999,
      workOrder: 'WO-1182',
      notes: 'Ring first',
      alsoGoing: ['m2' as Id<'memberships'>, 'm3' as Id<'memberships'>],
    })
    expect(roundTrip(original)).toEqual(original)
  })

  test('an existing site, nothing but what must be: no price, no note', () => {
    const original = booking({ price: 0 })
    const form = formFromBooking(original, {
      timezone: TZ,
      businessState: 'WA',
    })
    expect(form.mode).toBe('existing')
    expect(form.price).toBe('')
    expect(form.notes).toBe('')
    expect(roundTrip(original)).toEqual(original)
  })

  test('a new site for a business client, with its site contact', () => {
    const original = booking({
      property: {
        newProperty: {
          clientId: 'c1' as Id<'clients'>,
          addressLine: '12 Hay St',
          suburb: 'Perth',
          state: 'WA',
          postcode: '6000',
          addressCheck: 'picked',
          siteContactName: 'Sam Lee',
          siteContactPhone: '0400 111 222',
        },
      },
    })
    const form = formFromBooking(original, {
      timezone: TZ,
      businessState: 'WA',
    })
    expect(form.mode).toBe('site')
    expect(form.siteClientId).toBe('c1')
    expect(roundTrip(original, 'business')).toEqual(original)
  })

  test('a new site for a person, typed', () => {
    const original = booking({
      property: {
        newProperty: {
          clientId: 'c2' as Id<'clients'>,
          addressLine: '3 Bay Rd',
          suburb: 'Fannie Bay',
          state: 'NT',
          postcode: '0820',
          addressCheck: 'typed',
        },
      },
    })
    expect(roundTrip(original, 'person')).toEqual(original)
  })

  test('a new client, a person', () => {
    const original = booking({
      property: {
        newClient: {
          clientName: 'Jane Nguyen',
          kind: 'person',
          addressLine: '1 Hay St',
          suburb: 'Perth',
          state: 'WA',
          postcode: '6000',
          addressCheck: 'typed',
          phone: '0400 000 000',
          email: 'jane@example.com',
        },
      },
    })
    const form = formFromBooking(original, {
      timezone: TZ,
      businessState: 'WA',
    })
    expect(form.mode).toBe('new')
    expect(roundTrip(original)).toEqual(original)
  })

  test('a new client, a business with an ABN, contact person and site contact', () => {
    const original = booking({
      property: {
        newClient: {
          clientName: 'Harbour Strata',
          kind: 'business',
          addressLine: '9 Esplanade',
          suburb: 'Darwin City',
          state: 'NT',
          postcode: '0800',
          addressCheck: 'picked',
          phone: '08 8900 0000',
          email: undefined,
          abn: '51 824 753 556',
          contactPerson: 'Priya Shah',
          siteContactName: 'Front desk',
          siteContactPhone: '08 8900 0001',
        },
      },
    })
    expect(roundTrip(original)).toEqual(original)
  })

  test('a Recurring Job, its interval as booked', () => {
    for (const repeat of [
      { count: 3, unit: 'month' as const },
      { count: 2, unit: 'week' as const },
      { count: 1, unit: 'year' as const },
    ]) {
      const original = booking({ repeat, notes: 'First visit only' })
      const form = formFromBooking(original, {
        timezone: TZ,
        businessState: 'WA',
      })
      expect(form.repeats).toBe(true)
      expect(form.interval).toEqual({
        count: String(repeat.count),
        unit: repeat.unit,
      })
      expect(roundTrip(original)).toEqual(original)
    }
  })

  test('its day and times as the business’s clock reads them, and a length past midnight kept', () => {
    const original = booking({
      scheduledAt: Date.UTC(2026, 9, 27, 14, 0), // 10:00pm in Perth
      durationMinutes: 180,
    })
    const form = formFromBooking(original, {
      timezone: TZ,
      businessState: 'WA',
    })
    expect(form.day).toBe('2026-10-27')
    expect(form.start).toBe('22:00')
    expect(form.end).toBe('01:00')
    expect(roundTrip(original)).toEqual(original)
  })
})

describe('a client or site not sent yet (2c-I)', () => {
  const newClient = {
    newClient: {
      clientName: 'Jane Nguyen',
      kind: 'person' as const,
      addressLine: '1 Hay St',
      suburb: 'Perth',
      state: 'WA',
      postcode: '6000',
    },
  }

  test('picked, it is booked as `{ local }`, and an Edit of it opens on that one again (D-I4)', () => {
    const value = unsentValue('local-1')
    expect(unsentLocalId(value)).toBe('local-1')
    expect(unsentLocalId('p1')).toBeNull()
    const form = formFromBooking(
      { ...booking({}), property: { local: 'local-1' } },
      { timezone: TZ, businessState: 'WA' },
    )
    expect(form.mode).toBe('existing')
    expect(form.propertyId).toBe(value)
    const original: BookingArgs = {
      ...booking({}),
      property: { local: 'local-1' },
    }
    const opened = formFromBooking(original, {
      timezone: TZ,
      businessState: 'WA',
    })
    const booked = bookingFromForm(opened, {
      businessId: B,
      timezone: TZ,
      durationMinutes: opened.length,
      clientKind: undefined,
    })
    expect(asKept(booked)).toEqual(original)
    // A site in the client list is booked as it always was.
    expect(asKept(booking({}))).toEqual(booking({}))
  })

  test('offered: this business’s bookings not sent yet that make a client or site, newest first; one level only', () => {
    const first = itemFor(
      'u1',
      { booking: { ...booking({}), property: newClient } },
      1_000,
    )
    const second = itemFor(
      'u1',
      {
        booking: {
          ...booking({}),
          property: {
            newProperty: {
              clientId: 'c1' as Id<'clients'>,
              addressLine: '3 Bay Rd',
              suburb: 'Fannie Bay',
              state: 'NT',
              postcode: '0820',
            },
          },
        },
      },
      2_000,
    )
    const atSite = itemFor('u1', {}, 3_000)
    const onFirst = itemFor(
      'u1',
      {
        booking: { ...booking({}), property: { local: first.localId } },
        dependsOn: first.localId,
      },
      4_000,
    )
    const sent = itemFor(
      'u1',
      { booking: { ...booking({}), property: newClient }, state: 'sent' },
      5_000,
    )
    const all = [first, second, atSite, onFirst, sent]
    expect(unsentSites(all).map((i) => i.localId)).toEqual([
      second.localId,
      first.localId,
    ])
    // Chosen, and sent since, while the form is open: still the one.
    expect(unsentSites(all, undefined, sent.localId)).toContain(sent)
    // An Edit never offers the booking itself, nor any to one others are
    // made on.
    expect(unsentSites(all, second).map((i) => i.localId)).toEqual([
      first.localId,
    ])
    expect(unsentSites(all, first)).toEqual([])
  })

  test('never one New Job sent straight and couldn’t take off the phone (`LEFT_ON_PHONE`), which may already be booked: unless it is the one chosen', () => {
    const left = itemFor(
      'u1',
      {
        booking: { ...booking({}), property: newClient },
        state: 'needsLook',
        problem: { code: LEFT_ON_PHONE },
      },
      2_000,
    )
    const refused = itemFor(
      'u1',
      {
        booking: { ...booking({}), property: newClient },
        state: 'needsLook',
        problem: { code: 'SERVER' },
      },
      1_000,
    )
    expect(unsentSites([left, refused])).toEqual([refused])
    expect(unsentSites([left, refused], undefined, left.localId)).toEqual([
      left,
      refused,
    ])
  })

  test('the one chosen stays offered whatever has become of it while it is on the phone: an Edit of one made on it opens on it (D-I4)', () => {
    const parent = itemFor(
      'u1',
      { booking: { ...booking({}), property: newClient } },
      1_000,
    )
    const onIt = itemFor(
      'u1',
      {
        booking: { ...booking({}), property: { local: parent.localId } },
        dependsOn: parent.localId,
      },
      2_000,
    )
    // Sent (before this page load, or while the form was open).
    const sent = { ...parent, state: 'sent' as const, sentAt: 5_000 }
    expect(unsentSites([sent, onIt], onIt, parent.localId)).toEqual([sent])
    // Changed since to book at a site in the client list: that is where
    // the one made on it goes, and the form still opens on it.
    const moved = {
      ...parent,
      booking: { ...booking({}), property: { propertyId: 'p9' } },
    } as typeof parent
    expect(unsentSites([moved, onIt], onIt, parent.localId)).toEqual([moved])
    // Not chosen: neither is offered.
    expect(unsentSites([sent, moved], undefined, null)).toEqual([])
  })

  test('one sent while the form is open stays where it was, chosen or not, so no row under it moves; one sent before it opened goes', () => {
    const opened = 10_000
    const make = (createdAt: number, extra: Parameters<typeof itemFor>[1]) =>
      itemFor(
        'u1',
        { booking: { ...booking({}), property: newClient }, ...extra },
        createdAt,
      )
    const waitingOne = make(1_000, {})
    const sentNow = make(2_000, { state: 'sent', sentAt: opened + 5 })
    const sentBefore = make(3_000, { state: 'sent', sentAt: opened - 5 })
    const all = [waitingOne, sentNow, sentBefore]
    expect(
      unsentSites(all, undefined, null, opened).map((i) => i.localId),
    ).toEqual([sentNow.localId, waitingOne.localId])
    // Asked without the form's opening (whether there is anything to pick
    // at all): only those not sent yet.
    expect(unsentSites(all).map((i) => i.localId)).toEqual([waitingOne.localId])
  })

  test('the one chosen, made on another since (another tab’s Edit), is no longer offered: nothing can be made on it', () => {
    const other = itemFor(
      'u1',
      { booking: { ...booking({}), property: newClient } },
      1_000,
    )
    const chosen = itemFor(
      'u1',
      {
        booking: { ...booking({}), property: { local: other.localId } },
        dependsOn: other.localId,
      },
      2_000,
    )
    expect(unsentSites([other, chosen], undefined, chosen.localId)).toEqual([
      other,
    ])
  })

  test('an Edit of one whose site has been deleted (NOT_FOUND) opens on no site, to choose another, never on the one it was made on', () => {
    const original: BookingArgs = {
      ...booking({}),
      property: { local: 'local-1' },
    }
    const form = formFromBooking(original, {
      timezone: TZ,
      businessState: 'WA',
      siteGone: true,
    })
    expect(form.mode).toBe('existing')
    expect(form.propertyId).toBe('')
    // A site in the client list opens on it as ever: the form drops it
    // once the client list no longer has it.
    expect(
      formFromBooking(booking({}), {
        timezone: TZ,
        businessState: 'WA',
        siteGone: true,
      }).propertyId,
    ).toBe('p1')
  })

  test('where each stands, for the words under it: being sent never reads as not sent, and sent says whether it was while the form was open', () => {
    const opened = 10_000
    const at = (extra: Parameters<typeof itemFor>[1]) =>
      unsentStatus(itemFor('u1', extra), opened)
    expect(at({ state: 'waiting' })).toBe('unsent')
    expect(at({ state: 'needsLook', problem: { code: 'SERVER' } })).toBe(
      'unsent',
    )
    expect(at({ state: 'sending' })).toBe('sending')
    // New Job sent it straight and couldn't take it off: it may already be
    // booked, so never "Not sent yet" (D11).
    expect(at({ state: 'needsLook', problem: { code: LEFT_ON_PHONE } })).toBe(
      'look',
    )
    expect(at({ state: 'sent', sentAt: opened + 1 })).toBe('sentNow')
    expect(at({ state: 'sent', sentAt: opened - 1 })).toBe('sent')
    expect(at({ state: 'sent', sentAt: null })).toBe('sent')
  })
})

describe('“New site for an existing client” (`offersNewSite`)', () => {
  test('drawn as the form opens only where the client list has someone to choose (§7: never one booked on the phone and not sent yet); once drawn, kept', () => {
    // Opened with clients: drawn, in every mode, whatever comes after.
    expect(offersNewSite(true, { clients: 3, mode: 'existing' })).toBe(true)
    expect(offersNewSite(true, { clients: 0, mode: 'existing' })).toBe(true)
    // Opened with none: not drawn while there are none.
    expect(offersNewSite(false, { clients: 0, mode: 'existing' })).toBe(false)
    expect(offersNewSite(false, { clients: 0, mode: 'new' })).toBe(false)
  })

  test('a business’s first client, sent while New Job is open on Existing client, never puts it in above the fields under a thumb; it comes with the next change of mode', () => {
    // Open on "Jane Nguyen — Not sent yet"; Jane is sent, and the client
    // list has her.
    expect(offersNewSite(false, { clients: 1, mode: 'existing' })).toBe(false)
    // On New client or New site for (a client added meanwhile included),
    // where the link isn't drawn: it comes, so Existing client has it.
    expect(offersNewSite(false, { clients: 1, mode: 'new' })).toBe(true)
    expect(offersNewSite(false, { clients: 1, mode: 'site' })).toBe(true)
  })
})
