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
import { DEFAULT_INTERVAL, intervalFromDraft } from './RecurrenceFields'
import type {
  ClientKind,
  NewClientFieldsValue,
  NewSiteValue,
} from '#/components/clients/NewClientFields'
import type { SendableBooking } from '#/lib/outbox/outboxItem'
import type { IntervalDraft } from './RecurrenceFields'
import type { Id } from '../../../convex/_generated/dataModel'

/** Which of New Job's ways in a booking is at (`NewJobForm`'s `mode`). */
export type ClientMode = 'existing' | 'new' | 'site'

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
 * The form an Edit opens on, from the booking kept on the phone: its way in,
 * its client's or site's fields as typed, who, what, when and how often.
 * `businessState`: where a blank new address starts, as New Job's does.
 */
export function formFromBooking(
  booking: SendableBooking,
  at: { timezone: string; businessState: string },
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
