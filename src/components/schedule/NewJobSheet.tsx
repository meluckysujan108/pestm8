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
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { flushSync } from 'react-dom'
import { Drawer } from 'vaul'
import {
  SHEET_BODY,
  SheetShell,
  useSheetClose,
} from '#/components/primitives/Sheet'
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
import { convexCode } from '#/components/forms/describeError'
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
import { OUTBOX_ENABLED } from '#/lib/outbox/outboxSet'
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
  siteWorkDetail,
  siteWorkIndex,
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
  openWorkStanding,
  useNewerClientsHint,
  useOpenWork,
  useReadableAll,
} from '#/lib/offline/useKept'
import {
  NOTHING_SEEN,
  NOT_CHECKED,
  bookAtSees,
  bookingAt,
  bookingWork,
  matchClientsOf,
  namedWorkMoved,
  refusedMatchSees,
  refusedSiteRows,
  siteBehindNote,
  siteFooter,
  siteTargets,
  uncheckedKeysOf,
  withSeen,
  withSeenAll,
  workDayOf,
} from '#/lib/siteWorkRows'
import type {
  OpenWorkRow,
  RefusedSiteRow,
  Seen,
  Shows,
  SiteFix,
  SiteRow,
} from '#/lib/siteWorkRows'
import {
  FOUND_WHEN_SAVING,
  bookingSheetChecks,
  createHoldWait,
  createPressReads,
  joinSends,
  namedOnPanel,
  namedRowsOnPanel,
  pressChecks,
  rowKey,
  seesWholeSchedule,
  sendChecked,
  sendsByRow,
  sheetRefusalOf,
  standingSends,
  withSent,
} from '#/lib/sheetChecks'
import type { PressNote, SheetRefusal, SheetSends } from '#/lib/sheetChecks'
import { useMatchIndex } from '#/lib/useMatchIndex'
import {
  blurLine,
  bookingDismissed,
  bookingMatchRows,
  candidateHeld,
  carryAfter,
  matchFooter,
  matchNotes,
  matchShownCounts,
  planMatchFix,
  refusedMatchRows,
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
import { logConnection, logConnectionChange } from '#/lib/connectionLog'
import { todayKey } from '#/lib/format'
import { rq } from '#/lib/routeQueries'
import { personLabel, roleLabel, useAssigneeOptions } from '#/lib/assignees'
import { OffViewNote } from './OffViewNote'
import { JobTimeFields, useJobTimes } from './JobTimeFields'
import { SheetPending } from '#/components/shell/Pending'
import { EmptyState } from '#/components/primitives/EmptyState'
import { bookingErrorCopy } from './bookingCopy'
import { dayKeyOf, zonedDateTimeToUtc } from '../../../convex/lib/dates'
import { MAX_WORK_ORDER_LENGTH } from '../../../convex/lib/workOrder'
import { MAX_JOB_NOTES_LENGTH } from '../../../convex/lib/jobNotes'
import { joinJobTypes } from '../../../convex/lib/jobTypes'
import { HELD_BUTTON, PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { FIELD, FIELD_SURFACE } from '#/components/forms/FormField'
import { Plus } from 'lucide-react'
import { alsoGoingFullLabel } from '#/lib/jobPeople'
import { MAX_ALSO_GOING } from '../../../convex/lib/jobPeople'
import { useAccess } from '#/lib/access'
import { isOffline } from '#/lib/online'

/** 'site' is a new site for an existing client (Prompt 6.3). */
type ClientMode = 'existing' | 'new' | 'site'

/** What New Job's checks found at a press (lib/sheetChecks.ts
 * `createPressReads`), for the booking it sends (`sheetChecksFor`). */
type BookingPressRead = {
  /** Every client the matcher returned, and the work its rows named at
   * their sites (FW13), by row. */
  match: {
    dismissed: ReadonlyArray<Id<'clients'>>
    named: ReadonlyMap<string, ReadonlyArray<OpenWorkRow>>
  }
  /** What is seen once the site's rows are booked past. */
  site: Seen
  /**
   * What the site's rows showed, for a refused row's fix to book past as
   * the phone's own does (`refusedSiteFix`, `refusedMatchFix`): the rows,
   * the work match rows named at their sites, by row, and the "Not
   * checked" rows at the sites they were said for (`uncheckedKeysOf`),
   * with the day and repeat they were read for. The press's own, so a
   * press dropped since (the client mode switched while it waited)
   * answering late never says what a later one showed; read by the fix
   * from the press whose booking went (`pressShown`), never a later one
   * still checking, whose rows aren't drawn yet.
   */
  shown: {
    rows: ReadonlyArray<SiteRow>
    namedWork: ReadonlyMap<string, ReadonlyArray<OpenWorkRow>>
    read: ReadonlyArray<string>
    readFor: string
  }
}

const PROPERTY_ERROR_ID = 'new-job-property-error'
const CLIENT_ERROR_ID = 'new-job-client-error'
const JOB_TYPE_ERROR_ID = 'new-job-type-error'

/** An hour from nine, until the person says otherwise. */
const OPENING_TIMES = { start: '09:00', end: '10:00', length: 60 }

/**
 * How long a press of Book waits for what is booked at each site, with
 * signal and nothing of it on the phone yet ("Checking…"): long enough for
 * an answer on its way to land, short of the 3 s any check at Book is
 * given (SAVE_CHECK_TIMEOUT_MS), so the row saying the site couldn't be
 * checked is still said if it hasn't.
 */
export const OPEN_WORK_WAIT_MS = 2000

/**
 * A press of Book waiting for this week's answer of what is booked at each
 * site (`untilWorkHeld`): one wait for both checks of a press, let go as
 * the answer comes or plainly isn't coming (`settle`), or after `ms`. A
 * wait that ran out (`ranOut`) isn't waited again by the presses after it,
 * until what is held or coming changes (`reset`): the panel has said the
 * site couldn't be checked, and the Book anyway that confirms it, or each
 * press after an edit, would otherwise pay the 2 s again on a line that
 * isn't answering.
 */
export function createWorkWait(ms: number = OPEN_WORK_WAIT_MS) {
  let current: { promise: Promise<void>; go: () => void } | null = null
  let ranOut = false
  return {
    until(): Promise<void> {
      if (current) return current.promise
      let go = () => {}
      const promise = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          ranOut = true
          go()
        }, ms)
        go = () => {
          clearTimeout(timer)
          if (current?.promise === promise) current = null
          resolve()
        }
      })
      current = { promise, go }
      return promise
    },
    settle(): void {
      current?.go()
    },
    ranOut: (): boolean => ranOut,
    reset(): void {
      ranOut = false
    },
  }
}

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
  onOpenJob,
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
  /** How the page opens a job's sheet, for Open #123 at Book once New Job
   * has closed (the Schedule's, keeping its view and place). Without it,
   * the Schedule on the job's day. */
  onOpenJob?: (jobId: Id<'jobs'>, dayKey: string) => void
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
            onOpenJob={onOpenJob}
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
  onOpenJob,
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
  onOpenJob?: (jobId: Id<'jobs'>, dayKey: string) => void
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
  // Whether every job is theirs to see, as the server's check reads it
  // (`jobScope`: an owner in their own account, or "can see everyone's
  // schedule", intersected across a switch).
  const seesEveryJob = seesWholeSchedule(access)
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
  //
  // Sent straight, it goes with the checks at Book (the matching plan's M7,
  // `sheetChecksFor` below): what the phone found and the person booked
  // past, for the server to check again with the book as it is now. What
  // the server finds beyond it comes back as rows of the panel, in the
  // phone's own words (`showRefusal`), and Book anyway sends them back as
  // seen, under the same request id (lib/sheetChecks.ts `sendChecked`).
  // "Booking…" stays while a refusal's fixes wait for the client list to
  // hold what they book at (`refusalHeld`, up to HOLD_WAIT_MS), and no
  // longer than the panel would take their rows: an edit meanwhile ends it.
  const create = useMutation({
    mutationFn: (args: SendableBooking) => {
      // The first send carries what the press's checks found
      // (`sheetChecksFor`); sent again, what that send carried and what the
      // refusal named, never read afresh (`pressChecks`).
      const checks = pressChecks((extra) =>
        latestSheetChecks.current(args, extra),
      )
      return sendChecked({
        // Sent again at once, straight, as the send refused went.
        send: (extra, again) =>
          booking.session.book(
            args,
            draft,
            whoFor(args),
            checks(extra, again),
            { straight: again },
          ),
        // Only while nothing a check reads was edited since the press.
        asPressed: saveWarnings.asPressed,
        rowsOf: (refusal) => latestRefusalRows.current(refusal),
        // Only for rows to be shown: one sent again, or rows the panel
        // would turn down (`mayShow`), wait for nothing; and the wait ends
        // as soon as the panel would turn them down (an edit meanwhile).
        hold: (refusal, turnedDown) =>
          holdWait.until(
            () => turnedDown() || latestRefusalHeld.current(refusal),
          ),
        mayShow: saveWarnings.mayInject,
        listed: saveWarnings.listedNow,
        inject: (source, rows, sends, error) =>
          latestShowRefusal.current(source, rows, sends, error),
      })
    },
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
    // What a fix booked past (`seen`) was for the booking it made: changed
    // by hand, the booking is another, and is told of that work again, and
    // of what couldn't be checked.
    setSeen(NOTHING_SEEN)
    setUncheckedSeen({ workDay: '', keys: new Set() })
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
  /** A match row's fix, through the latest setters. `sees`: the work at
   * the site the row names, and the rows about that site beside it, which
   * its fix books past (FW13, `bookingWork`'s `fixSees`), so the press
   * after it isn't asked about any of it again. */
  const panelFix = (
    fix: MatchFix,
    sees: Shows | undefined,
    beside: ReadonlyArray<string>,
  ): SaveWarningFix => ({
    label: fix.label,
    apply: () => {
      lineFixHold.taken()
      // And what refused rows of the site's work standing named: the fix
      // takes them off with the rest, read beside this row.
      const refusedThere = refusedSiteSends()
      setSeen((s) => withSent(sees ? withSeen(s, sees) : s, refusedThere))
      seeUnchecked(beside, workDay)
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

  /** Who the caller may be is asked of, as the form holds it now: the new
   * client as typed, or the new site for the client chosen. */
  function matchAtNow(): Parameters<typeof bookingMatchRows>[1] {
    return mode === 'site'
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
        : { mode }
  }

  /** Who the caller may already be, as the form holds it now. */
  function matchRowsNow(): Array<MatchRow> {
    return bookingMatchRows(matchCtx, matchAtNow())
  }

  // ── Is the site already booked? (the matching plan's M5) ──────────────
  // At Book in every mode, from what is booked at each site as the phone
  // holds it (`useOpenWork`: this week's answer, or on a Monday with no
  // signal last week's): open work within a week of the booking at the
  // site chosen, or at the address typed, whoever's it is; and for a
  // Recurring Job, one already running there (lib/siteWorkRows.ts).
  // Synchronously, but for a phone with signal that holds nothing of it
  // yet, which waits a moment for it (`untilWorkHeld`). What it showed goes
  // with the booking (`siteCheck`, M7: `sheetChecksFor`), with `seen`, what
  // has been shown and booked past by a fix that named it.
  const openWork = useOpenWork(businessId, timezone)
  const [seen, setSeen] = useState<Seen>(NOTHING_SEEN)
  // What each press's checks found, as they answered: what its booking
  // sends (`sheetChecksFor`).
  const [pressReads] = useState(() => createPressReads<BookingPressRead>())
  // What each row a refusal put on the panel sends back with the next
  // press, by its check and id (`rowKey`), read as the save goes (before
  // React draws); and, for a fix that takes the site's rows off the panel,
  // what those of them still standing named (`refusedSiteSends`).
  const refusedSends = useRef<ReadonlyMap<string, SheetSends>>(new Map())
  const refusedSiteSends = () =>
    standingSends(
      refusedSends.current,
      saveWarnings.refusedNow(),
      'new-job-site-work',
    )
  // The "Not checked" rows a fix was taken beside, by the day and repeat
  // they were read for, at the sites they were said for (`uncheckedKeysOf`):
  // the press after the fix isn't asked them again, as it isn't the work
  // the fix marked seen, while the booking is checked at those sites; at
  // another (picked by hand after the fix, say), it is.
  const [uncheckedSeen, setUncheckedSeen] = useState<{
    workDay: string
    keys: ReadonlySet<string>
  }>({ workDay: '', keys: new Set() })
  /** A fix taken beside "Not checked" rows (`keys`, `uncheckedKeysOf`):
   * they are read. */
  const seeUnchecked = (keys: ReadonlyArray<string>, readFor: string) => {
    if (keys.length === 0) return
    setUncheckedSeen((s) => ({
      workDay: readFor,
      keys: new Set([...(s.workDay === readFor ? s.keys : []), ...keys]),
    }))
  }
  // What the last press found, said once as it appears: how old what it
  // read is, the rows by id for the foot, the match rows that named the
  // work at their site, and the day and repeat it was read for.
  const [siteShown, setSiteShown] = useState<{
    behind: Array<string>
    rows: ReadonlyMap<string, SiteRow>
    named: ReadonlySet<string>
    readFor: string | null
  }>({ behind: [], rows: new Map(), named: new Set(), readFor: null })
  // Who each job is for, as the rows name them.
  const people = useMemo(
    () => new Map<string, string>(members.map((m) => [m._id, personLabel(m)])),
    [members],
  )
  // The booking's day and repeat, which the work near it is read for: a
  // series' by its first visit, which the time can move (`workDayOf`).
  const workDay = workDayOf(bookingWhen()?.dayKey ?? day, chosenInterval)

  /** When the booking is, for the check: a series by its first visit
   * (`bookingAt`). Null while the time doesn't make one. */
  function bookingWhen(): { at: number; dayKey: string } | null {
    const [hh, mm] = times.start.split(':').map(Number)
    try {
      const scheduledAt = zonedDateTimeToUtc(day, hh, mm, timezone)
      if (!Number.isFinite(scheduledAt)) return null
      const at = bookingAt(
        { scheduledAt, repeat: chosenInterval },
        timezone,
        Date.now(),
      )
      return { at, dayKey: dayKeyOf(at, timezone) }
    } catch {
      return null
    }
  }

  /**
   * Both checks at Book from one reading of the form (`bookingWork`): the
   * match rows, each naming the work at the site it names (FW13); and the
   * site's own rows, less that work, which the match row has said, then
   * what couldn't be checked. Asked by each check, so either reads the
   * same.
   */
  function bookingChecks() {
    const matchRows = mode === 'existing' ? [] : matchRowsNow()
    // Seen: what fixes booked past, and what refused rows of the site's
    // work still standing named (`refusedSiteSends`). Once the phone's copy
    // holds that work too, its own row for it says more (the services, who)
    // than the server sent, and would read as news, so Book anyway past the
    // refused row would only show it again: it is the same work, shown.
    const checkSeen = withSent(seen, refusedSiteSends())
    const when = bookingWhen()
    if (!when) {
      return {
        matchRows,
        named: new Map<string, ReadonlyArray<OpenWorkRow>>(),
        fixSees: new Map<string, Shows>(),
        site: null,
        seen: checkSeen,
      }
    }
    const today = todayKey(timezone)
    const typed =
      mode === 'site'
        ? newSite
        : {
            addressLine: newClient.addressLine,
            suburb: newClient.suburb,
            postcode: newClient.postcode,
          }
    const targets =
      mode === 'existing'
        ? siteTargets(matchIndex, {
            mode,
            site: properties.find((p) => p._id === propertyId) ?? null,
          })
        : siteTargets(matchIndex, {
            mode,
            typed,
            clients:
              mode === 'site'
                ? siteClient
                  ? [siteClient._id]
                  : []
                : matchClientsOf(matchRows),
          })
    const work = bookingWork({
      held: openWork.held,
      dayKey: when.dayKey,
      matchRows,
      check: {
        timezone,
        today,
        at: when.at,
        repeats: chosenInterval !== null,
        targets,
        seen: checkSeen,
        index: matchIndex,
        people,
        typedAddress: typed.addressLine.trim(),
        // In New site for, booked only ever at the chosen client's site.
        ...(mode === 'site' ? { bookFor: siteClient?._id ?? null } : {}),
      },
      uncheckedSeen:
        uncheckedSeen.workDay === workDay ? uncheckedSeen.keys : undefined,
      // A date wholly past the weeks held is the server's to check (M7),
      // for someone who sees the whole schedule, where the booking goes
      // straight with `siteCheck`: only with the outbox off, as with it on
      // whether a press keeps the booking on the phone (which sends none
      // until 2c-J) is decided at the press itself, not here. The server
      // checks only work already on its books: a Recurring Job's visits
      // are made HORIZON_DAYS ahead (`uncheckedRows`).
      serverChecks: seesEveryJob && !OUTBOX_ENABLED,
    })
    return {
      matchRows: work.matchRows,
      named: work.named,
      fixSees: work.fixSees,
      site: { ...work, today, targets },
      seen: checkSeen,
    }
  }

  /**
   * Whether a press waits for this week's answer before either check says
   * anything: with a site to check, nothing of it on the phone yet, and it
   * on its way over a line that is up. Otherwise a phone just signed in
   * (every kept copy is cleared then), its answer a moment away, would say
   * the site can't be checked on it.
   */
  function waitsForWork(checks: ReturnType<typeof bookingChecks>): boolean {
    return (
      checks.site?.pick === 'none' &&
      checks.site.targets.length > 0 &&
      openWork.coming &&
      !workWait.ranOut() &&
      lineDown === null &&
      !isOffline()
    )
  }
  // The press waiting for it (`untilWorkHeld`), let go as it comes or once
  // it is plainly not coming (refused, say); one that ran out isn't waited
  // again until what is held or coming changes.
  const [workWait] = useState(createWorkWait)
  const workSettled = openWork.held.length > 0 || !openWork.coming
  useEffect(() => {
    if (workSettled) workWait.settle()
  }, [workWait, workSettled])
  useEffect(() => {
    workWait.reset()
  }, [workWait, openWork.held.length, openWork.coming])
  /** Until this week's answer is held, or isn't coming after all, or
   * OPEN_WORK_WAIT_MS have gone ("Checking…" meanwhile): one wait for both
   * checks of a press, so they read the same. */
  function untilWorkHeld(): Promise<void> {
    return workWait.until()
  }

  /** The rows at Book, as warnings of the panel's last kind; and what they
   * found, noted for the press (`note`): every client the matcher returned,
   * and the work its rows named at their sites, which the booking sends
   * (`sheetChecksFor`). */
  function matchWarnings(
    note: PressNote<BookingPressRead>,
    checks: ReturnType<typeof bookingChecks> = bookingChecks(),
  ): Array<SaveWarning> {
    const { matchRows: rows, fixSees } = checks
    note('match', {
      dismissed: bookingDismissed(matchCtx, matchAtNow()),
      named: checks.named,
    })
    // What couldn't be checked, said beside them, at the sites it was
    // said for (`seeUnchecked`).
    const beside = uncheckedKeysOf(
      checks.site?.unchecked ?? [],
      checks.site?.targets ?? [],
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
      ...(row.fix
        ? { fix: panelFix(row.fix, fixSees.get(row.id), beside) }
        : {}),
      ...(row.fix2
        ? { fix2: panelFix(row.fix2, fixSees.get(row.id), beside) }
        : {}),
    }))
  }
  const latestMatchWarnings = useLatest(matchWarnings)
  // A match row's words about its site's work (FW13) are of the work near
  // the date: moved, or the repeat changed, those rows go, as the site's
  // own do; rows naming no work stay, as they always have (M3), and so not
  // a dependency of the check below, which would take every row it gave.
  // Every such row listed, on screen or not (a refusal's rows shown alone,
  // the list closed after a Book anyway that failed); never a refusal's
  // row in a match row's place, whose words name none of the work.
  const refusedRows = saveWarnings.injected
  const matchNamesWork = saveWarnings.listed.some(
    (w) =>
      w.kind === 'match' &&
      siteShown.named.has(w.id) &&
      !refusedRows.includes(w),
  )
  const namedMoved = namedWorkMoved({
    naming: matchNamesWork,
    workDay,
    readFor: siteShown.readFor,
  })
  const namedRows = siteShown.named
  const dropRows = saveWarnings.drop
  const injectedNow = saveWarnings.injectedNow
  useEffect(() => {
    if (namedMoved === null) return
    const refused = injectedNow()
    dropRows(
      'new-job-client-match',
      (w) => namedRows.has(w.id) && !refused.some((r) => r === w),
    )
  }, [dropRows, namedMoved, namedRows, injectedNow])
  useSaveCheck(
    'new-job-client-match',
    mode === 'existing'
      ? null
      : (signal) => {
          const note = pressReads.begin(signal)
          const checks = bookingChecks()
          return waitsForWork(checks)
            ? untilWorkHeld().then(() => latestMatchWarnings.current(note))
            : matchWarnings(note, checks)
        },
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
    // This form's own: the provider is rendered below, by this component.
    saveWarnings,
  )

  /** Open #123: New Job closes as ✕ closes it, asking first about what was
   * changed, and that job's sheet opens: live, the phone's copy of it, or
   * its "opens when you have signal". On the Schedule, by the page's own
   * way of opening a job (`onOpenJob`: the view kept, and the place in
   * it); anywhere else, the Schedule on the job's day. */
  const closeSheet = useSheetClose()
  const navigate = useNavigate()
  function openJob(fix: Extract<SiteFix, { kind: 'openJob' }>) {
    closeSheet(() => {
      if (onOpenJob) {
        onOpenJob(fix.jobId, fix.dayKey)
        return
      }
      void navigate({
        to: '/$businessSlug/schedule',
        params: { businessSlug: business.slug },
        search: { date: fix.dayKey, jobId: fix.jobId },
      })
    })
  }
  const latestOpenJob = useLatest(openJob)
  /** A site row's fix: open the job; or book at the site, past every row
   * the panel showed of the site's work, and the work a match row named
   * there (`bookAtSees`), and what it said couldn't be checked (so the
   * press after it isn't asked about any of it again: the person read them
   * all, and the rows, about the address as typed, go with it). */
  const siteFix = (
    fix: SiteFix,
    shown: ReadonlyArray<SiteRow>,
    named: ReadonlyMap<string, ReadonlyArray<OpenWorkRow>>,
    read: ReadonlyArray<string>,
  ): SaveWarningFix =>
    fix.kind === 'openJob'
      ? {
          label: fix.label,
          apply: () => latestOpenJob.current(fix),
          // The row stays while "Discard your changes?" asks: kept
          // editing, the person is still looking at it; it goes with the
          // sheet.
          keepsRow: true,
        }
      : {
          label: fix.label,
          apply: () => {
            lineFixHold.taken()
            // With what refused rows beside them named: Book at takes
            // those off too.
            const refusedThere = refusedSiteSends()
            setSeen((s) =>
              withSent(
                withSeenAll(s, bookAtSees(fix.propertyId, shown, named)),
                refusedThere,
              ),
            )
            seeUnchecked(read, workDay)
            latestApplyMatchFix.current(fix)
          },
          focusAfter: () => latestFocusAfterMatchFix.current(),
        }

  /** The site's rows at Book, as warnings of the panel's very last kind:
   * the work found, then what couldn't be checked (`uncheckedRows`); and
   * what is seen once they are booked past, noted for the press (`note`),
   * which the booking sends (`sheetChecksFor`). */
  function siteWarnings(
    note: PressNote<BookingPressRead>,
    checks: ReturnType<typeof bookingChecks> = bookingChecks(),
  ): Array<SaveWarning> {
    const { named, site } = checks
    const standing = site?.read
      ? openWorkStanding(site.read)
      : { behind: false, asOf: null }
    const found = site?.found ?? []
    note('site', withSeenAll(checks.seen, found))
    const rows = site ? [...found, ...site.unchecked] : []
    const behind = site
      ? siteBehindNote({
          said: found.length > 0 || named.size > 0,
          behind: standing.behind,
          asOf: standing.asOf,
          timezone,
          today: site.today,
        })
      : null
    setSiteShown({
      behind: behind === null ? [] : [behind],
      rows: new Map(rows.map((row) => [row.id, row])),
      named: new Set(named.keys()),
      readFor: workDay,
    })
    // What couldn't be checked, at the sites it was said for.
    const read = site ? uncheckedKeysOf(site.unchecked, site.targets) : []
    // And for a refused row's fix, in the press's own record, read only
    // once this press's booking has gone (`pressShown`): never while it is
    // still checking, nor once it is dropped (the client mode switched
    // while it waited); nothing goes in where it ran out of time
    // (`createPressReads`).
    note('shown', { rows, namedWork: named, read, readFor: workDay })
    return rows.map((row) => ({
      id: row.id,
      kind: 'site',
      label: row.label,
      message: row.message,
      ...(row.counts ? { counts: row.counts } : {}),
      ...(row.fix ? { fix: siteFix(row.fix, rows, named, read) } : {}),
      ...(row.fix2 ? { fix2: siteFix(row.fix2, rows, named, read) } : {}),
    }))
  }
  const latestSiteWarnings = useLatest(siteWarnings)
  useSaveCheck(
    'new-job-site-work',
    (signal) => {
      const note = pressReads.begin(signal)
      const checks = bookingChecks()
      return waitsForWork(checks)
        ? untilWorkHeld().then(() => latestSiteWarnings.current(note))
        : siteWarnings(note, checks)
    },
    [
      mode,
      propertyId,
      workDay,
      siteClientId,
      newSite.addressLine,
      newSite.suburb,
      newSite.postcode,
      newClient.clientName,
      newClient.phone,
      newClient.email,
      newClient.addressLine,
      newClient.suburb,
      newClient.postcode,
      seen,
      uncheckedSeen,
    ],
    // This form's own, as the check above.
    saveWarnings,
  )
  // ── What the server found as the booking went (the matching plan's M7) ──
  // A refusal's rows, by id, for the panel's foot (`matchFooter`,
  // `siteFooter`); what each sends back as seen with the next press
  // (`refusedSends`, above); the refusal whose rows are on the panel, which
  // FormAlert doesn't say again; and the refusals shown, newest first, with
  // whether the client list held what their fixes book at when they were
  // read: one that didn't is read again once it does (`refreshRefused`).
  const [refused, setRefused] = useState<{
    match: ReadonlyMap<string, MatchRow>
    site: ReadonlyMap<string, RefusedSiteRow>
  }>({ match: new Map(), site: new Map() })
  const [shownRefusal, setShownRefusal] = useState<unknown>(null)
  const refusalsShown = useRef<
    Array<{
      source: string
      refusal: SheetRefusal
      ids: ReadonlyArray<string>
      held: boolean
    }>
  >([])
  // A refusal's fixes wait for the live client list to hold what they book
  // at (the picker needs the option), or for the panel to turn their rows
  // down: asked again as each answer lands, and after every edit, once the
  // checks above have told the panel of it (each commit: their effects run
  // before this one).
  const [holdWait] = useState(createHoldWait)
  useEffect(() => holdWait.poke())

  /**
   * What the booking sends with it (lib/sheetChecks.ts `bookingSheetChecks`):
   * what the press's checks found as they answered (`pressReads`), never
   * the form read again as it goes, so a client or job the phone took in
   * while a slower check was still looking is the server's to name: every
   * client the phone's matcher returned, with a new client or site; the
   * work the site rows showed, and what match rows named, with what fixes
   * booked past (`seen`); and what refusals named that is still on the
   * panel, shown or confirmed, with what an earlier send of this press was
   * refused for (`extra`).
   */
  function sheetChecksFor(args: SendableBooking, extra: SheetSends) {
    // Kept as the press whose booking went, for a refused row's fix
    // (`pressShown`).
    const read = pressReads.sending()
    const injected = saveWarnings.injectedNow()
    // The work match rows say in the phone's own words; not where a
    // refusal's row stands in a match row's place, which says none of it,
    // so the server names it (`namedOnPanel`).
    const named = namedOnPanel(
      read.match?.named ?? new Map(),
      injected,
      'new-job-client-match',
    )
    return bookingSheetChecks({
      property: args.property,
      // None where the match check found nothing in time, or isn't asked
      // (a site chosen).
      dismissed: read.match?.dismissed ?? [],
      // The site check's, or, where it found nothing in time, what fixes
      // booked past.
      seen: withSeenAll(read.site ?? seen, [
        { shows: { rows: named, series: [] } },
      ]),
      sends: joinSends(
        extra,
        standingSends(refusedSends.current, saveWarnings.refusedNow()),
      ),
    })
  }
  const latestSheetChecks = useLatest(sheetChecksFor)

  /** Whether the client list holds what a refusal's fixes book at: each
   * client the server found, and the site it matched them at; at an
   * address typed, each site the work is at. */
  function refusalHeld(refusal: SheetRefusal): boolean {
    if (refusal.code === 'MATCHED_CLIENT') {
      return refusal.candidates.every((c) => candidateHeld(matchIndex, c))
    }
    if (refusal.code === 'SITE_BOOKED' && mode !== 'existing') {
      return refusal.rows.every((r) => matchIndex.siteKeys.has(r.propertyId))
    }
    return true
  }
  const latestRefusalHeld = useLatest(refusalHeld)

  /**
   * What the press refused showed, read as a refused row's fix is tapped:
   * the own record (`siteWarnings`' `shown`) of the newest press whose
   * booking went (`sent`), every row of which was on the panel and booked
   * past before it could go. Never the newest press's: one still
   * "Checking…" (an email's domain, a street) has noted rows the panel
   * hasn't drawn, and the refused rows can still be tapped meanwhile; nor
   * one dropped since and answering late. Its site's rows; the work match
   * rows named at their sites in the phone's own words, while their rows
   * stand (FW13, `namedRowsOnPanel`: a refusal's row in one's place names
   * none); and its "Not checked" rows, with the day and repeat they were
   * read for. Null where its site check found nothing in time.
   */
  function pressShown() {
    const shown = pressReads.sent()?.shown
    if (!shown) return null
    return {
      rows: shown.rows,
      named: namedRowsOnPanel(
        shown.namedWork,
        saveWarnings.injectedNow(),
        'new-job-client-match',
      ),
      read: shown.read,
      readFor: shown.readFor,
    }
  }

  /** A refused row's fix about the site's work: open the job; or book at
   * the site, past what every refused row of the site's work standing named
   * (this refusal's and an earlier one's: Book at takes them all off the
   * panel), and what the press refused showed (`pressShown`), as the
   * phone's Book at does (`siteFix`): the panel's own rows, the work a
   * match row named there, and its "Not checked" rows, read. */
  const refusedSiteFix = (fix: SiteFix): SaveWarningFix =>
    fix.kind === 'openJob'
      ? {
          label: fix.label,
          apply: () => latestOpenJob.current(fix),
          keepsRow: true,
        }
      : {
          label: fix.label,
          apply: () => {
            lineFixHold.taken()
            const refusedThere = refusedSiteSends()
            const shown = pressShown()
            setSeen((s) =>
              withSent(
                shown
                  ? withSeenAll(
                      s,
                      bookAtSees(fix.propertyId, shown.rows, shown.named),
                    )
                  : s,
                refusedThere,
              ),
            )
            if (shown) seeUnchecked(shown.read, shown.readFor)
            latestApplyMatchFix.current(fix)
          },
          focusAfter: () => latestFocusAfterMatchFix.current(),
        }

  /** A refused match row's fix: as the phone's own (`panelFix`), but what
   * it books past is read as it is tapped, from what the press refused
   * showed (`pressShown`): the work at the site it books at
   * (`refusedMatchSees`; by then these rows stand in the place of any
   * phone row of their id, whose words are gone), and its "Not checked"
   * rows, for the day and repeat they were read for, never the form's as
   * the row was read (the date moved while "Booking…" showed). */
  const refusedMatchFix = (fix: MatchFix, row: MatchRow): SaveWarningFix => ({
    label: fix.label,
    apply: () => {
      lineFixHold.taken()
      const refusedThere = refusedSiteSends()
      const shown = pressShown()
      const sees = shown && refusedMatchSees(row, shown.rows, shown.named)
      setSeen((s) => withSent(sees ? withSeen(s, sees) : s, refusedThere))
      if (shown) seeUnchecked(shown.read, shown.readFor)
      latestApplyMatchFix.current(fix)
    },
    focusAfter: () => latestFocusAfterMatchFix.current(),
  })

  /** A refusal's rows, as warnings of the panel, from the form as it is
   * now (`refusedMatchRows`, `refusedSiteRows`), each with the row its
   * foot reads. */
  function refusalRows(refusal: SheetRefusal): {
    source: string
    rows: Array<SaveWarning & { foot: MatchRow | RefusedSiteRow }>
  } {
    if (refusal.code === 'MATCHED_CLIENT') {
      const source = 'new-job-client-match'
      const at = matchAtNow()
      if (at.mode === 'existing' || (at.mode === 'site' && !at.clientId)) {
        return { source, rows: [] }
      }
      // Their words are the server's, and name none of the work at their
      // sites, but their fixes book past what the press refused showed at
      // the site they book at, and read its "Not checked" rows, as the
      // phone's own match row's do (`refusedMatchFix`).
      const rows = refusedMatchRows(
        matchCtx,
        refusal,
        at.mode === 'new'
          ? at
          : {
              mode: 'site',
              clientId: at.clientId as Id<'clients'>,
              site: at.site,
            },
      )
      return {
        source,
        rows: rows.map((row) => ({
          id: row.id,
          kind: 'match',
          label: row.label,
          message: row.message,
          ...(row.fix ? { fix: refusedMatchFix(row.fix, row) } : {}),
          ...(row.fix2 ? { fix2: refusedMatchFix(row.fix2, row) } : {}),
          foot: row,
        })),
      }
    }
    const source = 'new-job-site-work'
    const chosen = properties.find((p) => p._id === propertyId)
    const rows = refusedSiteRows(refusal, {
      timezone,
      today: todayKey(timezone),
      at:
        mode === 'existing'
          ? { mode, site: { addressLine: chosen?.addressLine ?? '' } }
          : mode === 'site'
            ? { mode, typed: newSite, bookFor: siteClient?._id ?? null }
            : {
                mode,
                typed: {
                  addressLine: newClient.addressLine,
                  suburb: newClient.suburb,
                  postcode: newClient.postcode,
                },
              },
      siteOf: (id) => properties.find((p) => p._id === id),
      clientOf: (id) => matchIndex.clients.get(id),
    })
    return {
      source,
      rows: rows.map((row) => ({
        id: row.id,
        kind: 'site',
        label: row.label,
        message: row.message,
        ...(row.counts ? { counts: row.counts } : {}),
        ...(row.fix ? { fix: refusedSiteFix(row.fix) } : {}),
        ...(row.fix2 ? { fix2: refusedSiteFix(row.fix2) } : {}),
        foot: row,
      })),
    }
  }
  const latestRefusalRows = useLatest(refusalRows)

  /** What the panel's foot reads of rows a refusal put on it. */
  function noteFeet(
    rows: ReadonlyArray<{ id: string; foot: MatchRow | RefusedSiteRow }>,
  ) {
    setRefused((before) => {
      const match = new Map(before.match)
      const site = new Map(before.site)
      for (const { id, foot } of rows) {
        if ('tier' in foot) match.set(id, foot)
        else site.set(id, foot)
      }
      return { match, site }
    })
  }

  /**
   * A refusal's rows read again, in place, once the client list holds what
   * their fixes book at (`refusalHeld`) where it didn't as they were read:
   * "Open Jane Nguyen from Clients to book this job." becomes the row with
   * Use Jane Nguyen, however long after the refusal the list catches up.
   * Only rows still standing (`SaveWarningsController.refresh`), the newest
   * refusal's for each, and the hold starts as their fixes come in.
   */
  function refreshRefused() {
    const standing = saveWarnings.injectedNow()
    const stands = (source: string, id: string) =>
      standing.some((w) => w.source === source && w.id === id)
    refusalsShown.current = refusalsShown.current.filter((entry) =>
      entry.ids.some((id) => stands(entry.source, id)),
    )
    // Each row as the newest refusal that put it on says it.
    const newer = new Set<string>()
    for (const entry of refusalsShown.current) {
      const own = entry.ids.filter(
        (id) => !newer.has(rowKey({ source: entry.source, id })),
      )
      for (const id of entry.ids)
        newer.add(rowKey({ source: entry.source, id }))
      if (entry.held || !refusalHeld(entry.refusal)) continue
      entry.held = true
      const { source, rows } = refusalRows(entry.refusal)
      const now = rows.filter(
        (row) =>
          source === entry.source &&
          own.includes(row.id) &&
          stands(source, row.id),
      )
      if (now.length > 0 && saveWarnings.refresh(source, now)) noteFeet(now)
    }
  }
  const latestRefreshRefused = useLatest(refreshRefused)
  useEffect(
    () => latestRefreshRefused.current(),
    [latestRefreshRefused, matchIndex],
  )

  /** A refusal's rows on the panel (`SaveWarningsController.inject`), with
   * what they send back, unless the form has changed since the press it
   * refused: then FormAlert says it (`bookingErrorCopy`), and the next
   * press checks the form as it is now. Noted by counts and code only. */
  function showRefusal(
    source: string,
    rows: ReadonlyArray<SaveWarning & { foot: MatchRow | RefusedSiteRow }>,
    sends: SheetSends,
    error: unknown,
  ) {
    // What stood before these went on, for what a row of the same id sent.
    const before = saveWarnings.refusedNow()
    // Each row as the panel draws it; what its foot reads rides along.
    const shown = rows.length > 0 && saveWarnings.inject(source, rows)
    logConnection('sheet-refused', {
      code: convexCode(error) ?? '',
      rows: rows.length,
      shown,
    })
    if (!shown) return
    // A row put back in the place of one of its id still standing keeps
    // what that one sent too (`sendsByRow`).
    refusedSends.current = sendsByRow(
      refusedSends.current,
      before,
      source,
      rows,
      sends,
    )
    const refusal = sheetRefusalOf(error)
    if (refusal) {
      refusalsShown.current = [
        {
          source,
          refusal,
          ids: rows.map((row) => row.id),
          held: refusalHeld(refusal),
        },
        ...refusalsShown.current,
      ]
    }
    noteFeet(rows)
    setShownRefusal(error)
  }
  const latestShowRefusal = useLatest(showRefusal)

  // The Property picker's line for each site, from the newest answer held:
  // "Booked Thu 30 Oct", "Repeats every 3 months, next Mon 12 Jan", "Last
  // visit Wed 15 Oct" (`siteWorkDetail`).
  // By site, once per answer (`siteWorkIndex`): the picker decides up to a
  // hundred rows as they first show.
  const pickerWork = openWork.held.at(0)?.work
  const pickerIndex = useMemo(
    () => (pickerWork ? siteWorkIndex(pickerWork) : null),
    [pickerWork],
  )
  const pickerDetail = useCallback(
    (value: string) =>
      pickerIndex
        ? siteWorkDetail(pickerIndex, value, {
            timezone,
            today: todayKey(timezone),
          })
        : undefined,
    [pickerIndex, timezone],
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
  // Rows a refusal put on the panel: the server's, so the notes about the
  // copy on the phone aren't theirs; their own is FOUND_WHEN_SAVING.
  const fromServer = new Set(saveWarnings.injected.map((w) => w.id))
  const showsMatch = saveWarnings.warnings.some(
    (w) => w.kind === 'match' && !fromServer.has(w.id),
  )
  // How old what the site's rows, or a match row's line about the work at
  // its site, were read from, only while they show.
  const showsWork = saveWarnings.warnings.some(
    (w) =>
      !fromServer.has(w.id) &&
      ((w.kind === 'site' && siteShown.rows.get(w.id)?.label !== NOT_CHECKED) ||
        (w.kind === 'match' && siteShown.named.has(w.id))),
  )
  const showsRefused = saveWarnings.warnings.some((w) => fromServer.has(w.id))
  const panelNotes = [
    ...(showsMatch ? matchShown.notes : []),
    ...(showsWork ? siteShown.behind : []),
    ...(showsRefused ? [FOUND_WHEN_SAVING] : []),
  ]

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
                detailOf={pickerDetail}
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

        {/* Not for a refusal whose rows the panel shows: they say it. */}
        <FormAlert
          error={
            create.isError && create.error !== shownRefusal
              ? create.error
              : null
          }
          // As the booking was sent: a new site for a client has words of
          // its own for MATCHED_CLIENT.
          copy={bookingErrorCopy(
            create.variables?.property,
            (id) => matchIndex.clients.get(id)?.name,
          )}
          className="mt-3"
        />
        <SaveWarningsPanel
          className="mt-3"
          anywayLabel="Book anyway"
          matchFooter={(shown) =>
            matchFooter(
              shown.map(
                (w) =>
                  (fromServer.has(w.id)
                    ? refused.match.get(w.id)
                    : matchShown.rows.get(w.id)) ?? {},
              ),
              {
                anyway: 'Book anyway',
                adds: mode === 'site' ? 'site' : 'client',
              },
            )
          }
          siteFooter={(shown) =>
            siteFooter(
              shown.map((w) => {
                if (!fromServer.has(w.id)) return siteShown.rows.get(w.id) ?? {}
                const row = refused.site.get(w.id)
                return { fix: row?.fix, fix2: row?.fix2 }
              }),
              'Book anyway',
            )
          }
          note={panelNotes.length > 0 ? panelNotes.join(' ') : undefined}
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
