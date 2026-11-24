import {
  EMPTY_NEW_CLIENT,
  EMPTY_NEW_SITE,
  newClientArgs,
  newSiteArgs,
} from '#/components/clients/NewClientFields'
import {
  dayKeyOf,
  timeKeyOf,
  zonedDateTimeToUtc,
} from '../../../convex/lib/dates'
import { joinJobTypes, splitJobTypes } from '../../../convex/lib/jobTypes'
import { LEFT_ON_PHONE } from '#/lib/outbox/book'
import { DEFAULT_INTERVAL, intervalFromDraft } from './RecurrenceFields'
import type {
  ClientKind,
  NewClientFieldsValue,
  NewSiteValue,
} from '#/components/clients/NewClientFields'
import type {
  BookingArgs,
  OutboxItem,
  SendableBooking,
} from '#/lib/outbox/outboxItem'
import type { UnsentStatus } from '#/lib/propertyOptions'
import type { IntervalDraft } from './RecurrenceFields'
import type { Id } from '../../../convex/_generated/dataModel'

/** Which of New Job's ways in a booking is at (`NewJobForm`'s `mode`). */
export type ClientMode = 'existing' | 'new' | 'site'

// ── A client or site not sent yet (plan part 2c §7, 2c-I) ─────────────────

const UNSENT = 'outbox:'

/**
 * A client or site another booking on the phone makes, not sent yet, as New
 * Job's Property picker holds it: that booking's key, never a site's id.
 * Booked, it is `{ local }` (`asKept`), and goes once that one has.
 */
export function unsentValue(localId: string): string {
  return `${UNSENT}${localId}`
}

/** The key of the booking a Property picker value names, if it is one
 * (`unsentValue`). */
export function unsentLocalId(value: string): string | null {
  return value.startsWith(UNSENT) ? value.slice(UNSENT.length) : null
}

/**
 * The bookings on the phone a booking can be made on (§7): this business's,
 * not sent yet, that make a client or a site, newest first. One level only:
 * never a booking that is itself made on another, nor any while the
 * booking being changed (`editing`) is the one, or one others are made on.
 * Never one New Job sent straight and couldn't take off the phone
 * (`LEFT_ON_PHONE`): it may already be booked, its client and site with it,
 * so a booking for them goes at the site in the client list once it is
 * there; unless it is the one chosen, which says it needs a look
 * (`unsentStatus`).
 */
