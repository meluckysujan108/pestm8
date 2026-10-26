import { OUTBOX_V } from './outboxSet'
import type { FunctionArgs } from 'convex/server'
import type { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import type { IntervalUnit } from '../../../convex/lib/recurrence'
import type {
  NewClientArgs,
  NewSiteArgs,
} from '#/components/clients/NewClientFields'
import type { OutboxKind } from './outboxSet'

/**
 * A booking kept on the phone (the outbox), and the one mapping from what
 * New Job holds to the mutation that books it.
 *
 * Type imports only, beside outboxSet.ts, so outboxStore.ts and the root
 * route can name an item without bringing a screen in with it.
 */

export { OUTBOX_V } from './outboxSet'

/** Where the booking goes: a site that exists, or one made with it. */
export type BookingSite =
  | { propertyId: Id<'properties'> }
  | { newProperty: NewSiteArgs }
  | { newClient: NewClientArgs }

/**
 * …or, for a booking made on a client or site that is itself still on this
 * phone, not sent yet: that item's `localId`. The phone swaps it for the
 * site the first one made before sending this one; it never goes to the
 * server as it is.
 */
export type BookingProperty = BookingSite | { local: string }

/**
 * A booking as New Job holds it (`bookingArgs()`, NewJobSheet.tsx), the
 * shape a kept item stores at OUTBOX_V 1. One shape for both mutations: a
 * repeating booking is a Recurring Job, mapped by `bookingCall`.
 */
export type BookingArgs = {
  businessId: Id<'businesses'>
  property: BookingProperty
  assignedMembershipId: Id<'memberships'>
  jobType: string
  /** Cents. */
  price: number
  scheduledAt: number
  durationMinutes: number
  workOrder?: string
  notes?: string
  /** A one-off's only: a repeating service takes people visit by visit. */
  alsoGoing?: Array<Id<'memberships'>>
  repeat: { count: number; unit: IntervalUnit } | null
}

/** A booking ready to send: its site is one the server knows. */
export type SendableBooking = Omit<BookingArgs, 'property'> & {
  property: BookingSite
}

/**
 * What the item's card shows that its booking doesn't say: who the client is
 * and how to reach them, where, and who is going. Taken when it is saved,
 * from the client directory for a site that exists, or from the booking for
 * one made with it. Named as `jobs.listDay`'s rows name them, so the card is
 * drawn from it as from a real one.
 */
export type OutboxDisplay = {
  clientName: string
  clientKind?: 'person' | 'business'
  clientNumber?: number
  clientPhone: string
  /** A new client's only: the client directory carries no email. */
  clientEmail: string
  contactPersonName: string
  contactPersonPhone: string
  siteContactName: string
  siteContactPhone: string
  addressLine: string
  suburb: string
  postcode: string
  propertyState: string
  assigneeName: string
  assigneeColour: string
  alsoGoing: Array<{ _id: Id<'memberships'>; name: string; colour: string }>
}

/**
 * Where an item is. `sending`: an attempt went and nothing has been heard
 * back, so it may already be booked, and it is locked until that is known.
 */
export type OutboxState = 'waiting' | 'sending' | 'needsLook' | 'sent'

export type OutboxItem = {
  // ── The envelope: the same names and meanings in every build, for good. ──
  /** The key. Made with the draft, never changed: whatever points at an
   * item (a booking made after it, a link, a slot on screen) uses this. */
  localId: string
  /** OUTBOX_V when it was written (outboxSet.ts). */
  v: number
  /** 'job' or 'series' in v1. */
  kind: string
  userId: string
  businessId: Id<'businesses'>
  state: OutboxState
  createdAt: number
  // ── v1 ──
  /** The `clientRequestId` every attempt carries (convex/lib/clientRequest.ts):
   * one per draft, replaced in place only when the server refused it. */
  requestId: string
  slug: string
  businessName: string
  /** The person's own membership when it was saved, sent as `asMembership`. */
  membershipId: Id<'memberships'>
  booking: BookingArgs
  /** The item that makes this one's client or site, not sent yet. */
  dependsOn?: string
  display: OutboxDisplay
  attempts: number
  lastAttemptAt: number | null
  /** Every kind an attempt has gone as, so a lost answer is looked for in
   * each table it could have made a record in. */
  sentKinds: Array<OutboxKind>
  serverFailures: number
  retryAt: number | null
  /** After an answer that says "not now": signed out, switched, paused. */
  holdUntil: number | null
  /** Why it needs a look: the server's code, or the phone's own. */
  problem: { code: string } | null
  /** An Edit open in a tab, held against the others until `until`. */
  editing: { tab: string; until: number } | null
  /** The session it was saved in ended on the server (a password changed
   * elsewhere, say): it is then sent only once the person says so. */
  sessionEndedAt: number | null
  /** The person said to send one that had waited too long: for the wait
   * and the session as they stood then (`isStale`), never for later. */
  confirmedAt: number | null
  result: {
    id: string
    propertyId?: Id<'properties'>
    firstJobId?: Id<'jobs'>
  } | null
  updatedAt: number
  sentAt: number | null
}

/**
 * A new request id: a lower-case v4 UUID, which is the only spelling the
 * server accepts (`checkClientRequestId`). `crypto.randomUUID` needs a secure
 * context, which prod and localhost are, and Safari 15.4; anything else gets
 * the same shape from random bytes. Never keptStore's epoch, which drops the
 * dashes and would be refused.
 */
export function newRequestId(): string {
  try {
    return crypto.randomUUID().toLowerCase()
  } catch {
    return uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)))
  }
}

