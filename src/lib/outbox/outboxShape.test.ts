import { describe, expect, test } from 'vitest'
import { OUTBOX_V } from './outboxItem'
import type { Id } from '../../../convex/_generated/dataModel'
import type {
  BookingArgs,
  OutboxDisplay,
  OutboxItem,
  SendableBooking,
} from './outboxItem'

/**
 * The shape of a booking kept on the phone, held to the OUTBOX_V it was
 * written at.
 *
 * An item can sit on a phone for days, and be read by whatever build the
 * phone runs next, or by the one before after a rollback. A field renamed,
 * removed or added reaches that build in a shape it doesn't expect, and an
 * item it misreads is a booking sent wrong. OUTBOX_V is what tells them
 * apart: a build reads in full only what is at its version or older. So
 * every key path of a fully filled item, and of a booking in each of the
 * ways New Job can make one, is compared with the lists below, written at
 * SHAPE_AT, and the top-level keys of each type are compared by the type
 * checker. A change to any of them fails until OUTBOX_V and these lists
 * change together, and a bump goes in two releases, reader first.
 *
 * Only what these fixtures hold is seen at run time: a field of the server's
 * client or site arguments that New Job doesn't send (a client's status or
 * tags) is not part of what a phone stores, and is left out.
 */

const CHANGED =
  'A kept booking changed shape: bump OUTBOX_V (reader first) and update this list.'

/** The OUTBOX_V the lists below describe. */
const SHAPE_AT = 1

/** True only when the two are the same type. */
type Same<TOne, TOther> =
  (<T>() => T extends TOne ? 1 : 2) extends <T>() => T extends TOther ? 1 : 2
    ? true
    : false

// The type checker's half: each fails `pnpm typecheck` when the type's keys
// change, whatever any fixture holds.
const ITEM_KEYS: Same<
  keyof OutboxItem,
  | 'localId'
  | 'v'
  | 'kind'
  | 'userId'
  | 'businessId'
  | 'state'
  | 'createdAt'
  | 'requestId'
  | 'slug'
  | 'businessName'
  | 'membershipId'
  | 'booking'
  | 'dependsOn'
  | 'display'
  | 'attempts'
  | 'lastAttemptAt'
  | 'sentKinds'
  | 'serverFailures'
  | 'retryAt'
  | 'holdUntil'
  | 'problem'
  | 'editing'
  | 'sessionEndedAt'
  | 'confirmedAt'
  | 'result'
  | 'updatedAt'
  | 'sentAt'
> = true
const BOOKING_KEYS: Same<
  keyof BookingArgs,
  | 'businessId'
  | 'property'
  | 'assignedMembershipId'
  | 'jobType'
  | 'price'
  | 'scheduledAt'
  | 'durationMinutes'
  | 'workOrder'
  | 'notes'
  | 'alsoGoing'
  | 'repeat'
> = true
const DISPLAY_KEYS: Same<
  keyof OutboxDisplay,
  | 'clientName'
  | 'clientKind'
  | 'clientNumber'
  | 'clientPhone'
  | 'clientEmail'
  | 'contactPersonName'
  | 'contactPersonPhone'
  | 'siteContactName'
  | 'siteContactPhone'
  | 'addressLine'
  | 'suburb'
  | 'postcode'
  | 'propertyState'
  | 'assigneeName'
  | 'assigneeColour'
  | 'alsoGoing'
> = true

/** Every key path in `value`: `[]` is an item of a list. Sorted. A key whose
 * value is `undefined` is left out, as IndexedDB keeps it but nothing reads
 * it. */
function keyPaths(value: unknown, at = '', into = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) keyPaths(item, `${at}[]`, into)
    return into
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (inner === undefined) continue
      const path = at === '' ? key : `${at}.${key}`
      into.add(path)
      keyPaths(inner, path, into)
    }
  }
  return into
}

const sorted = (paths: Set<string>) => [...paths].sort()

const M = (id: string) => id as Id<'memberships'>

/** Everything a one-off booking can hold but its site. */
const JOB = {
  businessId: 'b1' as Id<'businesses'>,
  assignedMembershipId: M('m1'),
  jobType: 'General Pest Control, Termite inspection',
  price: 18_000,
  scheduledAt: 1_790_000_000_000,
  durationMinutes: 90,
  workOrder: 'WO-1182',
  notes: 'Side gate code 4411',
  alsoGoing: [M('m2')],
} satisfies Omit<Required<BookingArgs>, 'property' | 'repeat'>

/** A new business client, every field New Job sends for one. */
const NEW_CLIENT = {
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
    siteContactName: 'Tom (caretaker)',
    siteContactPhone: '0400 111 222',
  },
} satisfies SendableBooking['property']

const NEW_SITE = {
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
} satisfies SendableBooking['property']

const DISPLAY = {
  clientName: 'Harbour Strata Pty Ltd',
  clientKind: 'business',
  clientNumber: 1042,
  clientPhone: '08 9000 0000',
  clientEmail: 'accounts@harbourstrata.com.au',
  contactPersonName: 'Priya Shah',
  contactPersonPhone: '0400 333 444',
  siteContactName: 'Tom (caretaker)',
  siteContactPhone: '0400 111 222',
  addressLine: '12 Marine Pde',
  suburb: 'Cottesloe',
  postcode: '6011',
  propertyState: 'WA',
  assigneeName: 'Kevin Tran',
  assigneeColour: '#2563eb',
  alsoGoing: [{ _id: M('m2'), name: 'Sam Lee', colour: '#16a34a' }],
} satisfies Required<OutboxDisplay>

