import { describe, expect, test } from 'vitest'
import { bookingFromForm, formFromBooking } from './newJobEdit'
import type { ClientKind } from '#/components/clients/NewClientFields'
import type { SendableBooking } from '#/lib/outbox/outboxItem'
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
