import { itemFromBooking } from '#/lib/outbox/outboxItem'
import { latchSlots } from '#/lib/outbox/latchSlots'
import { outboxRow } from '#/lib/outbox/outboxRow'
import { BIZ, JOBS, MEMBERS, TZ, perthTodayKey } from './fixtures'
import type { BookingArgs, OutboxItem } from '#/lib/outbox/outboxItem'
import type { OutboxDay } from '#/lib/outbox/useOutbox'
import type { SlotLatch } from '#/lib/outbox/latchSlots'
import type { JobRow } from '#/components/schedule/JobCard'

/**
 * Bookings kept on the phone, not sent yet (lib/outbox/), for the outbox's
 * specimens: a new client's job this afternoon, still on the phone; an
 * existing client's sent as the signal went; and one sent, which its day's
 * list now has as job #1046.
 */

/** Who the specimens sign in as: a stand-in session, whose token says only
 * who it is (the bookings are theirs). */
export const HARNESS_USER = 'harness-user'
export const HARNESS_TOKEN = `x.${btoa(
  JSON.stringify({ sub: HARNESS_USER, name: 'Terence Walsh' }),
)}.x`

/** `hour`:`minute` today in Perth. */
function todayAt(hour: number, minute = 0): number {
  return Date.parse(
    `${perthTodayKey()}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
  )
}

/** A day after today, at nine, for a day with nothing booked yet. */
export function laterAt(days: number, hour = 9): number {
  return todayAt(hour) + days * 86_400_000
}

function kept(
  localId: string,
  booking: Partial<BookingArgs> & { scheduledAt: number },
  display: Partial<OutboxItem['display']>,
  extra: Partial<OutboxItem> = {},
): OutboxItem {
  const lead = MEMBERS.find(
    (m) => m._id === (booking.assignedMembershipId ?? 'm_owner'),
  )
  return {
    ...itemFromBooking(
      {
        businessId: BIZ as never,
        property: { propertyId: 'p_harness' as never },
        assignedMembershipId: 'm_owner' as never,
        jobType: 'General Pest Control',
        price: 19_500,
        durationMinutes: 60,
        repeat: null,
        ...booking,
      },
      {
        localId,
        requestId: `00000000-0000-4000-8000-${localId.padStart(12, '0').slice(-12)}`,
        userId: HARNESS_USER,
        business: { slug: 'demo', name: 'Swan River Pest Co' },
        membershipId: 'm_owner' as never,
        display: {
          clientName: '',
          clientPhone: '',
          clientEmail: '',
          contactPersonName: '',
          contactPersonPhone: '',
          siteContactName: '',
          siteContactPhone: '',
          addressLine: '',
          suburb: '',
          postcode: '',
          propertyState: 'WA',
          assigneeName: lead?.name ?? '',
          assigneeColour: lead?.colour ?? '',
          alsoGoing: [],
          ...display,
        },
        now: Date.now() - 20 * 60_000,
      },
    ),
    ...extra,
  }
}

/** A new client booked offline this afternoon, still on the phone. */
export const WAITING = kept(
  '1',
  {
    scheduledAt: todayAt(14),
    property: {
      newClient: {
        clientName: 'Marta Kowalski',
        kind: 'person',
        addressLine: '9 Coode St',
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
        phone: '0412 998 001',
      },
    },
    notes: 'Side gate — ring on arrival',
  },
  {
    clientName: 'Marta Kowalski',
    clientKind: 'person',
    clientPhone: '0412 998 001',
    addressLine: '9 Coode St',
    suburb: 'Bayswater',
    postcode: '6053',
  },
)

/** An existing business's job, sent as the signal went: no answer yet. */
export const SENDING = kept(
  '2',
  {
    scheduledAt: todayAt(16, 30),
    assignedMembershipId: 'm_kev' as never,
    jobType: 'Termite Inspection',
    price: 38_500,
    workOrder: 'WO-77120',
  },
  {
    clientName: 'Wattle Grove Strata',
    clientKind: 'business',
    clientPhone: '08 9300 4400',
    clientEmail: 'office@wattlegrove.example',
    contactPersonName: 'Jan Morris',
    contactPersonPhone: '0400 222 111',
    addressLine: '41 Grand Bvd',
    suburb: 'Joondalup',
    postcode: '6027',
  },
  {
    state: 'sending',
    attempts: 1,
    lastAttemptAt: Date.now() - 5 * 60_000,
    sentKinds: ['job'],
  },
)

/** The job the third booking made, as its day's list now has it. */
export const MADE: JobRow = {
  ...(JOBS[0] as unknown as JobRow),
  _id: 'j_made',
  jobNumber: 1046,
  status: 'pending',
  jobType: 'Rodents',
  scheduledAt: todayAt(18),
  clientName: 'Ollie Brandt',
  addressLine: '3 Reserve St',
  suburb: 'Scarborough',
  postcode: '6019',
  clientEmail: undefined,
  clientPhone: '0433 765 100',
  notePreview: undefined,
  alsoGoing: [],
}

/** The booking that made it, before and after its answer. */
export const TO_SEND = kept(
  '3',
  { scheduledAt: MADE.scheduledAt, jobType: 'Rodents', price: 18_000 },
  {
    clientName: 'Ollie Brandt',
    clientKind: 'person',
    clientPhone: '0433 765 100',
    addressLine: '3 Reserve St',
    suburb: 'Scarborough',
    postcode: '6019',
  },
)
export const SENT: OutboxItem = {
  ...TO_SEND,
  state: 'sent',
  result: { id: MADE._id },
  sentAt: Date.now(),
  updatedAt: TO_SEND.updatedAt + 1,
}

/**
 * A day's group as `useOutboxDay` would draw it, from these bookings: the
 * latch run over each set in turn, as renders one after another hold it.
 */
export function outboxDayOf(
  steps: Array<{
    items: Array<OutboxItem>
    rows?: Array<JobRow>
    dayLive?: boolean
  }>,
  dayShown = perthTodayKey(),
  lineLive = false,
): OutboxDay {
  let latch: SlotLatch | null = null
  let result = latchSlots<JobRow>(null, {
    items: null,
    drawing: true,
    rows: [],
    redrawKey: 'harness',
    dayShown,
    timezone: TZ,
    dayLive: false,
    now: Date.now(),
    mayAdd: () => true,
  })
  for (const step of steps) {
    result = latchSlots<JobRow>(latch, {
      items: step.items,
      drawing: true,
      rows: step.rows ?? [],
      redrawKey: 'harness',
      dayShown,
      timezone: TZ,
      dayLive: step.dayLive ?? false,
      now: Date.now(),
      mayAdd: () => true,
    })
    latch = result.latch
  }
  return {
    slots: result.slots.map((slot) => ({
      ...slot,
      row:
        slot.real ??
        outboxRow(slot.item, { seesPrices: true, roster: MEMBERS }),
    })),
    hidden: result.hidden,
    heading: result.heading,
    lineLive,
  }
}
