import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { SHEET_BODY, SheetShell } from '#/components/primitives/Sheet'
import { DropdownMenu } from 'radix-ui'
import {
  Camera,
  Check,
  ChevronDown,
  Pencil,
  Repeat,
  Trash2,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { Combobox } from '#/components/primitives/Combobox'
import { ContactButtons } from '#/components/primitives/ContactButtons'
import { StatusPill } from '#/components/primitives/StatusPill'
import { JOB_STATUS } from '#/lib/statusColours'
import { Segmented } from '#/components/primitives/Segmented'
import {
  JOB_TYPES,
  formatDuration,
  formatJobDate,
  formatJobMoney,
  formatTime,
} from '#/lib/format'
import { WeatherGlyph } from './WeatherGlyph'
import { WeatherCredit } from './WeatherCredit'
import { isWet, isWindy, useWeather } from '#/lib/weather'
import { useHydrated } from '#/lib/useHydrated'
import { propertyOptions } from '#/lib/propertyOptions'
import { prepareUpload } from '#/lib/images/prepareUpload'
import { personLabel, useAssigneeOptions } from '#/lib/assignees'
import { OffViewNote } from './OffViewNote'
import { RowPending, SheetPending } from '#/components/shell/Pending'
import { dayKeyOf, timeKeyOf, zonedDateTimeToUtc } from '../../../convex/lib/dates'
import { describeInterval, describeRepeat } from '../../../convex/lib/recurrence'
import type { Interval } from '../../../convex/lib/recurrence'
import { MAX_WORK_ORDER_LENGTH } from '../../../convex/lib/workOrder'
import { siteContactOf } from '../../../convex/lib/siteContact'
import {
  DEFAULT_INTERVAL,
  RecurrenceFields,
  intervalFromDraft,
} from './RecurrenceFields'
import type { IntervalDraft } from './RecurrenceFields'
import type { Id } from '../../../convex/_generated/dataModel'
import { PRIMARY_BUTTON_COMPACT, SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { FIELD } from '#/components/forms/FormField'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { FormAlert } from '#/components/forms/FormAlert'

/**
 * Loaded on demand, not with the schedule.
 *
 * This sheet is reachable only after two taps — open a job, then "Make
 * recurring" — but a static import pulls it, `RecurrenceFields` and the whole
 * interval model into the chunk the Schedule route hydrates from. That is
 * bytes on the critical path of the screen a technician opens most, to render
 * something almost nobody opens on any given visit, and it measurably delayed
 * the moment the day's view switcher became clickable.
 */
const MakeRecurringSheet = lazy(() =>
  import('./MakeRecurringSheet').then((m) => ({
    default: m.MakeRecurringSheet,
  })),
)

/**
 * A job's notes and reports, loaded on demand for the same reason, by a far
 * wider margin. The notes bring the rich-text editor (`NoteEditor`, ~411 KB
 * of ProseMirror) and the reports bring every report template (~116 KB).
 * The sheet itself mounts with the Schedule even when no job is open, so as
 * static imports both sat in the route's import graph. The server's preload
 * hints stop a level short of them, so the browser only found them once the
 * route's code ran, and the whole page waited on a second round of fetches:
 * on a production build it hydrated ~0.7 s after `load`, right as
 * `NoteEditor` landed, to draw a screen with neither on it. Now it is ~70 ms.
 *
 * `JobDetailBody` asks for both as a job opens, so they load while the job
 * itself is still on its way rather than after it arrives.
 */
const loadNotes = () => import('#/components/notes/JobNotesSection')
const loadReports = () => import('#/components/reports/InlineReports')

const JobNotesSection = lazy(() =>
  loadNotes().then((m) => ({ default: m.JobNotesSection })),
)
const InlineReportsSection = lazy(() =>
  loadReports().then((m) => ({ default: m.InlineReportsSection })),
)
const StartReportButtons = lazy(() =>
  loadReports().then((m) => ({ default: m.StartReportButtons })),
)

/**
 * Saving an edit is two writes: the job's own fields, then — if the person
 * also asked for it to repeat — the conversion into a series. The second can
 * fail on its own, and when it does the first has ALREADY committed. There is
 * no transaction spanning them and nothing to roll back to.
 *
 * "Could not save these changes" is then a lie in the one direction that
 * matters: the changes did save, and only the repeat did not. Someone who
 * believes the message re-enters edits that are already stored, and never
 * learns the job is still a one-off. The message has to say which half won.
 */
const REPEAT_STEP_FAILED = 'REPEAT_STEP_FAILED'

type SettableStatus =
  | 'pending'
  | 'booked'
  | 'completed'
  | 'invoiced'
  | 'cancelled'

// "Recurring" is excluded for good: only the recurrence engine creates it, the
// server refuses it from anyone, and a job that leaves it can never return
// (convex/lib/jobStatus.ts). A recurring job still opens this menu — its pill
// says Recurring, and every choice here moves it out. Labels come from the
// one status definition (src/lib/statusColours.ts), like the pill's.

const STATUS_MENU: ReadonlyArray<SettableStatus> = [
  'pending',
  'booked',
  'completed',
  'invoiced',
  'cancelled',
]

export function JobDetailSheet({
  businessId,
  businessSlug,
  timezone,
  jobId,
  canReassign,
  onClose,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  jobId: string | null
  canReassign: boolean
  onClose: () => void
}) {
  return (
    <SheetShell open={jobId !== null} onClose={onClose}>

      {/* Mounted only with a real id, so the query never needs a skip
          sentinel and its key is always well-formed. `key` forces a
          fresh instance per job so `editing`/`confirmCancelOpen` never
          leak from one job into another. */}
      {jobId !== null && (
        <JobDetailBody
          key={jobId}
          businessId={businessId}
          businessSlug={businessSlug}
          timezone={timezone}
          jobId={jobId as Id<'jobs'>}
          canReassign={canReassign}
        />
      )}
    </SheetShell>
  )
}

function JobDetailBody({
  businessId,
  businessSlug,
  timezone,
  jobId,
  canReassign,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  jobId: Id<'jobs'>
  canReassign: boolean
}) {
  const { data: job } = useQuery(
    convexQuery(api.jobs.get, { businessId, jobId }),
  )
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false)
  const [confirmStopRepeatingOpen, setConfirmStopRepeatingOpen] = useState(false)
  const [makeRecurringOpen, setMakeRecurringOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const hydrated = useHydrated()

  // The notes and reports sections render only once `job` has arrived. Asking
  // for their code now lets it load alongside the job rather than after it.
  useEffect(() => {
    void loadNotes()
    void loadReports()
  }, [])

  // None of these close the sheet on success — a status change from the
  // dropdown is a quick in-place toggle now, not a "finish and leave"
  // commitment the way the old dedicated buttons were.
  const convexComplete = useConvexMutation(api.jobs.complete)
  const complete = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; jobId: Id<'jobs'> }) =>
      convexComplete(args),
  })

  const convexCancel = useConvexMutation(api.jobs.cancel)
  const cancel = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; jobId: Id<'jobs'> }) =>
      convexCancel(args),
  })

  const convexStopRepeating = useConvexMutation(api.recurrences.stopFromJob)
  const stopRepeating = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; jobId: Id<'jobs'> }) =>
      convexStopRepeating(args),
    onSuccess: () => setConfirmStopRepeatingOpen(false),
  })

  // Sets any status without a dedicated mutation — pending, booked or
  // invoiced — via the generic patch mutation. `complete`/`cancel` stay separate above
  // since they're dedicated mutations with their own semantics.
  const convexUpdate = useConvexMutation(api.jobs.update)
  const setStatus = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      jobId: Id<'jobs'>
      status: 'pending' | 'booked' | 'invoiced'
    }) => convexUpdate(args),
  })

  function selectStatus(next: SettableStatus) {
    if (!job || next === job.status) return
    // A refusal belongs to the choice that caused it, not the next one.
    complete.reset()
    setStatus.reset()
    if (next === 'cancelled') {
      // Cancelling is the one destructive-feeling choice here — the only
      // one that gets a confirmation, not the others.
      setConfirmCancelOpen(true)
      return
    }
    if (next === 'completed') {
      complete.mutate({ businessId, jobId: job._id })
      return
    }
    setStatus.mutate({ businessId, jobId: job._id, status: next })
  }

  // The person at a business client's site, shown in the Property section
  // beside the client's own line (Prompt 6.3). Null for a person client,
  // who is their own site contact.
  const siteContact = job?.property
    ? siteContactOf({
        clientKind: job.property.client?.kind,
        siteContactName: job.property.siteContactName,
        siteContactPhone: job.property.siteContactPhone,
      })
    : null
  // The client's own buttons are captioned only beside a site contact, so the
  // technician can tell which Call is the site and which the office — and
  // only when there are buttons to caption.
  const client = job?.property?.client
  const captionOffice =
    siteContact !== null && Boolean(client?.phone || client?.email)

  return (
    <>
      {job ? (
        <div className={`${SHEET_BODY} pt-3`}>
          {/* A short, sayable number — the opaque Convex id is useless over
              the phone or on a paper docket (older jobs predate this field
              and simply have none). */}
          <div className="flex items-center justify-between gap-2">
            {job.jobNumber !== undefined && (
              <p className="section-label mb-0.5">Job #{job.jobNumber}</p>
            )}
            {job.canEdit && job.status !== 'invoiced' && !editing && (
              <button
                type="button"
                aria-label="Edit job details"
                onClick={() => setEditing(true)}
                className="relative tap-target mr-8 flex items-center gap-1 text-caption font-semibold text-blue"
              >
                <Pencil size={13} strokeWidth={2} />
                Edit
              </button>
            )}
          </div>
          <Drawer.Title className="text-sheet-title text-ink">
            {job.jobType}
          </Drawer.Title>

          {editing ? (
            <JobEditForm
              businessId={businessId}
              timezone={timezone}
              job={job}
              canReassign={canReassign}
              onDone={() => setEditing(false)}
            />
          ) : (
            <>
              <div className="mt-2 flex items-center gap-2">
                {/* Read access can be granted without edit rights, so the menu
                    is driven by the server's canEdit, not by role. An invoiced
                    job keeps its menu: moving it back out is how its details
                    reopen for editing. */}
                {job.canEdit ? (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        aria-label="Change job status"
                        className="flex items-center gap-1 rounded-full transition active:scale-[.97]"
                      >
                        <StatusPill status={job.status} />
                        <ChevronDown size={14} strokeWidth={2.2} className="text-muted" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="start"
                        sideOffset={6}
                        className="z-50 w-48 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
                      >
                        {STATUS_MENU.map((option) => (
                          <DropdownMenu.Item
                            key={option}
                            onSelect={() => selectStatus(option)}
                            className="flex cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-body text-ink outline-none transition data-[highlighted]:bg-surface-2"
                          >
                            {JOB_STATUS[option].label}
                            {job.status === option && (
                              <Check size={15} strokeWidth={2.2} className="text-blue" />
                            )}
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                ) : (
                  <StatusPill status={job.status} />
                )}
                {/* Each part kept whole, so a narrow screen breaks the line
                    at a "·" and never leaves "min" alone under the pill. */}
                <span className="text-body text-muted">
                  <span className="whitespace-nowrap">
                    {formatJobDate(
                      dayKeyOf(job.scheduledAt, timezone),
                      dayKeyOf(Date.now(), timezone),
                    )}
                  </span>{' '}
                  <span className="whitespace-nowrap">
                    · {formatTime(job.scheduledAt, timezone)}
                  </span>{' '}
                  <span className="whitespace-nowrap">
                    · {formatDuration(job.durationMinutes)}
                  </span>
                </span>
              </div>

              {/* The business asked to be stopped here. Said where the tap
                  happened, and naming the way out — the report section is
                  directly below. */}
              <FormAlert
                className="mt-2"
                error={complete.isError ? complete.error : null}
                copy={{
                  REPORT_REQUIRED:
                    'Finalise this job’s report first — your business asks for one before a job is marked complete.',
                  default:
                    'Could not mark this job complete. Check your signal and try again.',
                }}
              />
              <FormAlert
                className="mt-2"
                error={setStatus.isError ? setStatus.error : null}
                copy={{
                  REPORT_REQUIRED:
                    'Finalise this job’s report first — your business asks for one before a job is marked invoiced.',
                  default:
                    'Could not change this job’s status. Check your signal and try again.',
                }}
              />

              <Section label="Property">
                <p className="text-row-title text-ink">
                  {job.property?.client?.name}
                </p>
                {/* Full street address here — the list rows show suburb only. */}
                <p className="text-body text-ink-2">{job.property?.addressLine}</p>
                <p className="text-body text-muted">
                  {job.property?.suburb} {job.property?.state}{' '}
                  {job.property?.postcode}
                </p>

                {/* Whoever lets the technician in — the store manager, the
                    caretaker. First, since it is who the job card's Call
                    already rings (convex/lib/siteContact.ts); head office stays
                    below it, not replaced by it. A name without a number is
                    still shown: it is who to ask for at the door. */}
                {siteContact && (
                  <div className="mt-3 border-t border-hairline-2 pt-3">
                    <h4 className="section-label mb-1">Site contact</h4>
                    {siteContact.name && (
                      <p className="text-body text-ink">{siteContact.name}</p>
                    )}
                    {siteContact.phone && (
                      <>
                        <p className="text-caption text-muted">
                          {siteContact.phone}
                        </p>
                        <div className="mt-2">
                          <ContactButtons
                            name={siteContact.name ?? 'site contact'}
                            phone={siteContact.phone}
                            show={['call', 'text']}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Quick-contact — hold to confirm on touch, since a phone in a
                    pocket must never silently dial or text a client (§2.3). */}
                {job.property?.client && (
                  <div
                    className={
                      captionOffice
                        ? 'mt-3 border-t border-hairline-2 pt-3'
                        : 'mt-3'
                    }
                  >
                    {captionOffice && (
                      <h4 className="section-label mb-1">Head office</h4>
                    )}
                    <ContactButtons
                      name={job.property.client.name}
                      phone={job.property.client.phone}
                      email={job.property.client.email}
                    />
                  </div>
                )}
              </Section>

              {/* The client's reference, read out at a site's sign-in desk
                  and needed on the invoice. A business client without one is
                  said so, so a missing PO is noticed before the job is
                  invoiced rather than when the invoice bounces. */}
              {(job.workOrder !== undefined ||
                job.property?.client?.kind === 'business') && (
                <Section label="Work order">
                  {job.workOrder !== undefined ? (
                    <p className="select-text text-row-title text-ink">
                      {job.workOrder}
                    </p>
                  ) : (
                    <p className="text-body text-muted">None recorded</p>
                  )}
                </Section>
              )}

              <Section label="Price">
                <p className="text-metric-sm text-ink">{formatJobMoney(job)}</p>
              </Section>
            </>
          )}

          {/* Weather for this property on this day, not the day in general —
              two jobs on the same day can be in different suburbs. */}
          <JobWeather
            businessId={businessId}
            state={job.property?.state ?? ''}
            suburb={job.property?.suburb ?? ''}
            postcode={job.property?.postcode ?? ''}
            dayKey={dayKeyInZone(job.scheduledAt, timezone)}
            todayKey={dayKeyInZone(Date.now(), timezone)}
          />

          <Section label="Recurrence">
            {job.recurrence?.active ? (
              <>
                <div className="flex items-center gap-2">
                  <Repeat size={16} strokeWidth={2} className="text-ink-2" />
                  <p className="text-body text-ink">
                    {describeRepeat(job.recurrence.interval)}
                  </p>
                </div>
                {/* Cancelling one visit is not the same as ending a contract,
                    so the distinction is spelled out rather than implied. */}
                <p className="mt-1 text-caption text-muted">
                  Future visits are booked automatically. Cancelling this one
                  leaves the rest in place.
                </p>
                {job.canEdit && job.status !== 'invoiced' && (
                  <button
                    type="button"
                    disabled={!hydrated}
                    onClick={() => setConfirmStopRepeatingOpen(true)}
                    className="relative tap-target mt-3 text-caption font-semibold text-red disabled:opacity-50"
                  >
                    Stop repeating
                  </button>
                )}
              </>
            ) : (
              <>
                <p className="text-body text-ink">One-off</p>
                {/* The way an existing job becomes a Recurring Job. It lives
                    here rather than only inside the edit form because making
                    a job repeat is not editing its details — it is setting up
                    a standing arrangement, and it asks its own question. */}
                {job.canEdit && job.status !== 'invoiced' && (
                  <button
                    type="button"
                    disabled={!hydrated}
                    onClick={() => setMakeRecurringOpen(true)}
                    className="relative tap-target mt-3 text-caption font-semibold text-blue disabled:opacity-50"
                  >
                    Make recurring
                  </button>
                )}
              </>
            )}
          </Section>

          <PropertyHistory
            businessId={businessId}
            businessSlug={businessSlug}
            propertyId={job.propertyId}
            timezone={timezone}
            excludeJobId={job._id}
          />

          <JobReports
            businessId={businessId}
            businessSlug={businessSlug}
            propertyId={job.propertyId}
            jobId={job._id}
            jobType={job.jobType}
            timezone={timezone}
          />

          {/* Its own boundary, so the rest of the sheet draws while the
              editor's code arrives, and in the sections' own loading state. */}
          <Suspense
            fallback={<SectionLoading label="Before you arrive" />}
          >
            <JobNotesSection
              businessId={businessId}
              businessSlug={businessSlug}
              timezone={timezone}
              propertyId={job.propertyId}
              addressLine={job.property?.addressLine ?? ''}
            />
          </Suspense>

          <JobPhotos businessId={businessId} jobId={job._id} canEdit={job.canEdit} />

          {/* Read access can be granted without edit rights, so the status
                  menu above is driven by the server's canEdit, not by role. */}
          {!job.canEdit && (
            <p className="mt-6 rounded-xl border border-amber-line bg-amber-bg px-3 py-2.5 text-caption text-amber-ink">
              This job is assigned to someone else, so it is read-only.
            </p>
          )}
          {job.status === 'invoiced' && (
            <p className="mt-6 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5 text-caption text-muted">
              This job has been invoiced, so its details are locked. Change
              its status to edit them.
            </p>
          )}

          <ConfirmDialog
            open={confirmCancelOpen}
            onOpenChange={setConfirmCancelOpen}
            title="Cancel this job?"
            body={
              <>
                {job.jobType} for {job.property?.client?.name} at{' '}
                {formatTime(job.scheduledAt, timezone)} won't happen as booked.
                Nothing is deleted — the visit stays in the schedule marked
                cancelled, and you can reopen it as booked any time.
              </>
            }
            cancel="Keep job"
            confirm="Cancel job"
            pending={cancel.isPending}
            pendingLabel="Cancelling…"
            onConfirm={() => cancel.mutate({ businessId, jobId: job._id })}
          />

          {/* Nothing to show while it loads: the sheet is closed until the
              person asks for it, and its own open animation is the feedback. */}
          <Suspense fallback={null}>
            {makeRecurringOpen && (
              <MakeRecurringSheet
                open
                onClose={() => setMakeRecurringOpen(false)}
                businessId={businessId}
                jobId={job._id}
              />
            )}
          </Suspense>

          <ConfirmDialog
            open={confirmStopRepeatingOpen}
            onOpenChange={setConfirmStopRepeatingOpen}
            title="Stop repeating this service?"
            body={
              <>
                This visit stays booked as shown. Any other future visits
                already generated for this series will be removed from the
                schedule — this cannot be undone. Past and completed visits
                are not affected.
              </>
            }
            cancel="Keep repeating"
            confirm="Stop repeating"
            pending={stopRepeating.isPending}
            pendingLabel="Stopping…"
            onConfirm={() => stopRepeating.mutate({ businessId, jobId: job._id })}
          />
        </div>
      ) : job === null ? (
        <div className="px-4 py-10">
          <Drawer.Title className="text-sheet-title text-ink">
            Not found
          </Drawer.Title>
          <p className="mt-1 text-body text-muted">
            This job does not exist, or you do not have access to it.
          </p>
        </div>
      ) : (
        // The sheet's own shape while the job loads, so it opens at its
        // height instead of opening short and jumping up.
        <SheetPending
          title={<Drawer.Title className="sr-only">Job</Drawer.Title>}
        />
      )}
    </>
  )
}

/**
 * Every job field except status (that stays on the dropdown above — a quick
 * toggle, not a form field). Reuses `NewJobSheet.tsx`'s exact widgets rather
 * than inventing new ones: the searchable `Combobox` for property and job
 * type, a native `<select>` for the assignee, `date`+`time` inputs, plain
 * number inputs for duration/price. Unlike a new job, the property starts on
 * the job's own — that is context, not a default.
 */
function JobEditForm({
  businessId,
  timezone,
  job,
  canReassign,
  onDone,
}: {
  businessId: Id<'businesses'>
  timezone: string
  job: {
    _id: Id<'jobs'>
    propertyId: Id<'properties'>
    jobType: string
    price: number
    pricesHidden?: boolean
    scheduledAt: number
    durationMinutes: number
    assignedMembershipId: Id<'memberships'>
    workOrder?: string
    recurrence: { _id: Id<'recurrences'>; interval: Interval; active: boolean } | null
  }
  canReassign: boolean
  onDone: () => void
}) {
  const { data: properties } = useQuery(
    convexQuery(api.properties.list, { businessId }),
  )
  const { data: members } = useQuery(
    convexQuery(api.memberships.listForBusiness, { businessId }),
  )

  const [propertyId, setPropertyId] = useState<string>(job.propertyId)
  const propertyOptionList = useMemo(
    () => propertyOptions(properties ?? []),
    [properties],
  )
  const [jobType, setJobType] = useState(job.jobType)
  // Seeded from the tenant's own timezone, not the viewer's browser zone —
  // matching what `formatTime` already displays elsewhere in this sheet, so
  // opening the edit form never shows a different time than the read view did.
  const [date, setDate] = useState(dayKeyOf(job.scheduledAt, timezone))
  const [time, setTime] = useState(timeKeyOf(job.scheduledAt, timezone))
  const [duration, setDuration] = useState(String(job.durationMinutes))
  const [price, setPrice] = useState(String(job.price / 100))
  const [assignee, setAssignee] = useState<string>(job.assignedMembershipId)
  // What the form opened with, held still: `job` is live, and comparing
  // against it would send this form's stale value over a work order someone
  // else set while it was open.
  const [openedWorkOrder] = useState(job.workOrder ?? '')
  const [workOrder, setWorkOrder] = useState(openedWorkOrder)
  const { options: assignees } = useAssigneeOptions(members)
  const [repeats, setRepeats] = useState(false)
  const [interval, setInterval] = useState<IntervalDraft>(DEFAULT_INTERVAL)
  const hasActiveRecurrence = job.recurrence?.active ?? false
  // See the same guard in NewJobSheet: an interval that does not parse must
  // not silently become "leave it a one-off" — Save would report success
  // having quietly dropped the only change the person came here to make.
  const recurrence = repeats ? intervalFromDraft(interval) : null
  const intervalIncomplete = repeats && recurrence === null

  const hydrated = useHydrated()

  const convexUpdate = useConvexMutation(api.jobs.update)
  const convexConvert = useConvexMutation(api.recurrences.convertJobToRecurring)
  const save = useMutation({
    mutationFn: async (args: {
      businessId: Id<'businesses'>
      jobId: Id<'jobs'>
      propertyId: Id<'properties'>
      jobType: string
      price: number
      scheduledAt: number
      durationMinutes: number
      assignedMembershipId: Id<'memberships'>
      workOrder: string | undefined
      repeat: Interval | null
    }) => {
      const { repeat: nextRepeat, ...patch } = args
      await convexUpdate(patch)
      // convertJobToRecurring re-reads the job's own fields from the database
      // rather than trusting these client-passed values, so it always anchors
      // on whatever was just saved above, not stale pre-edit values.
      if (!hasActiveRecurrence && nextRepeat) {
        try {
          await convexConvert({
            businessId: patch.businessId,
            jobId: patch.jobId,
            intervalCount: nextRepeat.count,
            intervalUnit: nextRepeat.unit,
          })
        } catch {
          // The patch above is committed. Say so.
          throw new Error(REPEAT_STEP_FAILED)
        }
      }
    },
    onSuccess: onDone,
  })

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (intervalIncomplete) return
        const [hh, mm] = time.split(':').map(Number)
        const scheduledAt = zonedDateTimeToUtc(date, hh, mm, timezone)

        save.mutate({
          businessId,
          jobId: job._id,
          propertyId: propertyId as Id<'properties'>,
          jobType,
          price: Math.round(Number(price || '0') * 100),
          scheduledAt,
          durationMinutes: Number(duration),
          assignedMembershipId: assignee as Id<'memberships'>,
          // Sent only when changed ('' clears it). Every other edit then
          // leaves it out entirely, so rescheduling a job never depends on
          // the server knowing this field.
          workOrder:
            workOrder.trim() === openedWorkOrder
              ? undefined
              : workOrder.trim(),
          repeat: recurrence,
        })
      }}
    >
      <EditField label="Property">
        <Combobox
          value={propertyId}
          onChange={setPropertyId}
          options={propertyOptionList}
          placeholder="Search by name or address"
          noMatchLabel="No properties match"
          ariaLabel="Property"
        />
      </EditField>

      <EditField label="Work order">
        <input
          value={workOrder}
          onChange={(e) => setWorkOrder(e.target.value)}
          maxLength={MAX_WORK_ORDER_LENGTH}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          placeholder="None"
          className={`${FIELD} w-full`}
        />
      </EditField>

      <EditField label="Job type">
        <Combobox
          value={jobType}
          onChange={setJobType}
          options={JOB_TYPES.map((t) => ({ value: t, label: t }))}
          allowCustom
          customLabel={(q) => `Add "${q}" as a new job type`}
          placeholder="Search or add a job type"
          ariaLabel="Job type"
        />
      </EditField>

      {/* Only the people the server will accept are offered (`bookable`,
          which jobs.update enforces through the same `canDispatchTo`). With
          nobody to move it to but its own assignee — a subcontractor on their
          own job, the owner working inside one's account — it reads as plain
          text instead of a control they'd be rejected for using. */}
      <EditField label="Assigned to">
        {canReassign && assignees.length > 1 ? (
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className={`${FIELD} w-full`}
          >
            {assignees.map((m) => (
              <option key={m._id} value={m._id}>
                {personLabel(m)}
              </option>
            ))}
          </select>
        ) : (
          <p className="flex h-12 w-full items-center rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink">
            {(() => {
              const current = members?.find(
                (m) => m._id === job.assignedMembershipId,
              )
              return current ? personLabel(current) : 'Assigned technician'
            })()}
          </p>
        )}
        {/* Only once it is actually changing: an existing job that is
            already someone else's is not news. */}
        {assignee !== job.assignedMembershipId && (
          <OffViewNote assignee={assignee} people={assignees} />
        )}
      </EditField>

      <div className="grid grid-cols-2 gap-3">
        <EditField label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={`${FIELD} w-full`}
          />
        </EditField>
        <EditField label="Start">
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className={`${FIELD} w-full`}
          />
        </EditField>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <EditField label="Minutes">
          <input
            type="number"
            min="15"
            step="15"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className={`${FIELD} w-full`}
          />
        </EditField>
        {/* No box for a figure they were never shown. An input seeded from a
            redacted price sends a placeholder back as if it were real, and the
            server drops it — but an empty Price field that silently does
            nothing is its own kind of lie. */}
        {!job.pricesHidden && (
          <EditField label="Price (AUD)">
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className={`${FIELD} w-full`}
            />
          </EditField>
        )}
      </div>

      <EditFieldGroup label="Repeat">
        {hasActiveRecurrence ? (
          <>
            <p className="flex h-12 w-full items-center rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink">
              {job.recurrence
                ? describeInterval(job.recurrence.interval)
                : 'Repeating'}
            </p>
            <p className="mt-1.5 text-caption text-muted">
              To change how often this repeats, use "Stop repeating" above and
              set up a new series.
            </p>
          </>
        ) : (
          <>
            <Segmented
              kind="choice"
              label="Repeat"
              value={repeats ? 'repeats' : 'once'}
              onChange={(v: string) => setRepeats(v === 'repeats')}
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
                  idPrefix="edit-job-repeat"
                />
              </div>
            )}
          </>
        )}
      </EditFieldGroup>

      {save.isError && (
        <FormAlert>
          {save.error.message === REPEAT_STEP_FAILED
            ? 'Your changes were saved, but this job was not made recurring. Use “Make recurring” on the job to try again.'
            : 'Could not save these changes.'}
        </FormAlert>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={save.isPending || !hydrated || intervalIncomplete}
          className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function EditField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  )
}
/**
 * Like `EditField`, but for a composite control rather than a single input.
 *
 * A `<label>` names exactly ONE control. Wrapping a group of them — a
 * segmented toggle, a number box, a unit select and a line of help text —
 * makes every descendant inherit the group's entire text as its accessible
 * name: the "One-off" tab came out called "Repeat Repeat Every 3 weeks,
 * starting from this job's date", which is both wrong for a screen reader and
 * ambiguous for anything matching controls by name. A labelled group is what
 * this shape actually is.
 */
function EditFieldGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      {/* Already announced by the group's own name. */}
      <span className="section-label" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  )
}

