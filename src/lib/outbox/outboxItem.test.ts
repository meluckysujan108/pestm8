import { afterEach, describe, expect, test, vi } from 'vitest'
import { checkClientRequestId } from '../../../convex/lib/clientRequest'
import {
  OUTBOX_V,
  bookingCall,
  itemFromBooking,
  newRequestId,
  uuidFromBytes,
} from './outboxItem'
import { DISPLAY, bookingFor } from './outboxStore.fixtures'
import type { Id } from '../../../convex/_generated/dataModel'
import type { SendableBooking } from './outboxItem'

/**
 * A kept booking, and the one mapping from what New Job holds to the
 * mutation that books it. New Job's own save goes through `bookingCall`
 * now, so it must send exactly what it sent before, field for field: a field
 * dropped or renamed here is a field every booking loses.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a request id', () => {
  test('is a lower-case v4 UUID, as the server takes them', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()))
    expect(ids.size).toBe(50)
    for (const id of ids) {
      expect(() => checkClientRequestId(id)).not.toThrow()
      expect(id).toBe(id.toLowerCase())
    }
  })

  test('is made from random bytes where randomUUID is missing (before Safari 15.4, or not a secure context)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab),
    })
    const id = newRequestId()
    expect(id).toBe('abababab-abab-4bab-abab-abababababab')
    expect(() => checkClientRequestId(id)).not.toThrow()
  })

  test.each([
    [0x00, '00000000-0000-4000-8000-000000000000'],
    [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ])(
    'sets the version and variant whatever the bytes (all 0x%s)',
    (byte, id) => {
      expect(uuidFromBytes(new Uint8Array(16).fill(byte))).toBe(id)
      expect(() => checkClientRequestId(id)).not.toThrow()
    },
  )
})

/**
 * What New Job's save sent until it called `bookingCall`, copied from
 * NewJobSheet.tsx as it was on main at 9b8d547 — written out here, never
 * imported, so a change to the mapping can't change what it is held to.
 */
function sentBefore(args: SendableBooking) {
  const { repeat: recurrence, property, ...job } = args
  return recurrence === null
    ? { fn: 'jobs.create', args: { ...job, ...property } }
    : {
        fn: 'recurrences.create',
        args: {
          businessId: job.businessId,
          ...property,
          assignedMembershipId: job.assignedMembershipId,
          intervalCount: recurrence.count,
          intervalUnit: recurrence.unit,
          jobType: job.jobType,
          price: job.price,
          anchorDate: job.scheduledAt,
          durationMinutes: job.durationMinutes,
          workOrder: job.workOrder,
          notes: job.notes,
        },
      }
}

const SITES: Record<string, SendableBooking['property']> = {
  'an existing site': { propertyId: 'p1' as Id<'properties'> },
  'a new site for an existing client': {
    newProperty: {
      clientId: 'c1' as Id<'clients'>,
      addressLine: '3 Ocean St',
      suburb: 'Scarborough',
      state: 'WA',
      postcode: '6019',
      addressCheck: 'typed',
      siteContactName: 'Front desk',
      siteContactPhone: '08 9000 1111',
    },
  },
  'a new client': {
    newClient: {
      clientName: 'Harbour Strata Pty Ltd',
      kind: 'business',
      addressLine: '12 Marine Pde',
      suburb: 'Cottesloe',
      state: 'WA',
      postcode: '6011',
      addressCheck: 'picked',
      phone: '08 9000 0000',
      email: 'accounts@harbourstrata.com.au',
      abn: '51824753556',
      contactPerson: 'Priya Shah',
      siteContactName: undefined,
      siteContactPhone: undefined,
    },
  },
}

const FILLED = {
  workOrder: 'WO-1182',
  notes: 'Side gate code 4411',
  alsoGoing: ['m2' as Id<'memberships'>],
}
const BLANK = { workOrder: undefined, notes: undefined, alsoGoing: undefined }
const SERIES = { repeat: { count: 3, unit: 'month' as const } }

const cases = Object.entries(SITES).flatMap(([where, property]) =>
  (
    [
      ['a one-off', {}],
      ['a Recurring Job', SERIES],
    ] as const
  ).flatMap(([what, repeat]) =>
    (
      [
        ['everything filled in', FILLED],
        ['nothing optional', BLANK],
      ] as const
    ).map(
      ([how, optional]) =>
        [
          `${what} on ${where}, ${how}`,
          bookingFor({ property, ...optional, ...repeat }) as SendableBooking,
        ] as const,
    ),
  ),
)

