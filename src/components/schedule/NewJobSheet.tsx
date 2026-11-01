import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { flushSync } from 'react-dom'
import { Drawer } from 'vaul'
import { SHEET_BODY, SheetShell } from '#/components/primitives/Sheet'
import { api } from '../../../convex/_generated/api'
import {
  DEFAULT_INTERVAL,
  RecurrenceFields,
  intervalFromDraft,
} from './RecurrenceFields'
import { Combobox } from '#/components/primitives/Combobox'
import type {
  ComboboxAction,
  ComboboxHandle,
  ComboboxLookup,
} from '#/components/primitives/Combobox'
import { Segmented } from '#/components/primitives/Segmented'
import { JobTypePicker } from './JobTypePicker'
import { useNewJobBooking } from './useNewJobBooking'
import { useJobTypes } from '#/lib/useJobTypes'
import {
  EMPTY_NEW_CLIENT,
  EMPTY_NEW_SITE,
  NewClientFields,
  SiteAddressFields,
  SiteContactFields,
  newClientArgs,
  newClientFieldId,
  newSiteArgs,
} from '#/components/clients/NewClientFields'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveCheck,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import type {
  SaveWarning,
  SaveWarningFix,
} from '#/components/forms/SaveWarnings'
import type {
  NewClientFieldsValue,
  NewClientMatchField,
  NewClientMatchLine,
  NewSiteValue,
} from '#/components/clients/NewClientFields'
import { useLineFixHold } from '#/components/clients/useMatchLines'
import type { FieldFix } from '#/components/forms/FieldMessage'
import type { Id } from '../../../convex/_generated/dataModel'
import type { SendableBooking } from '#/lib/outbox/outboxItem'
import { bookingDisplay, contactPersonFor } from '#/lib/outbox/outboxRow'
import { useCanKeep, useDraftRequestId } from '#/lib/outbox/useOutbox'
import { saysKept } from '#/lib/outbox/book'
import type { BookingWho } from '#/lib/outbox/book'
import { useHydrated } from '#/lib/useHydrated'
import { useLineDown } from '#/lib/offline/useLineDown'
import type { LineDown } from '#/lib/offline/useLineDown'
import { keeper } from '#/lib/offline/keeper'
import { lensOf } from '#/lib/offline/keptSet'
import { signedInUserId } from '#/lib/rootState'
import {
  clientOptions,
  pickerName,
  propertyOptions,
} from '#/lib/propertyOptions'
import {
  clientOf,
  clientsForPicker,
  normaliseDirectory,
  sitesWithClients,
} from '#/lib/directory'
import {
  holdersFirst,
  namedClient,
  noMatchRoute,
  propertyListEnd,
  queryHolders,
  siteLessFound,
  siteLessNamed,
} from '#/lib/clientSearch'
import type { NoMatchRoute, PropertyListEnd } from '#/lib/clientSearch'
import {
  answerMayBeBehind,
  useNewerClientsHint,
  useReadableAll,
} from '#/lib/offline/useKept'
import { useMatchIndex } from '#/lib/useMatchIndex'
import {
  blurLine,
  bookingMatchRows,
  carryAfter,
  matchFooter,
  matchNotes,
  matchShownCounts,
  planMatchFix,
  withoutCallerLine,
} from '#/lib/clientMatchRows'
import type {
  AddedAnyway,
  Carried,
  FixPlan,
  FixState,
  MatchFix,
  MatchRow,
  MatchRowsContext,
} from '#/lib/clientMatchRows'
import { logConnectionChange } from '#/lib/connectionLog'
import { todayKey } from '#/lib/format'
import { rq } from '#/lib/routeQueries'
import { personLabel, roleLabel, useAssigneeOptions } from '#/lib/assignees'
import { OffViewNote } from './OffViewNote'
import { JobTimeFields, useJobTimes } from './JobTimeFields'
import { SheetPending } from '#/components/shell/Pending'
import { EmptyState } from '#/components/primitives/EmptyState'
import { BOOKING_ERROR_COPY } from './bookingCopy'
import { zonedDateTimeToUtc } from '../../../convex/lib/dates'
import { MAX_WORK_ORDER_LENGTH } from '../../../convex/lib/workOrder'
import { MAX_JOB_NOTES_LENGTH } from '../../../convex/lib/jobNotes'
import { joinJobTypes } from '../../../convex/lib/jobTypes'
import { HELD_BUTTON, PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { FIELD, FIELD_SURFACE } from '#/components/forms/FormField'
import { Plus } from 'lucide-react'
import { alsoGoingFullLabel } from '#/lib/jobPeople'
import { MAX_ALSO_GOING } from '../../../convex/lib/jobPeople'
import { useAccess } from '#/lib/access'

/** 'site' is a new site for an existing client (Prompt 6.3). */
type ClientMode = 'existing' | 'new' | 'site'

const PROPERTY_ERROR_ID = 'new-job-property-error'
const CLIENT_ERROR_ID = 'new-job-client-error'
const JOB_TYPE_ERROR_ID = 'new-job-type-error'

/** An hour from nine, until the person says otherwise. */
const OPENING_TIMES = { start: '09:00', end: '10:00', length: 60 }

/**
 * Above Book job while the line is down (lib/offline/useLineDown.ts). The
 * booking isn't refused: the Convex client holds it until the line is back,
 * then sends it, for as long as the app stays open. So it says that, rather
 * than leave "Booking…" looking like a hang.
 */
export const BOOKING_WAITS: Record<LineDown, string> = {
  'no-signal':
    'No signal — the booking goes when you have signal. Keep PestM8 open until then.',
  unreachable:
    'Could not reach PestM8 — the booking goes once it can. Keep PestM8 open until then.',
}

/**
 * …and where it would be kept on the phone (lib/outbox/book.ts): it is safe
 * there, so nothing needs to stay open for it, and it goes the next time
 * PestM8 is open with signal.
 */
export const BOOKING_KEPT: Record<LineDown, string> = {
  'no-signal':
    'No signal — the booking is kept on this phone and goes when PestM8 is open with signal.',
  unreachable:
    'Could not reach PestM8 — the booking is kept on this phone and goes once PestM8 answers.',
}

/** The words above Book job with the line down. */
export function bookingCaption(lineDown: LineDown, keeps: boolean): string {
  return (keeps ? BOOKING_KEPT : BOOKING_WAITS)[lineDown]
}

/**
 * New Job with the line down and nothing on the phone to make it of (plan
 * §3.4): said, in place of a placeholder that would wait for good. First
 * use, a copy more than 21 days old, another view's or another account's
 * copy: the sheet opens the form by itself once they can be read.
 */
export const NEW_JOB_NOT_ON_PHONE = {
  title: 'New Job isn’t on this phone yet',
  body: 'It needs the client list and the team, which this phone doesn’t have yet. It opens when you have signal.',
}

/**
 * What New Job's sheet holds (plan §3.4): nothing while it is closed; the
 * form where it can be made, and kept while it is up, whatever the line
 * does then, so nothing typed is ever taken away; otherwise
 * `NEW_JOB_NOT_ON_PHONE`.
 */
export function newJobBody(at: {
  open: boolean
  onPhone: boolean
  /** The form has mounted, this opening of the sheet. */
  formUp: boolean
}): 'none' | 'form' | 'notOnPhone' {
  if (!at.open) return 'none'
  return at.onPhone || at.formUp ? 'form' : 'notOnPhone'
}

/** The sheet's body when New Job can't be made (`NEW_JOB_NOT_ON_PHONE`). */
export function NewJobNotOnPhone() {
  return (
    <div className={`${SHEET_BODY} pt-3`}>
      <Drawer.Title className="text-sheet-title text-ink">New job</Drawer.Title>
      <div className="mt-4">
        <EmptyState
          title={NEW_JOB_NOT_ON_PHONE.title}
          body={NEW_JOB_NOT_ON_PHONE.body}
        />
      </div>
    </div>
  )
}

/**
 * Whether anything was typed into a new client's or site's fields, by value.
 * `addressCheck` is left out: the address fields set it themselves as they
 * mount, and opening the New client tab is not typing in it.
 */
function typedIn<T extends { addressCheck: unknown }>(now: T, opened: T) {
  const typed = (value: T) =>
    JSON.stringify({ ...value, addressCheck: undefined })
  return typed(now) !== typed(opened)
}

export function NewJobSheet({
  businessId,
  dayKey,
  timezone,
  open,
  onClose,
  assignTo,
  onBooked,
  forProperty,
  pickDate = false,
}: {
  businessId: Id<'businesses'>
  dayKey: string
  timezone: string
  open: boolean
  onClose: () => void
  /** Who the job starts out for — "give Kevin a job" from his join notice.
   * Anyone the form would not offer falls back to its usual choice. */
  assignTo?: Id<'memberships'>
  /** Once the job is booked — before the sheet closes. */
  onBooked?: () => void
  /** Booked from a client's sheet: their site starts chosen. */
  forProperty?: Id<'properties'>
  /** Opened away from the Schedule, where no day is selected: the day is a
   * field of the form, starting on `dayKey`. */
  pickDate?: boolean
}) {
  // What the form is made of, on the phone or on its way: with the line
  // down and none of it here, the sheet says so rather than wait for good.
  // The job types too, or a phone without them would book the nine every
  // business starts with.
  const onPhone = useReadableAll([
    rq.directory(businessId).queryKey,
    rq.roster(businessId).queryKey,
    rq.jobTypes(businessId).queryKey,
  ])
  // Asked as the sheet opens, and until the form is up: from then on the
  // form stays, whatever the line does (the job types, which it doesn't
  // wait for, may still be on their way).
  const [formUp, setFormUp] = useState(false)
  if (!open && formUp) setFormUp(false)
  const body = newJobBody({ open, onPhone, formUp })
  return (
    <SheetShell open={open} onClose={onClose}>
      {/* The form suspends on the property and team lists. Its own
          boundary lets the sheet slide up at once; without one, the first
          open blanked the whole app until both had loaded. */}
      {body === 'notOnPhone' && <NewJobNotOnPhone />}
      {body === 'form' && (
        <Suspense
          fallback={
            <SheetPending
              title={
                <Drawer.Title className="text-sheet-title text-ink">
                  New job
                </Drawer.Title>
              }
            />
          }
        >
          <NewJobForm
            businessId={businessId}
            dayKey={dayKey}
            timezone={timezone}
            onClose={onClose}
            assignTo={assignTo}
            onBooked={onBooked}
            forProperty={forProperty}
            pickDate={pickDate}
            onShown={setFormUp}
          />
        </Suspense>
      )}
    </SheetShell>
  )
}

function NewJobForm({
  businessId,
  dayKey,
  timezone,
  onClose,
  assignTo,
  onBooked,
  forProperty,
  pickDate,
  onShown,
}: {
  businessId: Id<'businesses'>
  dayKey: string
  timezone: string
  onClose: () => void
  assignTo?: Id<'memberships'>
  onBooked?: () => void
  forProperty?: Id<'properties'>
  pickDate: boolean
  /** The form is up (`newJobBody`). */
  onShown: (shown: true) => void
}) {
  // The slim directory the Schedule warms (`clients.directory`), as the
  // screens read it (`normaliseDirectory`: the same object for the same
  // answer, so what is built from it below is built once per push). Every
  // site with its client, in the shape `properties.list` had, so nothing
  // below changed when the source did.
  const { data: directory } = useSuspenseQuery({
    ...rq.directory(businessId),
    select: normaliseDirectory,
  })
  const properties = useMemo(() => sitesWithClients(directory), [directory])
  const { data: members } = useSuspenseQuery(
    convexQuery(api.memberships.listForBusiness, { businessId }),
  )
  const jobTypeList = useJobTypes(businessId).entries
  useEffect(() => onShown(true), [onShown])

  // A business with no properties yet has nothing to pick from, so it starts
  // straight in "new client" mode rather than hitting a dead end.
  const [mode, setMode] = useState<ClientMode>(
    properties.length > 0 ? 'existing' : 'new',
  )
  // Chosen already when booked from a client's sheet: that is the client.
  // Anywhere else nothing is, until the person chooses.
  const [openedProperty] = useState<string>(() =>
    forProperty && properties.some((p) => p._id === forProperty)
      ? forProperty
      : '',
  )
  const [propertyId, setPropertyId] = useState(openedProperty)
  // A day of its own only where the form asks for one; the Schedule's New
  // Job books on the day the Schedule is showing, as it always has.
  const [openedDay] = useState(dayKey)
  const [pickedDay, setDay] = useState(dayKey)
  const day = pickDate ? pickedDay : dayKey
  const business = useRouteContext({
    from: '/$businessSlug',
    select: (context) => context.business,
  })
  const businessState = business.state
  // A new address starts in the business's own state, not WA for everyone:
  // most of a Darwin business's clients are in the NT, and a Darwin address
  // typed by hand and left on WA is how prod came to hold "Fannybay WA".
  const [newClient, setNewClient] = useState<NewClientFieldsValue>(() => ({
    ...EMPTY_NEW_CLIENT,
    state: businessState || EMPTY_NEW_CLIENT.state,
  }))
  const [siteClientId, setSiteClientId] = useState('')
  const [newSite, setNewSite] = useState<NewSiteValue>(() => ({
    ...EMPTY_NEW_SITE,
    state: businessState || EMPTY_NEW_SITE.state,
  }))
  const [assignee, setAssignee] = useState<string>(assignTo ?? '')
  // Nothing ticked until the person ticks it, like the client. It used to
  // start on General Pest Control, which was harmless while picking another
  // REPLACED it. Now that picking adds, a default would be added to: tap
  // Bed Bugs out of habit and the job is booked, and its report started, as
  // general pest control too.
  const [jobTypes, setJobTypes] = useState<Array<string>>([])
  const [jobTypeMissing, setJobTypeMissing] = useState(false)
  const jobTypeTrigger = useRef<HTMLButtonElement>(null)
  const [notes, setNotes] = useState('')
  const times = useJobTimes(OPENING_TIMES)
  const [price, setPrice] = useState('')
  const [workOrder, setWorkOrder] = useState('')
  const [addingWorkOrder, setAddingWorkOrder] = useState(false)
  const workOrderInput = useRef<HTMLInputElement>(null)
  // "Does it repeat" and "how often" are two questions, so they are two
  // controls: the interval fields stay mounted but disabled when it does not,
  // rather than appearing and reflowing the form under the person's thumb.
  const [repeats, setRepeats] = useState(false)
  const [interval, setInterval] = useState(DEFAULT_INTERVAL)

  // Anything filled in locks the sheet against a swipe, and ✕ asks before
  // throwing it away (useSheetLock). An untouched New Job still swipes shut.
  const [assigneeChosen, setAssigneeChosen] = useState(false)
  // Everyone going beside the lead (a shared job): behind "Add someone else",
  // so the form stays as short as it was for the usual one-person job.
  const [addingPeople, setAddingPeople] = useState(false)
  const [alsoGoing, setAlsoGoing] = useState<Array<string>>([])
  const [openedClient] = useState(newClient)
  const [openedSite] = useState(newSite)
  const changed =
    propertyId !== openedProperty ||
    (pickDate && pickedDay !== openedDay) ||
    typedIn(newClient, openedClient) ||
    siteClientId !== '' ||
    typedIn(newSite, openedSite) ||
    assigneeChosen ||
    alsoGoing.length > 0 ||
    jobTypes.length > 0 ||
    notes.trim() !== '' ||
    times.changed ||
    price !== '' ||
    workOrder.trim() !== '' ||
    repeats
  // Each opening of the sheet is one draft, with its own request id
  // (`useDraftRequestId`), and its own Book, with the sheet's lock
  // (`useNewJobBooking`): once the booking is kept on the phone, closing the
  // sheet loses nothing, and asks nothing; and a confirmed "Discard your
  // changes?" discards the press under way as it is confirmed.
  const draft = useDraftRequestId()
  const convexCreate = useConvexMutation(api.jobs.create)
  const convexCreateRecurrence = useConvexMutation(api.recurrences.create)
  const booking = useNewJobBooking(
    changed,
    { booked: onBooked, close: onClose },
    (call) =>
      call.fn === 'jobs.create'
        ? convexCreate(call.args)
        : convexCreateRecurrence(call.args),
  )
  /**
   * Null while "Recurring Job" is chosen but the interval does not describe
   * one — an emptied count field, say, which native validation lets through
   * because the input is not `required`.
   *
   * Without this the submit handler passed `null` down the SAME branch a
   * one-off takes, so "Book job" quietly created a plain job, closed the
   * sheet and reported success. The person asked for a repeating job and got
   * one job, with nothing to say so.
   */
  const chosenInterval = repeats ? intervalFromDraft(interval) : null
  const intervalIncomplete = repeats && chosenInterval === null

  // No client is chosen until the person chooses one. This used to fill in
  // the business's oldest property on open, so a job booked in a hurry went
  // to whoever happened to be first in the list — and nothing on the form
  // said so.
  // New clients first ("Added recently"), then everyone A–Z. `now` is held
  // for the form's life, so the section does not reshuffle while it is open.
  const [openedAt] = useState(() => Date.now())
  const propertyOptionList = useMemo(
    () => propertyOptions(properties, { timezone, now: openedAt }),
    [properties, timezone, openedAt],
  )
  const [propertyMissing, setPropertyMissing] = useState(false)

  // One per client, from the client list — a client with no site yet
  // included, archived clients too, and each saying where its sites are (see
  // `clientOptions`).
  const clientOptionList = useMemo(
    () =>
      clientOptions(clientsForPicker(directory), { timezone, now: openedAt }),
    [directory, timezone, openedAt],
  )
  // From the client list, not the sites: a client with no site yet, chosen
  // here, stays chosen, and a business among them gets its site contact.
  const siteClient = clientOf(directory, siteClientId)
  const [clientMissing, setClientMissing] = useState(false)
  const clientTrigger = useRef<HTMLButtonElement>(null)
  const clientPicker = useRef<ComboboxHandle>(null)

  // A work order is mostly a business client's — a facilities company, an
  // agency — so for them the field is simply there. Anyone else can still
  // add one; a landlord's managing agent issues them too.
  const clientKind =
    mode === 'existing'
      ? properties.find((p) => p._id === propertyId)?.client.kind
      : mode === 'site'
        ? siteClient?.kind
        : newClient.kind
  // Kept open while it holds anything, so a value typed for one client is
  // never sent unseen after switching to another.
  const showWorkOrder =
    clientKind === 'business' || addingWorkOrder || workOrder !== ''
  const propertyTrigger = useRef<HTMLButtonElement>(null)
  // A choice the list stops offering while the sheet is open is dropped
  // rather than submitted as an id nobody can see. Nothing removes a property
  // today, but the list is scoped to the client directory (clientScope.ts),
  // and a narrower scope would take rows away mid-booking.
  useEffect(() => {
    if (propertyId && !properties.some((p) => p._id === propertyId))
      setPropertyId('')
  }, [properties, propertyId])
  // The same for the new site's client: gone from the client list, not
  // merely without a site.
  useEffect(() => {
    if (siteClientId && !clientOf(directory, siteClientId)) setSiteClientId('')
  }, [directory, siteClientId])
  // Held to the options, not just seeded once: a switch starting or ending
  // while the sheet is open changes who may be booked, and a stale id would
  // be submitted as-is and refused.
  const { options: assignees, preferred } = useAssigneeOptions(members)
  const access = useAccess()
  // Who may go beside the lead: whoever this person may book, but the lead.
  const alsoGoingOptions = assignees
    .filter((m) => m._id !== assignee)
    .map((m) => ({
      value: m._id,
      label: personLabel(m),
      detail: roleLabel(m.role),
    }))
  // Everyone also going as it will be booked: never the lead, and only
  // people still offered (someone removed from the team since drops out,
  // rather than showing as an id nobody can untick). Derived, so changing
  // the lead there and back loses nobody.
  const alsoGoingNow = alsoGoing.filter(
    (id) => id !== assignee && assignees.some((m) => m._id === id),
  )
  const leadName = (() => {
    if (assignee === access.membershipId) return 'you'
    const lead = assignees.find((m) => m._id === assignee)
    return lead ? personLabel(lead) : 'the lead'
  })()
  useEffect(() => {
    if (!assignees.some((m) => m._id === assignee)) setAssignee(preferred)
  }, [assignees, assignee, preferred])

  const hydrated = useHydrated()
  const lineDown = useLineDown()
  const lineDownId = useId()
  const clientChoiceId = useId()
  // Whether a booking made now would be kept on the phone: which words go
  // above Book job with the line down, until a press is under way, when
  // they follow where that press's booking is (`saysKept`).
  const canKeep = useCanKeep(draft.keepable)
  // The new client's or new site's address, email and phone, checked at Book:
  // what may be wrong is listed above the button, and a second press books it
  // as it is; and whether the caller is already a client (below). An
  // existing property has nothing to check. Book takes no press for half a
  // second as the list comes in under the thumb that pressed it.
  const saveWarnings = useSaveWarnings({ arm: true })

  // A repeating booking is a recurrence, not a job: creating it materialises
  // the first occurrence and every one after it, so the two paths are distinct
  // rather than "a job plus some extra rows". Either can be booked against an
  // existing property, a new site for an existing client, or a brand-new
  // client created in the same submit — both mutations accept any one of the
  // three and insert what is new in the same transaction, so a failure never
  // leaves an orphaned client or site behind.
  //
  // Which mutation, with what, is `bookingCall`'s (lib/outbox/outboxItem.ts):
  // the one mapping, which a booking kept on the phone to send later goes
  // through as well, so the two can never send a booking differently.
  //
  // Book writes the booking to the phone first where it can, and sends it
  // with the draft's request id either way (lib/outbox/book.ts): the sheet
  // closes on the job, or on the booking kept, and a refusal that made
  // nothing is thrown for FormAlert, as it always was.
  const create = useMutation({
    mutationFn: (args: SendableBooking) =>
      booking.session.book(args, draft, whoFor(args)),
  })

  /**
   * Who is booking, and what the card of a booking kept on the phone shows
   * until the real one lands (`bookingDisplay`), as the form has it at the
   * press.
   */
  function whoFor(args: SendableBooking): BookingWho {
    return {
      userId: signedInUserId(),
      lens: lensOf(access),
      membershipId: access.membershipId,
      business: { slug: business.slug, name: business.name },
      display: () => {
        const property = args.property
        const site =
          'propertyId' in property
            ? properties.find((p) => p._id === property.propertyId)
            : undefined
        // Who the card names to ask for, as a day this phone holds lists
        // that site: the client list doesn't say which contact is the one.
        const listed =
          site === undefined
            ? null
            : (keeper.findDayRowWhere(
                (row) =>
                  row.businessId === businessId && row.propertyId === site._id,
              )?.row ?? null)
        return bookingDisplay(args, {
          sites: properties,
          siteClient,
          roster: members,
          businessState,
          contactPerson: contactPersonFor(
            site?.client ?? siteClient,
            site?.contacts ??
              directory.contacts.filter((c) => c.clientId === siteClientId),
            listed,
          ),
        })
      },
    }
  }

  /**
   * Whose site it is comes first. Asked on the Book button's click as well as
   * on submit: the click runs before the browser checks the required address
   * fields below, which would otherwise send the person down to Street
   * address first, then back up to the client once that was filled.
   */
  function clientNeeded(): boolean {
    if (mode !== 'site' || siteClient) return false
    setClientMissing(true)
    clientTrigger.current?.focus()
    return true
  }
  // Only while it is still true: a client carried over from the Property
  // picker afterwards answers it.
  const showClientMissing = clientMissing && !siteClient

  /**
   * The booking as the form holds it now. Read when the save runs, which can
   * be up to 3 seconds after the press while the checks at Book answer: what
   * was typed meanwhile is what gets booked.
   */
  function bookingArgs() {
    const [hh, mm] = times.start.split(':').map(Number)
    // The picker gives a wall-clock time on the selected day, in the
    // tenant's own timezone — not the viewer's browser zone, which may
    // differ (a technician travelling, or simply a differently-configured
    // device) and would otherwise silently book the wrong instant.
    const scheduledAt = zonedDateTimeToUtc(day, hh, mm, timezone)
    return {
      businessId,
      property:
        mode === 'existing'
          ? { propertyId: propertyId as Id<'properties'> }
          : mode === 'site'
            ? {
                newProperty: newSiteArgs(
                  siteClientId as Id<'clients'>,
                  clientKind,
                  newSite,
                ),
              }
            : { newClient: newClientArgs(newClient) },
      assignedMembershipId: assignee as Id<'memberships'>,
      jobType: joinJobTypes(jobTypes),
      price: Math.round(Number(price || '0') * 100),
      scheduledAt,
      // Never null here: readyToBook, read just before, stops a booking
      // whose end is not after its start.
      durationMinutes: times.lengthOn(day, timezone)!,
      workOrder: workOrder.trim() || undefined,
      // Only for a one-off, and only when someone was added: a repeating
      // service takes people visit by visit, for now.
      alsoGoing:
        !repeats && alsoGoingNow.length > 0
          ? (alsoGoingNow as Array<Id<'memberships'>>)
          : undefined,
      // Left out when blank, so a booking without one never depends on a
      // backend that knows the field.
      notes: notes.trim() || undefined,
      repeat: chosenInterval,
    }
  }
  const latestBooking = useLatest(bookingArgs)

  /**
   * What must be settled before anything is booked, each saying what is
   * missing and moving to it. Checked at the press, and again when a booking
   * that waited on its checks at Book finally goes: a client or property
   * changed in a picker meanwhile does not type into the form, so nothing
   * else would notice it.
   */
  function readyToBook(): boolean {
    if (intervalIncomplete) return false
    // Checked here rather than by disabling "Book job": the button sits at
    // the foot of a long sheet, and a greyed-out button tells someone on the
    // phone to a customer nothing about what is missing.
    if (mode === 'existing' && !properties.some((p) => p._id === propertyId)) {
      setPropertyMissing(true)
      propertyTrigger.current?.focus()
      return false
    }
    if (clientNeeded()) return false
    // Below the client, so asked after it, the order the form reads in.
    if (jobTypes.length === 0) {
      setJobTypeMissing(true)
      jobTypeTrigger.current?.focus()
      return false
    }
    if (times.lengthOn(day, timezone) === null) {
      times.refuse()
      return false
    }
    return true
  }
  const latestReady = useLatest(readyToBook)

  /** Another client mode is another set of fields: warnings about the one
   * left are not about anything on screen. Back to New client, the booking
   * is the caller's own again: the caller's line a fix put in Notes goes,
   * and with it the fix's carry (`carried`, below). Any other change of
   * mode by hand ends what a Show them was waiting on (`pick`): a client
   * chosen after it is the person's own choice, not the fix's. Only
   * `keepPick` carries it on, from the picker Show them opened to the one
   * it hands over to. */
  function switchMode(
    next: (current: ClientMode) => ClientMode,
    { keepPick = false }: { keepPick?: boolean } = {},
  ) {
    saveWarnings.reset()
    const to = next(mode) === 'new' ? 'new' : 'other'
    if (to === 'new' && carried) {
      const line = carried.line
      setNotes((before) => withoutCallerLine(before, line))
    }
    setCarried((c) => carryAfter(c, { on: 'mode', to, handOver: keepPick }))
    setMode(next)
  }

  // Searching for the caller: a number or an email typed into either picker
  // is looked up by its key in the match index, so "08 9345 6789" finds a
  // client saved as "9345 6789", and a contact person's mobile finds their
  // business (lib/clientSearch.ts).
  const matchIndex = useMatchIndex(directory, business, members, access)
  const newClientIdPrefix = useId()
  // The Property picker's order, for listing a number's holders' sites first.
  const siteOrder = useMemo(() => {
    const byId = new Map<string, (typeof properties)[number]>(
      properties.map((p) => [p._id, p]),
    )
    return propertyOptionList.flatMap((o) => byId.get(o.value) ?? [])
  }, [properties, propertyOptionList])
  // The clients the Property picker has no row for, as the client picker
  // lists them: one with no site yet is found there by name or number too,
  // and offered a new site rather than a second record (`siteLessFound`).
  const siteLessOptions = useMemo(() => {
    const withSites = new Set<string>(properties.map((p) => p.clientId))
    return clientOptionList.filter((o) => !withSites.has(o.value))
  }, [properties, clientOptionList])

  /** "New site for {client}", for the one client a number or an email
   * finds, or the one with no site yet a name finds (`propertyListEnd`):
   * their new site, with the client chosen and focus on it, as "New site for
   * an existing client" does. */
  function newSiteFor(clientId: string) {
    let plan: FixPlan | null = null
    flushSync(() => {
      // From a Show them: the caller's address and what they said go with
      // it, as New site for {client} does at Book.
      plan = carryPick({
        kind: 'use',
        label: '',
        clientId: clientId as Id<'clients'>,
      })
      if (plan) return
      setSiteClientId(clientId)
      setClientMissing(false)
      switchMode(() => 'site')
    })
    const to = (plan as FixPlan | null)?.to
    if (to === 'existing') propertyTrigger.current?.focus()
    else clientTrigger.current?.focus()
  }
  /** Several clients with no site yet found: New site for, its list opened
   * with what was typed, so they come first there. */
  function chooseNewSiteFor(query: string) {
    flushSync(() => {
      setClientMissing(false)
      switchMode(() => 'site', { keepPick: true })
    })
    clientPicker.current?.openWith(query)
  }
  /** Nothing matched: a new client, with what was typed in the field it
   * belongs in, and focus there, so the person sees where it went. */
  function newClientWith(route: NoMatchRoute) {
    flushSync(() => {
      const field = route.fills
      if (field) setNewClient((v) => ({ ...v, [field]: route.value }))
      switchMode(() => 'new')
    })
    document
      .getElementById(
        newClientFieldId(newClientIdPrefix, route.fills ?? 'clientName'),
      )
      ?.focus()
  }
  // The pickers' rows act long after the render that made them.
  const latestNewSiteFor = useLatest(newSiteFor)
  const latestChooseNewSiteFor = useLatest(chooseNewSiteFor)
  const latestNewClientWith = useLatest(newClientWith)

  const propertyLookup = useCallback(
    (query: string): ComboboxLookup | null => {
      const holders = queryHolders(matchIndex, query)
      const named = namedClient(matchIndex, query)
      const found = siteLessFound(query, holders, siteLessOptions)
      const end = propertyListEnd(
        holders,
        named === null ? found : siteLessNamed(matchIndex, query, found),
        named,
      )
      if (!holders && !end) return null
      /** The row the list ends with (`propertyListEnd`). */
      const endRow = (at: PropertyListEnd): ComboboxAction | null => {
        if (at?.kind === 'several') {
          return {
            label: `New site for one of ${at.count} clients with no sites`,
            onSelect: () => latestChooseNewSiteFor.current(query),
          }
        }
        const client =
          at && matchIndex.clients.get(at.clientId as Id<'clients'>)
        return client
          ? {
              label: `New site for ${pickerName(client)}`,
              onSelect: () => latestNewSiteFor.current(client._id),
            }
          : null
      }
      return {
        first: holders ? holdersFirst(holders, siteOrder) : [],
        end: endRow(end),
      }
    },
    [
      matchIndex,
      siteOrder,
      siteLessOptions,
      latestNewSiteFor,
      latestChooseNewSiteFor,
    ],
  )
  const clientLookup = useCallback(
    (query: string): ComboboxLookup | null => {
      const holders = queryHolders(matchIndex, query)
      if (!holders) return null
      const atSites = holders.siteContactSiteIds.flatMap(
        (id) => properties.find((p) => p._id === id)?.clientId ?? [],
      )
      return { first: [...holders.clientIds, ...atSites] }
    },
    [matchIndex, properties],
  )
  const noMatchAction = useCallback(
    (query: string): ComboboxAction => {
      const route = noMatchRoute(query, matchIndex.areaCode)
      return {
        label: route.label,
        onSelect: () => latestNewClientWith.current(route),
        hint: <NewerClientsHint businessId={businessId} />,
      }
    },
    [businessId, matchIndex.areaCode, latestNewClientWith],
  )

  // ── Is the caller already a client? (the matching plan's M3) ──────────
  // At Book in New client and New site for, from the client list on the
  // phone, synchronously: who the caller may already be, each with a fix
  // that keeps what they said (lib/clientMatchRows.ts). And under Name,
  // Phone or Email as the person moves on to another field.
  const propertyPicker = useRef<ComboboxHandle>(null)
  const matchCtx = useMemo<MatchRowsContext>(
    () => ({ index: matchIndex, contacts: directory.contacts, verb: 'book' }),
    [matchIndex, directory.contacts],
  )
  // "Add 12 Watle St" tapped: that address is the client's to add, and the
  // next press isn't asked about it again.
  const [addedAnyway, setAddedAnyway] = useState<AddedAnyway | null>(null)
  // Where the rows were found, said once as they appear: "From the clients
  // on this phone, updated 9:42am."; and the rows themselves, by id, for
  // the foot to name the fix that is there (`matchFooter`).
  const [matchShown, setMatchShown] = useState<{
    notes: Array<string>
    rows: ReadonlyMap<string, MatchRow>
  }>({ notes: [], rows: new Map() })
  const directoryKey = rq.directory(businessId).queryKey

  // The booking left New client by a fix: the caller is who was typed
  // there, `line` is the caller's line that fix put first in Notes (taken
  // off again by the next fix, or if the booking goes back to New client),
  // and `pick` says a Show them opened a picker, whose choice carries the
  // caller too, as a fix would. Null otherwise.
  const [carried, setCarried] = useState<Carried>(null)
  /** A Show them's picker shut with nothing chosen: nothing waits on a
   * choice any more (`carryAfter`). */
  function endPick() {
    setCarried((c) => carryAfter(c, { on: 'dismissed' }))
  }
  // Where the last fix put the booking, for where focus goes after it.
  const fixedTo = useRef<FixPlan | null>(null)

  /** Who rang and where, as typed in New client (`planMatchFix`'s state). */
  function callerState(): FixState {
    return {
      mode: 'new',
      person: { name: newClient.clientName, phone: newClient.phone },
      site: {
        addressLine: newClient.addressLine,
        suburb: newClient.suburb,
        state: newClient.state,
        postcode: newClient.postcode,
        addressCheck: newClient.addressCheck,
        // A person's site contact is never shown, so never carried.
        siteContactName:
          newClient.kind === 'business' ? newClient.siteContactName : '',
        siteContactPhone:
          newClient.kind === 'business' ? newClient.siteContactPhone : '',
      },
      notes,
      callerLine: carried?.line ?? null,
      index: matchIndex,
      contacts: directory.contacts,
    }
  }
  /** New site for, as the form holds it: the caller still the one typed in
   * New client if a fix brought the booking here, else nobody. */
  function siteState(): FixState {
    return {
      mode: 'site',
      person: carried
        ? { name: newClient.clientName, phone: newClient.phone }
        : null,
      site: newSite,
      notes,
      callerLine: carried?.line ?? null,
      index: matchIndex,
      contacts: directory.contacts,
    }
  }

  /** A plan put into the form, through the setters. Another client mode
   * without a reset: the warnings of fields that stay on screen stay as
   * shown (the same address in New site for), and those of fields gone go
   * with them (SaveWarnings). The new client as typed stays, for the New
   * client tab. */
  function applyPlan(plan: FixPlan, fromCaller: boolean) {
    fixedTo.current = plan
    if (plan.to === 'picker') {
      setCarried((c) => carryAfter(c, { on: 'show' }))
      setMode(properties.length > 0 ? 'existing' : 'site')
      return
    }
    if (fromCaller) {
      setCarried((c) => carryAfter(c, { on: 'fix', line: plan.callerLine }))
    }
    setNotes(plan.notes)
    if (plan.to === 'existing') {
      setPropertyId(plan.propertyId)
      setPropertyMissing(false)
      setMode('existing')
    } else {
      setSiteClientId(plan.clientId)
      setClientMissing(false)
      setNewSite(plan.site)
      setAddedAnyway(plan.added)
      setMode('site')
    }
  }

  /** What a fix does to the form (`planMatchFix`), through the latest
   * setters: tapped from the panel or a field's line, perhaps long after
   * the check that offered it. */
  function applyMatchFix(fix: MatchFix) {
    const state = mode === 'site' ? siteState() : callerState()
    const plan = planMatchFix(fix, state)
    fixedTo.current = plan
    if (plan) applyPlan(plan, state.person !== null)
  }

  /**
   * A choice made in a picker a Show them opened: planned as the fix it
   * stands for (Book at the site chosen; New site for the client chosen),
   * so what the caller said goes with it as it does with any fix. Null when
   * no Show them is waiting on a choice.
   */
  function carryPick(fix: MatchFix): FixPlan | null {
    if (!carried?.pick) return null
    const plan = planMatchFix(fix, callerState())
    if (plan) applyPlan(plan, true)
    return plan
  }
  function pickedProperty(picked: string) {
    const site = properties.find((p) => p._id === picked)
    if (!site) return
    carryPick({
      kind: 'bookAt',
      label: '',
      clientId: site.clientId,
      propertyId: site._id,
    })
  }

  /** Then focus goes where the fix put things: the site chosen, the client
   * a new site is for, or into the picker it opened. */
  function focusAfterMatchFix() {
    const plan = fixedTo.current
    if (!plan) return
    if (plan.to === 'picker') {
      if (properties.length > 0) propertyPicker.current?.openWith(plan.query)
      else clientPicker.current?.openWith(plan.query)
    } else if (plan.to === 'existing') propertyTrigger.current?.focus()
    else clientTrigger.current?.focus()
  }
  const latestApplyMatchFix = useLatest(applyMatchFix)
  const latestFocusAfterMatchFix = useLatest(focusAfterMatchFix)
  // What a line's or the panel's fix moved up under the thumb takes no tap
  // for a moment.
  const lineFixHold = useLineFixHold()
  const panelFix = (fix: MatchFix): SaveWarningFix => ({
    label: fix.label,
    apply: () => {
      lineFixHold.taken()
      latestApplyMatchFix.current(fix)
    },
    focusAfter: () => latestFocusAfterMatchFix.current(),
  })
  const lineFix = (fix: MatchFix): FieldFix => ({
    label: fix.label,
    onApply: () => {
      lineFixHold.taken()
      flushSync(() => latestApplyMatchFix.current(fix))
      latestFocusAfterMatchFix.current()
    },
  })

  /** The rows at Book, as warnings of the panel's last kind. */
  function matchWarnings(): Array<SaveWarning> {
    const rows: Array<MatchRow> = bookingMatchRows(
      matchCtx,
      mode === 'site'
        ? {
            mode,
            clientId: siteClient?._id ?? null,
            site: newSite,
            added: addedAnyway,
          }
        : mode === 'new'
          ? {
              mode,
              typed: {
                name: newClient.clientName,
                phone: newClient.phone,
                email: newClient.email,
                site: {
                  addressLine: newClient.addressLine,
                  suburb: newClient.suburb,
                  postcode: newClient.postcode,
                },
              },
            }
          : { mode },
    )
    if (rows.length > 0) {
      setMatchShown({
        notes: matchNotes({
          behind: answerMayBeBehind(directoryKey),
          asOf: keeper.asOf([directoryKey]),
          timezone,
          today: todayKey(timezone),
          capped: directory.capped,
          contactsCapped: directory.contactsCapped ?? false,
        }),
        rows: new Map(rows.map((row) => [row.id, row])),
      })
      logConnectionChange('match-shown', {
        ...matchShownCounts(rows),
        live: keeper.isLive(directoryKey),
      })
    }
    return rows.map((row) => ({
      id: row.id,
      kind: 'match',
      label: row.label,
      message: row.message,
      ...(row.fix ? { fix: panelFix(row.fix) } : {}),
      ...(row.fix2 ? { fix2: panelFix(row.fix2) } : {}),
    }))
  }
  useSaveCheck(
    'new-job-client-match',
    mode === 'existing' ? null : matchWarnings,
    [
      mode,
      newClient.clientName,
      newClient.phone,
      newClient.email,
      newClient.addressLine,
      newClient.suburb,
      newClient.postcode,
      siteClientId,
      newSite.addressLine,
      newSite.suburb,
      newSite.postcode,
    ],
  )

  /** The line under Name, Phone or Email, decided as it is left. */
  const newClientMatchLine = (
    field: NewClientMatchField,
    value: NewClientFieldsValue,
  ): NewClientMatchLine | null => {
    const line = blurLine(matchCtx, field, {
      name: value.clientName,
      phone: value.phone,
      email: value.email,
      site: {
        addressLine: value.addressLine,
        suburb: value.suburb,
        postcode: value.postcode,
      },
    })
    return line
      ? {
          text: line.text,
          ...(line.fix ? { fix: lineFix(line.fix) } : {}),
          ...(line.fix2 ? { fix2: lineFix(line.fix2) } : {}),
          ...(line.nameFree ? { nameFree: true as const } : {}),
        }
      : null
  }
  const showsMatch = saveWarnings.warnings.some((w) => w.kind === 'match')

  const bookLabel = create.isPending
    ? 'Booking…'
    : saveWarnings.checking
      ? 'Checking…'
      : saveWarnings.warnings.length > 0
        ? 'Book anyway'
        : 'Book job'

  return (
    <SaveWarningsProvider value={saveWarnings}>
      <form
        className={`${SHEET_BODY} pt-3`}
        onMouseDownCapture={lineFixHold.onTapCapture}
        onClickCapture={lineFixHold.onTapCapture}
        onSubmit={(e) => {
          e.preventDefault()
          // The list has just come in under the thumb: a second tap of a
          // double tap books nothing (Book shows aria-disabled meanwhile).
          if (saveWarnings.isArmed()) return
          if (!readyToBook()) return
          // Only then the warnings: nothing is worth confirming on a booking
          // that is still missing its client. mutateAsync, so a booking that
          // fails keeps them confirmed and Retry does not ask again. The
          // event, so a booking that waits on its checks is held to the
          // browser's own checks again before it goes — and to this sheet's
          // own, which the browser knows nothing about.
          saveWarnings.guard(e, () =>
            latestReady.current()
              ? create.mutateAsync(latestBooking.current())
              : undefined,
          )
        }}
      >
        <Drawer.Title className="text-sheet-title text-ink">
          New job
        </Drawer.Title>

        {/* A client with no site yet is still a client to add one for. Not a
            Field: its <label> would name only the first segment. */}
        {directory.clients.length > 0 && (
          <div className="mt-4 flex flex-col gap-1.5">
            <span id={clientChoiceId} className="section-label">
              Client
            </span>
            <Segmented
              kind="choice"
              labelledBy={clientChoiceId}
              // A new site is still an existing client's, so that tab stays
              // chosen; tapping it again leaves the site being added alone.
              // With no site to choose yet, an existing client's job is at a
              // new site: that is where the tab goes.
              value={mode === 'new' ? 'new' : 'existing'}
              onChange={(next) =>
                switchMode((m) =>
                  next === 'existing' &&
                  (m === 'site' || properties.length === 0)
                    ? 'site'
                    : next,
                )
              }
              options={[
                { value: 'existing', label: 'Existing client' },
                { value: 'new', label: 'New client' },
              ]}
            />
          </div>
        )}

        {mode === 'existing' ? (
          <>
            <Field label="Property">
              <Combobox
                value={propertyId}
                onChange={(next) => {
                  setPropertyId(next)
                  setPropertyMissing(false)
                  pickedProperty(next)
                }}
                options={propertyOptionList}
                lookup={propertyLookup}
                noMatchAction={noMatchAction}
                placeholder="Search by name, address, phone or email"
                emptyLabel="Choose a client and address"
                noMatchLabel={
                  // Only while a push takes the last site away: the tab goes
                  // to New site for when there are none.
                  properties.length === 0
                    ? 'No sites yet — search for the client to add one.'
                    : 'No client or address matches.'
                }
                ariaLabel="Property"
                invalid={propertyMissing}
                errorId={PROPERTY_ERROR_ID}
                triggerRef={propertyTrigger}
                handleRef={propertyPicker}
                onDismiss={endPick}
              />
            </Field>
            {/* Outside the <label>: inside it, this sentence would become part
              of the field's name. */}
            {propertyMissing && (
              <p
                id={PROPERTY_ERROR_ID}
                role="alert"
                className="mt-1.5 text-caption text-red-ink"
              >
                Choose the client and address for this job.
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                // The client already found in the picker is most likely the
                // one with the new address, so it comes along.
                const picked = properties.find((p) => p._id === propertyId)
                flushSync(() => {
                  if (picked) setSiteClientId(picked.clientId)
                  switchMode(() => 'site')
                })
                clientTrigger.current?.focus()
              }}
              className="relative tap-target mt-3 inline-flex items-center gap-1 text-body font-semibold text-blue"
            >
              <Plus size={16} strokeWidth={2.2} />
              New site for an existing client
            </button>
          </>
        ) : mode === 'site' ? (
          <>
            <Field label="New site for">
              <Combobox
                value={siteClientId}
                onChange={(next) => {
                  setSiteClientId(next)
                  setClientMissing(false)
                  carryPick({
                    kind: 'use',
                    label: '',
                    clientId: next as Id<'clients'>,
                  })
                }}
                options={clientOptionList}
                lookup={clientLookup}
                noMatchAction={noMatchAction}
                title="Client"
                placeholder="Search by name, phone, email or suburb"
                emptyLabel="Choose a client"
                noMatchLabel="No client matches."
                ariaLabel="New site for"
                invalid={showClientMissing}
                errorId={CLIENT_ERROR_ID}
                triggerRef={clientTrigger}
                handleRef={clientPicker}
                onDismiss={endPick}
              />
            </Field>
            {showClientMissing && (
              <p
                id={CLIENT_ERROR_ID}
                role="alert"
                className="mt-1.5 text-caption text-red-ink"
              >
                Choose the client this site belongs to.
              </p>
            )}
            {/* The same ids as New client's address: after a fix brings the
                address here, what was shown about it there and confirmed
                stays confirmed (SaveWarnings), as it is the same address. */}
            <SiteAddressFields
              value={newSite}
              onChange={(patch) => setNewSite((v) => ({ ...v, ...patch }))}
              businessState={businessState}
              idPrefix={newClientIdPrefix}
            />
            {siteClient?.kind === 'business' && (
              <SiteContactFields
                value={newSite}
                onChange={(patch) => setNewSite((v) => ({ ...v, ...patch }))}
                businessState={businessState}
              />
            )}
            {/* Not while there is no site to choose. */}
            {properties.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  // Focus goes where the person is going, as it does the
                  // other way; left alone it falls back to the top of the
                  // sheet.
                  flushSync(() => switchMode(() => 'existing'))
                  propertyTrigger.current?.focus()
                }}
                className="relative tap-target mt-3 text-body font-semibold text-blue"
              >
                Choose an existing site instead
              </button>
            )}
          </>
        ) : (
          <NewClientFields
            value={newClient}
            onChange={(patch) => setNewClient((v) => ({ ...v, ...patch }))}
            businessState={businessState}
            idPrefix={newClientIdPrefix}
            matchLine={newClientMatchLine}
          />
        )}

        {showWorkOrder ? (
          <Field label="Work Order (Optional)">
            <input
              ref={workOrderInput}
              value={workOrder}
              onChange={(e) => setWorkOrder(e.target.value)}
              maxLength={MAX_WORK_ORDER_LENGTH}
              // Work-order numbers are codes, not words: capitals on the phone
              // keyboard, and nothing "corrected" into a dictionary word.
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. WO-448120"
              className={`${FIELD} w-full`}
            />
          </Field>
        ) : (
          // A button, not a Field: inside a <label> it would take the label's
          // name. type="button" so it can never be the form's submit.
          <button
            type="button"
            onClick={() => {
              // Rendered now, and focused while the tap is still being handled:
              // iOS opens the keyboard only for a focus inside the tap, so a
              // focus deferred to the next frame leaves a ring and no keyboard.
              flushSync(() => setAddingWorkOrder(true))
              workOrderInput.current?.focus()
            }}
            className="relative tap-target mt-3 inline-flex items-center gap-1 text-body font-semibold text-blue"
          >
            <Plus size={16} strokeWidth={2.2} />
            Add work order
          </button>
        )}

        <Field label="Job type">
          <JobTypePicker
            jobTypes={jobTypeList}
            value={jobTypes}
            onChange={(next) => {
              setJobTypes(next)
              if (next.length > 0) setJobTypeMissing(false)
            }}
            invalid={jobTypeMissing}
            errorId={JOB_TYPE_ERROR_ID}
            triggerRef={jobTypeTrigger}
          />
        </Field>
        {/* Outside the <label>, like the property's. */}
        {jobTypeMissing && (
          <p
            id={JOB_TYPE_ERROR_ID}
            role="alert"
            className="mt-1.5 text-caption text-red-ink"
          >
            Choose at least one job type.
          </p>
        )}

        <Field label="Assigned to">
          {assignees.length > 1 ? (
            <select
              value={assignee}
              onChange={(e) => {
                setAssignee(e.target.value)
                setAssigneeChosen(true)
              }}
              className={`${FIELD} w-full`}
            >
              {assignees.map((m) => (
                <option key={m._id} value={m._id}>
                  {personLabel(m)}
                </option>
              ))}
            </select>
          ) : (
            // Someone who can only book themselves has nothing to choose, and a
            // one-option select reads as a choice they are being denied.
            <p className="flex h-12 w-full items-center rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink">
              Assigned to you
            </p>
          )}
          <OffViewNote
            assignee={assignee}
            people={assignees}
            // A repeating service takes nobody else yet, so it goes on the
            // lead's schedule alone.
            alsoGoing={repeats ? [] : alsoGoingNow}
          />
        </Field>

        {/* A job two people work together. Not for a repeating service yet —
            its people are added visit by visit, from each visit's page — but
            the field stays where it is, saying so, rather than vanishing from
            above the Repeat control as it is turned on. */}
        {alsoGoingOptions.length > 0 &&
          (addingPeople || alsoGoingNow.length > 0 ? (
            <Field label="Also going">
              {repeats ? (
                <p className="flex min-h-12 w-full items-center rounded-xl bg-surface-3 px-3.5 py-2 text-body text-muted">
                  For a repeating service, add people to each visit from its job
                  page.
                </p>
              ) : (
                <Combobox
                  multiple
                  value={alsoGoingNow}
                  // Up to the server's limit: a sixth tick is not taken, and
                  // the sheet says why.
                  max={MAX_ALSO_GOING}
                  fullLabel={alsoGoingFullLabel(leadName, MAX_ALSO_GOING)}
                  onChange={(next) =>
                    setAlsoGoing(next.slice(0, MAX_ALSO_GOING))
                  }
                  options={alsoGoingOptions}
                  title="Also going"
                  description={`Everyone working this job with ${leadName}, up to ${MAX_ALSO_GOING}. They see it on their schedule, and can do everything on it that ${leadName} can.`}
                  placeholder="Search the team"
                  emptyLabel="Nobody else"
                  ariaLabel="Also going"
                />
              )}
            </Field>
          ) : (
            <button
              type="button"
              onClick={() => setAddingPeople(true)}
              className="relative tap-target mt-3 inline-flex items-center gap-1 text-body font-semibold text-blue"
            >
              <Plus size={16} strokeWidth={2.2} />
              Add someone else
            </button>
          ))}

        {pickDate && (
          <Field label="Date">
            <input
              type="date"
              required
              value={pickedDay}
              onChange={(e) => setDay(e.target.value)}
              className={`${FIELD} w-full`}
            />
          </Field>
        )}

        <JobTimeFields
          times={times}
          dayKey={day}
          timezone={timezone}
          idPrefix="new-job"
          className="mt-4"
        />

        <FieldGroup label="Repeat">
          <Segmented
            kind="choice"
            label="Repeat"
            value={repeats ? 'repeats' : 'once'}
            onChange={(v) => setRepeats(v === 'repeats')}
            disabled={!hydrated}
            options={[
              { value: 'once', label: 'One-off' },
              { value: 'repeats', label: 'Recurring Job' },
            ]}
          />
          {repeats && (
            <div className="mt-2">
              <RecurrenceFields
                value={interval}
                onChange={setInterval}
                idPrefix="new-job-repeat"
              />
            </div>
          )}
        </FieldGroup>

        <Field label="Price (AUD)">
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            className={`${FIELD} w-full`}
          />
        </Field>

        <Field label="Note for this visit (optional)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={MAX_JOB_NOTES_LENGTH}
            rows={3}
            autoCapitalize="sentences"
            placeholder="e.g. Tenant home after 10 — ring first"
            aria-describedby="new-job-notes-hint"
            className={`${FIELD_SURFACE} w-full py-3 leading-relaxed`}
          />
        </Field>
        {/* Outside the <label>, so it is not read as part of its name. It
            becomes a note in Notes on the job (`insertJobNote`), read by
            whoever can see the job. A series copies no note, so a repeating
            booking's is the first visit's; what every visit needs is a site
            note, which each visit shows. */}
        <p
          id="new-job-notes-hint"
          className="mt-1.5 text-caption text-grey-ink"
        >
          It goes in Notes, on this visit, for everyone who can see the job.
          {repeats &&
            ' On a repeating job it is the first visit’s; for every visit, add a site note.'}
        </p>

        <FormAlert
          error={create.isError ? create.error : null}
          copy={BOOKING_ERROR_COPY}
          className="mt-3"
        />
        <SaveWarningsPanel
          className="mt-3"
          anywayLabel="Book anyway"
          matchFooter={(shown) =>
            matchFooter(
              shown.map((w) => matchShown.rows.get(w.id) ?? {}),
              {
                anyway: 'Book anyway',
                adds: mode === 'site' ? 'site' : 'client',
              },
            )
          }
          note={
            showsMatch && matchShown.notes.length > 0
              ? matchShown.notes.join(' ')
              : undefined
          }
        />

        <div className="mt-5">
          {lineDown && (
            <p id={lineDownId} className="mb-2 text-caption text-ink-2">
              {bookingCaption(
                lineDown,
                saysKept({
                  pending: create.isPending,
                  path: booking.path,
                  canKeep,
                }),
              )}
            </p>
          )}
          <button
            type="submit"
            onClick={(e) => {
              if (saveWarnings.isArmed()) {
                e.preventDefault()
                return
              }
              if (clientNeeded()) e.preventDefault()
            }}
            disabled={create.isPending || !hydrated || intervalIncomplete}
            aria-disabled={saveWarnings.armed || undefined}
            aria-describedby={lineDown ? lineDownId : undefined}
            className={`${PRIMARY_BUTTON} ${HELD_BUTTON} w-full`}
          >
            {bookLabel}
          </button>
        </div>
      </form>
    </SaveWarningsProvider>
  )
}

/**
 * Under a picker's way in to a new client, where the list it searched may be
 * missing a client added since (`useNewerClientsHint`): decided as it shows,
 * and kept while it does.
 */
function NewerClientsHint({ businessId }: { businessId: Id<'businesses'> }) {
  const hint = useNewerClientsHint(rq.directory(businessId).queryKey)
  return hint ? (
    <p className="px-1 pt-1.5 text-caption text-grey-ink">{hint}</p>
  ) : null
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="mt-4 flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  )
}
/**
 * Like `Field`, but for a composite control rather than a single input.
 *
 * A `<label>` names exactly ONE control. Wrapping a group of them — a
 * segmented toggle, a number box, a unit select and a line of help text —
 * makes every descendant inherit the group's entire text as its accessible
 * name: the "One-off" tab came out called "Repeat Repeat Every 3 weeks,
 * starting from this job's date", which is both wrong for a screen reader and
 * ambiguous for anything matching controls by name. A labelled group is what
 * this shape actually is.
 */
function FieldGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div role="group" aria-label={label} className="mt-4 flex flex-col gap-1.5">
      {/* Already announced by the group's own name. */}
      <span className="section-label" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  )
}