function dayKeyInZone(ts: number, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

function JobWeather({
  businessId,
  state,
  suburb,
  postcode,
  dayKey,
  todayKey,
}: {
  businessId: Id<'businesses'>
  state: string
  suburb: string
  postcode: string
  dayKey: string
  todayKey: string
}) {
  // Deliberately its own call rather than reading a map handed down from the
  // schedule: a job reached by deep link (the notes editor links by `jobId`
  // with no date) can sit on a different day from the one the schedule is
  // showing, and its property can be in a different state from the business.
  // The query is cached and keyed per day, so when the days do coincide this
  // costs nothing.
  const weather = useWeather(businessId, state, todayKey, [
    { dayKey, suburb, postcode },
  ])
  const cell = weather.cell(suburb, postcode, dayKey)

  // Absent outside the forecast window, which is most of a year — showing an
  // empty weather card for a job in March would read as "fine". A pending or
  // failed lookup is likewise silent here: unlike the schedule card, this
  // section has no fixed slot to hold open.
  if (cell.status !== 'ready') return null
  const day = cell.weather

  const wet = isWet(day)
  const windy = isWindy(day)

  return (
    <Section label="Weather">
      <div className="flex items-center gap-2.5">
        <WeatherGlyph weather={day} size={18} />
        <p className="text-body text-ink">
          {day.suburb}
          {day.partial && ' · rest of today'}
          {day.maxTempC !== undefined && ` · ${Math.round(day.maxTempC)}°`}
          {day.minTempC !== undefined && ` / ${Math.round(day.minTempC)}°`}
          {day.rainMm !== undefined && ` · ${day.rainMm.toFixed(1)} mm`}
          {day.windKmh !== undefined && ` · ${Math.round(day.windKmh)} km/h`}
        </p>
      </div>

      {/* What it means for this job, not just what the numbers are. */}
      {wet && (
        <p className="mt-1.5 text-caption text-amber-ink">
          Rain forecast — an external treatment applied on this visit may wash
          off.
        </p>
      )}
      {!wet && windy && (
        <p className="mt-1.5 text-caption text-amber-ink">
          Windy — expect spray drift on exposed applications.
        </p>
      )}
      <WeatherCredit className="mt-1.5" />
    </Section>
  )
}

/**
 * Other visits at this property, most recent first — the "history" a
 * recurring service accumulates, but shown for any property (a one-off
 * client with a prior unrelated job benefits from this too, matching how
 * `ClientSheet.tsx`'s own property view already shows job history
 * unconditionally).
 */
function PropertyHistory({
  businessId,
  businessSlug,
  propertyId,
  timezone,
  excludeJobId,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  propertyId: Id<'properties'>
  timezone: string
  excludeJobId: Id<'jobs'>
}) {
  const { data } = useQuery(
    convexQuery(api.properties.jobHistory, { businessId, propertyId }),
  )
  const visits = (data ?? []).filter((j) => j._id !== excludeJobId).slice(0, 5)
  if (visits.length === 0) return null

  return (
    <Section label="Other visits at this property">
      <div className="flex flex-col divide-y divide-hairline">
        {visits.map((visit) => (
          <Link
            key={visit._id}
            to="/$businessSlug/schedule"
            params={{ businessSlug }}
            search={{ date: dayKeyOf(visit.scheduledAt, timezone), jobId: visit._id }}
            className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
          >
            <span className="min-w-0">
              <span className="block truncate text-body text-ink">
                {visit.jobType}
              </span>
              <span className="text-caption text-muted">
                {new Intl.DateTimeFormat('en-AU', {
                  timeZone: timezone,
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                }).format(new Date(visit.scheduledAt))}
              </span>
            </span>
            <StatusPill status={visit.status} />
          </Link>
        ))}
      </div>
    </Section>
  )
}

/** Reports finalised or drafted for this property — `reports.listByProperty`
 * existed unused before this; a job's history is incomplete without the
 * compliance documents it produced. */
/**
 * Reports for this job's property, split into what this job's own report(s)
 * are versus other history at the same address — and a way to start one
 * without leaving the sheet, since the property and (via `jobId`) the job
 * itself are both already known here. `reports.create` and
 * `reports.listByProperty` already carry `jobId` end to end; this is the
 * first UI that actually uses it.
 */
/**
 * What this visit produced, and what else exists at the address.
 *
 * Two sections rather than one list: the report for THIS job is the thing a
 * technician is looking for, and the property's history is context. Both are
 * drawn by the shared `InlineReportsSection`, which the client sheet uses too
 * — this used to be a second, quietly diverging copy of the same row.
 */
function JobReports({
  businessId,
  businessSlug,
  propertyId,
  jobId,
  jobType,
  timezone,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  propertyId: Id<'properties'>
  jobId: Id<'jobs'>
  jobType: string
  timezone: string
}) {
  const { data } = useQuery(
    convexQuery(api.reports.listByProperty, { businessId, propertyId }),
  )

  // `undefined` while the query is out, so the section shows its loading
  // row rather than "no reports for this visit yet" about reports it has not
  // looked for.
  const forThisJob = data?.filter((r) => r.jobId === jobId)
  const elsewhere = data?.filter((r) => r.jobId !== jobId)

  // The boundary sits inside, not around this component, so the query above
  // is already out while the sections' code loads.
  return (
    <Suspense fallback={<SectionLoading label="Reports for this visit" />}>
      <InlineReportsSection
        businessSlug={businessSlug}
        timezone={timezone}
        label="Reports for this visit"
        reports={forThisJob}
        empty="Nothing yet for this visit."
        action={
          <StartReportButtons
            businessId={businessId}
            businessSlug={businessSlug}
            propertyId={propertyId}
            jobId={jobId}
            jobType={jobType}
          />
        }
      />

      {elsewhere && elsewhere.length > 0 && (
        <InlineReportsSection
          businessSlug={businessSlug}
          timezone={timezone}
          label="Other reports at this property"
          reports={elsewhere}
          empty=""
        />
      )}
    </Suspense>
  )
}

/**
 * A notes or reports section while its code is still on the way: the heading
 * and card each draws while its own query is out, so the sheet neither blanks
 * nor reads "nothing yet" before the section has looked.
 */
function SectionLoading({ label }: { label: string }) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        <RowPending label={`Loading ${label.toLowerCase()}`} />
      </div>
    </section>
  )
}