export function unsentSites(
  items: ReadonlyArray<OutboxItem>,
  editing?: OutboxItem,
  /** The one chosen in the form: still offered whatever has become of it
   * while it is in `items`, as the site the booking goes to. Sent while the
   * form is open, or before (an Edit of a booking made on it opens on it,
   * D-I4), or changed since to book at a site in the client list, which
   * that booking then goes to. Never once it is made on another itself
   * (another tab's Edit): nothing can be made on it then. */
  chosen?: string | null,
  /** When the form opened (`openedAt`): one sent since stays where it was,
   * "Sent just now", chosen or not, so no row under it moves while the
   * picker may be open. The site it made comes into "Added recently" as
   * any site added meanwhile does. Left out: only those not sent yet. */
  openedAt?: number,
): Array<OutboxItem> {
  if (
    editing !== undefined &&
    items.some(
      (other) => other.dependsOn === editing.localId && other.state !== 'sent',
    )
  ) {
    return []
  }
  const sentSinceOpened = (item: OutboxItem) =>
    openedAt !== undefined && item.sentAt !== null && item.sentAt >= openedAt
  return items
    .filter(
      (item) =>
        item.localId !== editing?.localId &&
        item.dependsOn === undefined &&
        (item.localId === chosen ||
          ((item.state !== 'sent' || sentSinceOpened(item)) &&
            !leftOnPhone(item) &&
            ('newClient' in item.booking.property ||
              'newProperty' in item.booking.property))),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** One New Job sent straight and couldn't take off the phone: it may
 * already be booked (book.ts `LEFT_ON_PHONE`). */
function leftOnPhone(item: OutboxItem): boolean {
  return item.state === 'needsLook' && item.problem?.code === LEFT_ON_PHONE
}

/**
 * Where a client or site not sent yet stands, for the words under it in the
 * picker (`withUnsentSites`): not sent yet (waiting, or needing a look);
 * being sent, which may already be booked and never reads as not sent
 * (D11); needing a look as one New Job sent straight and couldn't take off
 * the phone, which may already be booked too (`LEFT_ON_PHONE`); or sent,
 * while the form has been open (`openedAt`) or before.
 */
export function unsentStatus(item: OutboxItem, openedAt: number): UnsentStatus {
  if (item.state === 'sending') return 'sending'
  if (leftOnPhone(item)) return 'look'
  if (item.state !== 'sent') return 'unsent'
  return item.sentAt !== null && item.sentAt >= openedAt ? 'sentNow' : 'sent'
}

/**
 * Whether New Job draws "New site for an existing client" under Existing
 * client's Property: only where the client list has someone to choose, as
 * one booked on the phone and not sent yet is never offered there (§7).
 * Decided as the form opens (`offered` starts as whether the list has
 * anyone) and, once drawn, kept. Never put in while Existing client is on
 * screen: a business's first client, sent while the form is open on one
 * not sent yet, would bring it in above the fields under a thumb. It comes
 * with the next change of mode, or the next New Job.
 */
export function offersNewSite(
  offered: boolean,
  now: { clients: number; mode: ClientMode },
): boolean {
  return offered || (now.clients > 0 && now.mode !== 'existing')
}

/** The booking as it is kept on the phone: a client or site not sent yet,
 * picked in the Property picker (`unsentValue`), is `{ local }`. */
export function asKept(booking: SendableBooking): BookingArgs {
  const property = booking.property
  const local =
    'propertyId' in property ? unsentLocalId(property.propertyId) : null
  return local === null ? booking : { ...booking, property: { local } }
}

/**
 * New Job's form as it holds a booking: the one mapping both ways between
 * the form and the booking it books (`bookingFromForm`), and back
 * (`formFromBooking`), so an Edit of a booking on the phone opens on exactly
 * what it would book again (plan part 2c §10.3).
 */
export type NewJobFormValues = {
  mode: ClientMode
  propertyId: string
  siteClientId: string
  newSite: NewSiteValue
  newClient: NewClientFieldsValue
  assignee: string
  jobTypes: Array<string>
  day: string
  start: string
  end: string
  /** The booking's length as the form opened: what `useJobTimes` keeps,
   * and books while neither time has changed. */
  length: number
  price: string
  workOrder: string
  notes: string
  alsoGoing: Array<string>
  repeats: boolean
  interval: IntervalDraft
}

/**
 * The booking the form holds, as `jobs.create` and `recurrences.create` take
 * it (lib/outbox/outboxItem.ts `bookingCall`). `durationMinutes` is the
 * form's to work out (`useJobTimes.lengthOn`), never null here: the form
 * refuses a booking whose end is not after its start before it asks.
 * `clientKind`: the chosen client's, for what a new site of theirs takes.
 */
export function bookingFromForm(
  form: Omit<NewJobFormValues, 'end' | 'length'>,
  at: {
    businessId: Id<'businesses'>
    timezone: string
    durationMinutes: number
    clientKind: ClientKind | undefined
  },
): SendableBooking {
  const [hh, mm] = form.start.split(':').map(Number)
  // The picker gives a wall-clock time on the selected day, in the
  // tenant's own timezone — not the viewer's browser zone, which may
  // differ (a technician travelling, or simply a differently-configured
  // device) and would otherwise silently book the wrong instant.
  const scheduledAt = zonedDateTimeToUtc(form.day, hh, mm, at.timezone)
  const repeat = form.repeats ? intervalFromDraft(form.interval) : null
  return {
    businessId: at.businessId,
    property:
      form.mode === 'existing'
        ? { propertyId: form.propertyId as Id<'properties'> }
        : form.mode === 'site'
          ? {
              newProperty: newSiteArgs(
                form.siteClientId as Id<'clients'>,
                at.clientKind,
                form.newSite,
              ),
            }
          : { newClient: newClientArgs(form.newClient) },
    assignedMembershipId: form.assignee as Id<'memberships'>,
    jobType: joinJobTypes(form.jobTypes),
    price: Math.round(Number(form.price || '0') * 100),
    scheduledAt,
    durationMinutes: at.durationMinutes,
    workOrder: form.workOrder.trim() || undefined,
    // Only for a one-off, and only when someone was added: a repeating
    // service takes people visit by visit, for now.
    alsoGoing:
      !form.repeats && form.alsoGoing.length > 0
        ? (form.alsoGoing as Array<Id<'memberships'>>)
        : undefined,
    // Left out when blank, so a booking without one never depends on a
    // backend that knows the field.
    notes: form.notes.trim() || undefined,
    repeat,
  }
}

/** "120.5" for 12050 cents; blank for none, as a new form starts. */
function priceDraft(cents: number): string {
  return cents === 0 ? '' : String(cents / 100)
}

/**
 * The form an Edit opens on, from the booking kept on the phone (one made on
 * a client or site not sent yet included, on that one: `unsentValue`): its way in,
 * its client's or site's fields as typed, who, what, when and how often.
 * `businessState`: where a blank new address starts, as New Job's does.
 * `siteGone`: the booking needs a look because its site has been deleted
 * (`NOT_FOUND`): one made on another booking then opens on no site, to
 * choose another, never on that one again, whose site it is.
 */
export function formFromBooking(
  booking: BookingArgs,
  at: { timezone: string; businessState: string; siteGone?: boolean },
): NewJobFormValues {
  const state = at.businessState || EMPTY_NEW_SITE.state
  const blankSite: NewSiteValue = { ...EMPTY_NEW_SITE, state }
  const blankClient: NewClientFieldsValue = { ...EMPTY_NEW_CLIENT, state }
  const property = booking.property
  let mode: ClientMode = 'existing'
  let propertyId = ''
  let siteClientId = ''
  let newSite = blankSite
  let newClient = blankClient
  if ('propertyId' in property) {
    propertyId = property.propertyId
  } else if ('local' in property) {
    // Made on a client or site another booking on the phone makes: that
    // one, as the Property picker offers it (`unsentValue`), unless the site
    // it made is the one deleted.
    propertyId = at.siteGone === true ? '' : unsentValue(property.local)
  } else if ('newProperty' in property) {
    const site = property.newProperty
    mode = 'site'
    siteClientId = site.clientId
    newSite = {
      addressLine: site.addressLine,
      suburb: site.suburb,
      state: site.state,
      postcode: site.postcode,
      siteContactName: site.siteContactName ?? '',
      siteContactPhone: site.siteContactPhone ?? '',
      addressCheck: site.addressCheck ?? 'typed',
    }
  } else {
    const client = property.newClient
    mode = 'new'
    newClient = {
      kind: client.kind ?? 'person',
      clientName: client.clientName,
      addressLine: client.addressLine,
      suburb: client.suburb,
      state: client.state,
      postcode: client.postcode,
      addressCheck: client.addressCheck ?? 'typed',
      phone: client.phone ?? '',
      email: client.email ?? '',
      abn: client.abn ?? '',
      contactPerson: client.contactPerson ?? '',
      siteContactName: client.siteContactName ?? '',
      siteContactPhone: client.siteContactPhone ?? '',
    }
  }
  const end = booking.scheduledAt + booking.durationMinutes * 60_000
  return {
    mode,
    propertyId,
    siteClientId,
    newSite,
    newClient,
    assignee: booking.assignedMembershipId,
    jobTypes: splitJobTypes(booking.jobType),
    day: dayKeyOf(booking.scheduledAt, at.timezone),
    start: timeKeyOf(booking.scheduledAt, at.timezone),
    end: timeKeyOf(end, at.timezone),
    length: booking.durationMinutes,
    price: priceDraft(booking.price),
    workOrder: booking.workOrder ?? '',
    notes: booking.notes ?? '',
    alsoGoing: [...(booking.alsoGoing ?? [])],
    repeats: booking.repeat !== null,
    interval:
      booking.repeat === null
        ? DEFAULT_INTERVAL
        : { count: String(booking.repeat.count), unit: booking.repeat.unit },
  }
}