/** Every field filled, as no one item ever is. */
const FULL_ITEM = {
  localId: 'local-1',
  v: 1,
  kind: 'series',
  userId: 'u1',
  businessId: 'b1' as Id<'businesses'>,
  state: 'sent',
  createdAt: 1_789_990_000_000,
  requestId: '6f1d3a52-1b2c-4d3e-8f4a-5b6c7d8e9f00',
  slug: 'pest-co',
  businessName: 'Pest Co',
  membershipId: M('m1'),
  booking: {
    ...JOB,
    property: NEW_CLIENT,
    repeat: { count: 3, unit: 'month' },
  },
  dependsOn: 'local-0',
  display: DISPLAY,
  attempts: 2,
  lastAttemptAt: 1_789_990_100_000,
  sentKinds: ['job', 'series'],
  serverFailures: 1,
  retryAt: 1_789_990_160_000,
  holdUntil: 1_789_990_130_000,
  problem: { code: 'INVALID_ASSIGNEE' },
  editing: { tab: 'tab-1', until: 1_789_990_700_000 },
  sessionEndedAt: 1_789_990_200_000,
  confirmedAt: 1_789_990_300_000,
  result: {
    id: 'r1',
    propertyId: 'p1' as Id<'properties'>,
    firstJobId: 'j1' as Id<'jobs'>,
  },
  updatedAt: 1_789_990_400_000,
  sentAt: 1_789_990_400_000,
} satisfies Required<OutboxItem>

const ITEM_PATHS = [
  'attempts',
  'booking',
  'booking.alsoGoing',
  'booking.assignedMembershipId',
  'booking.businessId',
  'booking.durationMinutes',
  'booking.jobType',
  'booking.notes',
  'booking.price',
  'booking.property',
  'booking.property.newClient',
  'booking.property.newClient.abn',
  'booking.property.newClient.addressCheck',
  'booking.property.newClient.addressLine',
  'booking.property.newClient.clientName',
  'booking.property.newClient.contactPerson',
  'booking.property.newClient.email',
  'booking.property.newClient.kind',
  'booking.property.newClient.phone',
  'booking.property.newClient.postcode',
  'booking.property.newClient.siteContactName',
  'booking.property.newClient.siteContactPhone',
  'booking.property.newClient.state',
  'booking.property.newClient.suburb',
  'booking.repeat',
  'booking.repeat.count',
  'booking.repeat.unit',
  'booking.scheduledAt',
  'booking.workOrder',
  'businessId',
  'businessName',
  'confirmedAt',
  'createdAt',
  'dependsOn',
  'display',
  'display.addressLine',
  'display.alsoGoing',
  'display.alsoGoing[]._id',
  'display.alsoGoing[].colour',
  'display.alsoGoing[].name',
  'display.assigneeColour',
  'display.assigneeName',
  'display.clientEmail',
  'display.clientKind',
  'display.clientName',
  'display.clientNumber',
  'display.clientPhone',
  'display.contactPersonName',
  'display.contactPersonPhone',
  'display.postcode',
  'display.propertyState',
  'display.siteContactName',
  'display.siteContactPhone',
  'display.suburb',
  'editing',
  'editing.tab',
  'editing.until',
  'holdUntil',
  'kind',
  'lastAttemptAt',
  'localId',
  'membershipId',
  'problem',
  'problem.code',
  'requestId',
  'result',
  'result.firstJobId',
  'result.id',
  'result.propertyId',
  'retryAt',
  'sentAt',
  'sentKinds',
  'serverFailures',
  'sessionEndedAt',
  'slug',
  'state',
  'updatedAt',
  'userId',
  'v',
]

/** The other three ways New Job says where a booking goes. */
const PROPERTY_PATHS: Record<string, [BookingArgs['property'], Array<string>]> =
  {
    'an existing site': [
      { propertyId: 'p1' as Id<'properties'> },
      ['propertyId'],
    ],
    'a new site for an existing client': [
      NEW_SITE,
      [
        'newProperty',
        'newProperty.addressCheck',
        'newProperty.addressLine',
        'newProperty.clientId',
        'newProperty.postcode',
        'newProperty.siteContactName',
        'newProperty.siteContactPhone',
        'newProperty.state',
        'newProperty.suburb',
      ],
    ],
    'a client or site not sent yet': [{ local: 'local-0' }, ['local']],
  }

describe('the shape of a kept booking', () => {
  test('is the one OUTBOX_V stands for', () => {
    expect(OUTBOX_V, CHANGED).toBe(SHAPE_AT)
    expect(FULL_ITEM.v).toBe(OUTBOX_V)
    expect([ITEM_KEYS, BOOKING_KEYS, DISPLAY_KEYS]).toEqual([true, true, true])
  })

  test('a fully filled item has exactly the key paths written at SHAPE_AT', () => {
    expect(sorted(keyPaths(FULL_ITEM)), CHANGED).toEqual(ITEM_PATHS)
  })

  test.each(Object.entries(PROPERTY_PATHS))(
    'a booking on %s has exactly the key paths written at SHAPE_AT',
    (_where, [property, paths]) => {
      expect(sorted(keyPaths(property)), CHANGED).toEqual(paths)
    },
  )
})