type JobPhoto = { _id: Id<'jobPhotos'>; caption?: string; order: number; url: string | null }

/** Quick site reference photos — deliberately simpler than a report's
 * gallery (no cover flag, no annotation): this is "here's what I found",
 * not evidence for a compliance document. */
function JobPhotos({
  businessId,
  jobId,
  canEdit,
}: {
  businessId: Id<'businesses'>
  jobId: Id<'jobs'>
  canEdit: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<JobPhoto | null>(null)
  const hydrated = useHydrated()

  const { data } = useQuery(convexQuery(api.jobs.photos, { businessId, jobId }))
  const photos = (data ?? []) as Array<JobPhoto>

  const getUploadUrl = useConvexMutation(api.jobs.generateUploadUrl)
  const convexAdd = useConvexMutation(api.jobs.addPhoto)
  const add = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      jobId: Id<'jobs'>
      storageId: Id<'_storage'>
    }) => convexAdd(args),
  })
  const convexRemove = useConvexMutation(api.jobs.removePhoto)
  const remove = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      jobId: Id<'jobs'>
      photoId: Id<'jobPhotos'>
    }) => convexRemove(args),
  })

  async function onPick(files: Array<File>) {
    setBusy(true)
    setFailed(false)
    try {
      for (const file of files) {
        const image = await prepareUpload(file)
        const uploadUrl = await getUploadUrl({ businessId })
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': image.blob.type },
          body: image.blob,
        })
        if (!res.ok) throw new Error('upload failed')
        const { storageId } = (await res.json()) as { storageId: string }
        await add.mutateAsync({ businessId, jobId, storageId: storageId as Id<'_storage'> })
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (!canEdit && photos.length === 0) return null

  return (
    <Section label="Photos">
      {photos.length > 0 && (
        <div className="mb-3 grid grid-cols-3 gap-2">
          {photos.map((photo, index) => (
            <div key={photo._id} className="relative">
              <img
                src={photo.url ?? undefined}
                alt=""
                className="aspect-square w-full rounded-lg object-cover"
              />
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove photo ${index + 1} of ${photos.length}`}
                  disabled={!hydrated || remove.isPending}
                  onClick={() => {
                    remove.reset()
                    setConfirmRemove(photo)
                  }}
                  className="tap-target absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-black/50 text-white transition active:scale-95"
                >
                  <Trash2 size={12} strokeWidth={2.4} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <>
          <button
            ref={addButton}
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className={`${SECONDARY_BUTTON_COMPACT} flex w-full items-center justify-center gap-2`}
          >
            <Camera size={16} strokeWidth={2} />
            {busy ? 'Uploading…' : 'Add photos'}
          </button>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : []
              e.target.value = ''
              if (files.length > 0) void onPick(files)
            }}
          />
          {failed && (
            <p role="alert" className="mt-2 text-caption text-amber-ink">
              Upload failed. Check your connection and try again.
            </p>
          )}
          <ConfirmDialog
            open={confirmRemove !== null}
            onOpenChange={(open) => !open && setConfirmRemove(null)}
            title="Remove this photo?"
            body="It comes off this job for everyone who can see it, and can’t be brought back."
            confirm="Remove"
            cancel="Keep it"
            closeOnConfirm={false}
            pending={remove.isPending}
            pendingLabel="Removing…"
            error={
              remove.isError
                ? 'Could not remove the photo. Check your signal and try again.'
                : null
            }
            // The photo's own button goes with it; Add photos is the next
            // thing in the section.
            returnFocus={(confirmed) => (confirmed ? addButton.current : null)}
            onConfirm={() => {
              if (!confirmRemove) return
              remove.mutate(
                { businessId, jobId, photoId: confirmRemove._id },
                { onSuccess: () => setConfirmRemove(null) },
              )
            }}
          />
        </>
      )}
    </Section>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
        {children}
      </div>
    </section>
  )
}