/** 16 random bytes as a v4 UUID: the version and variant bits set. */
export function uuidFromBytes(random: Uint8Array): string {
  const bytes = Uint8Array.from(random.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/** A one-off is a job; a repeating booking a Recurring Job. */
export function kindOf(booking: BookingArgs): OutboxKind {
  return booking.repeat === null ? 'job' : 'series'
}

/** The item a booking's site waits on, if it is one not sent yet. */
export function parentOf(booking: BookingArgs): string | undefined {
  return 'local' in booking.property ? booking.property.local : undefined
}

/** A booking, as an item not sent yet. */
export function itemFromBooking(
  booking: BookingArgs,
  at: {
    localId: string
    requestId: string
    userId: string
    business: { slug: string; name: string }
    membershipId: Id<'memberships'>
    display: OutboxDisplay
    now: number
  },
): OutboxItem {
  const parent = parentOf(booking)
  return {
    localId: at.localId,
    v: OUTBOX_V,
    kind: kindOf(booking),
    userId: at.userId,
    businessId: booking.businessId,
    state: 'waiting',
    createdAt: at.now,
    requestId: at.requestId,
    slug: at.business.slug,
    businessName: at.business.name,
    membershipId: at.membershipId,
    booking,
    ...(parent !== undefined && { dependsOn: parent }),
    display: at.display,
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
    updatedAt: at.now,
    sentAt: null,
  }
}

/** The mutation a booking goes as, with its arguments. */
export type BookingCall =
  | { fn: 'jobs.create'; args: FunctionArgs<typeof api.jobs.create> }
  | {
      fn: 'recurrences.create'
      args: FunctionArgs<typeof api.recurrences.create>
    }

/** What a send adds to the booking itself. Each is sent only when given. */
export type BookingCallExtra = {
  /** The draft's request id (convex/lib/clientRequest.ts). */
  clientRequestId?: string
  /** Whose booking it is, from one the phone sends by itself
   * (convex/lib/outboxGuards.ts). */
  asMembership?: Id<'memberships'>
  /** A Recurring Job's only: refuse it if its first visit has gone by. */
  refuseBackfill?: true
}

/**
 * The one mapping from a booking to the mutation that makes it, for New
 * Job's own save and for a kept booking sent later alike. Listed by hand for
 * the Recurring Job, as it always was: a field left off here is silently
 * dropped from every visit of the series. The client or site goes to either
 * mutation whole, in the server's shape already (`newClientArgs`,
 * `newSiteArgs`).
 */
export function bookingCall(
  booking: SendableBooking,
  extra: BookingCallExtra = {},
): BookingCall {
  const { repeat: recurrence, property, ...job } = booking
  const keyed = {
    ...(extra.clientRequestId !== undefined && {
      clientRequestId: extra.clientRequestId,
    }),
    ...(extra.asMembership !== undefined && {
      asMembership: extra.asMembership,
    }),
  }
  if (recurrence === null) {
    return { fn: 'jobs.create', args: { ...job, ...property, ...keyed } }
  }
  return {
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
      // The first visit's only (recurrences.create says why). No people
      // also going: a series takes them visit by visit.
      notes: job.notes,
      ...keyed,
      ...(extra.refuseBackfill && { refuseBackfill: true as const }),
    },
  }
}