describe('the mutation a booking goes as', () => {
  test.each(cases)(
    '%s: exactly what New Job sent before, field for field',
    (_what, booking) => {
      expect(bookingCall(booking)).toStrictEqual(sentBefore(booking))
    },
  )

  test('with nothing more asked, no request id, membership or refuseBackfill goes', () => {
    for (const [, booking] of cases) {
      const { args } = bookingCall(booking)
      expect(args).not.toHaveProperty('clientRequestId')
      expect(args).not.toHaveProperty('asMembership')
      expect(args).not.toHaveProperty('refuseBackfill')
    }
  })

  test('a one-off carries the request id and membership, never refuseBackfill', () => {
    const booking = bookingFor(FILLED) as SendableBooking
    expect(
      bookingCall(booking, {
        clientRequestId: '6f1d3a52-1b2c-4d3e-8f4a-5b6c7d8e9f00',
        asMembership: 'm-u1' as Id<'memberships'>,
        refuseBackfill: true,
      }),
    ).toStrictEqual({
      fn: 'jobs.create',
      args: {
        ...sentBefore(booking).args,
        clientRequestId: '6f1d3a52-1b2c-4d3e-8f4a-5b6c7d8e9f00',
        asMembership: 'm-u1',
      },
    })
  })

  test('a Recurring Job carries all three, and never the people also going', () => {
    const booking = bookingFor({ ...FILLED, ...SERIES }) as SendableBooking
    const call = bookingCall(booking, {
      clientRequestId: '6f1d3a52-1b2c-4d3e-8f4a-5b6c7d8e9f00',
      asMembership: 'm-u1' as Id<'memberships'>,
      refuseBackfill: true,
    })
    expect(call).toStrictEqual({
      fn: 'recurrences.create',
      args: {
        ...sentBefore(booking).args,
        clientRequestId: '6f1d3a52-1b2c-4d3e-8f4a-5b6c7d8e9f00',
        asMembership: 'm-u1',
        refuseBackfill: true,
      },
    })
    expect(call.args).not.toHaveProperty('alsoGoing')
  })

  test('refuseBackfill goes only when asked', () => {
    const booking = bookingFor(SERIES) as SendableBooking
    expect(
      bookingCall(booking, { refuseBackfill: undefined }).args,
    ).not.toHaveProperty('refuseBackfill')
  })
})

describe('an item made from a booking', () => {
  const at = {
    localId: 'local-1',
    requestId: '6f1d3a52-1b2c-4d3e-8f4a-5b6c7d8e9f00',
    userId: 'u1',
    business: { slug: 'pest-co', name: 'Pest Co' },
    membershipId: 'm-u1' as Id<'memberships'>,
    display: DISPLAY,
    now: 5_000,
  }

  test('waits, at this build’s version, with nothing tried yet', () => {
    const booking = bookingFor()
    expect(itemFromBooking(booking, at)).toStrictEqual({
      localId: 'local-1',
      v: OUTBOX_V,
      kind: 'job',
      userId: 'u1',
      businessId: booking.businessId,
      state: 'waiting',
      createdAt: 5_000,
      requestId: '6f1d3a52-1b2c-4d3e-8f4a-5b6c7d8e9f00',
      slug: 'pest-co',
      businessName: 'Pest Co',
      membershipId: 'm-u1',
      booking,
      display: DISPLAY,
      attempts: 0,
      lastAttemptAt: null,
      sentKinds: [],
      serverFailures: 0,
      retryAt: null,
      holdUntil: null,
      problem: null,
      editing: null,
      sessionEndedAt: null,
      confirmedAt: null,
      result: null,
      updatedAt: 5_000,
      sentAt: null,
    })
  })

  test('a repeating booking is a series', () => {
    expect(itemFromBooking(bookingFor(SERIES), at).kind).toBe('series')
  })

  test('one on a client not sent yet waits on the item that makes it', () => {
    const item = itemFromBooking(
      bookingFor({ property: { local: 'local-0' } }),
      at,
    )
    expect(item.dependsOn).toBe('local-0')
    expect(itemFromBooking(bookingFor(), at)).not.toHaveProperty('dependsOn')
  })
})
