import { Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import {
  SHEET_BODY,
  SHEET_BODY_ABOVE_FOOTER,
  SHEET_FOOTER,
  SheetShell,
  useSheetLock,
} from '#/components/primitives/Sheet'
import { Camera, Pencil, Repeat, Trash2 } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { Combobox } from '#/components/primitives/Combobox'
import { ContactButtons } from '#/components/primitives/ContactButtons'
import { StatusPill } from '#/components/primitives/StatusPill'
import {
  StatusPicker,
  StatusPillButton,
} from '#/components/primitives/StatusPicker'
import { JOB_STATUS } from '#/lib/statusColours'
import { Segmented } from '#/components/primitives/Segmented'
import {
  formatDuration,
  formatJobDate,
  formatJobMoney,
  formatTime,
  formatWhen,
} from '#/lib/format'
import { JobTypePicker, canonicalJobTypes } from './JobTypePicker'
import { useJobTypes } from '#/lib/useJobTypes'
import { WeatherGlyph } from './WeatherGlyph'
import { WeatherCredit } from './WeatherCredit'
import { isWet, isWindy, useWeather } from '#/lib/weather'
import { useHydrated } from '#/lib/useHydrated'
import { propertyOptions } from '#/lib/propertyOptions'
import { prepareUpload } from '#/lib/images/prepareUpload'
import { personLabel, roleLabel, useAssigneeOptions } from '#/lib/assignees'
import { OffViewNote } from './OffViewNote'
import { PropertyHistory } from './PropertyHistory'
import { nextVisit } from '#/lib/jobHistory'
import { Bone, RowPending, SheetPending } from '#/components/shell/Pending'
import { dayKeyOf, timeKeyOf, zonedDateTimeToUtc } from '../../../convex/lib/dates'
import { describeInterval } from '../../../convex/lib/recurrence'
import type { Interval } from '../../../convex/lib/recurrence'
import type { Role } from '../../../convex/lib/capabilities'
import { MAX_WORK_ORDER_LENGTH } from '../../../convex/lib/workOrder'
import { joinJobTypes, splitJobTypes } from '../../../convex/lib/jobTypes'
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
import { DeleteButton } from '#/components/primitives/DeleteButton'
import { DetailRow, DetailRows } from '#/components/primitives/DetailRow'
import type { ErrorCopy } from '#/components/forms/describeError'
import { FormAlert } from '#/components/forms/FormAlert'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { MAX_ALSO_GOING } from '../../../convex/lib/jobPeople'
import { useAccess } from '#/lib/access'

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
  canDelete,
  onClose,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  jobId: string | null
  canReassign: boolean
  /** `clients.manage`: the owner and contractors. Offers Delete on a job
   * they may edit (the server's `canEdit`). */
  canDelete: boolean
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
          canDelete={canDelete}
          onClose={onClose}
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
  canDelete,
  onClose,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  jobId: Id<'jobs'>
  canReassign: boolean
  canDelete: boolean
  onClose: () => void
}) {
  const jobQuery = useQuery(convexQuery(api.jobs.get, { businessId, jobId }))
  const job = jobQuery.data
  // Everyone going beside the lead. Read as possibly absent: a backend older
  // than shared jobs sends no such field.
  const alsoGoingHere: ReadonlyArray<{
    _id: Id<'memberships'>
    colour: string
  }> =
    (
      job as
        | { alsoGoing?: Array<{ _id: Id<'memberships'>; colour: string }> }
        | null
        | undefined
    )?.alsoGoing ?? []
  // Who is doing it, by name: the job carries the person's id and colour, and
  // the roster (read by every member, and open already on the Schedule) their
  // name.
  const rosterQuery = useQuery(
    convexQuery(api.memberships.listForBusiness, { businessId }),
  )
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false)
  const [confirmStopRepeatingOpen, setConfirmStopRepeatingOpen] = useState(false)
  const [makeRecurringOpen, setMakeRecurringOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<'job' | 'series' | null>(
    null,
  )
  const [editing, setEditing] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const statusButton = useRef<HTMLButtonElement>(null)
  const hydrated = useHydrated()

  // The notes and reports sections render only once `job` has arrived. Asking
  // for their code now lets it load alongside the job rather than after it.
  useEffect(() => {
    void loadNotes()
    void loadReports()
  }, [])

  // None of these close the sheet on success — a status change from the
  // status sheet is a quick in-place toggle, not a "finish and leave"
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

  // Both close the sheet: what it showed is in the Recycle bin now.
  const convexDeleteJob = useConvexMutation(api.bin.deleteJob)
  const convexDeleteSeries = useConvexMutation(api.bin.deleteSeries)
  const remove = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      jobId: Id<'jobs'>
      what: 'job' | 'series'
    }) =>
      args.what === 'job'
        ? convexDeleteJob({ businessId: args.businessId, jobId: args.jobId })
        : convexDeleteSeries({ businessId: args.businessId, jobId: args.jobId }),
    onSuccess: onClose,
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
    cancel.reset()
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

  if (job && editing) {
    // Edit mode is the form and nothing else, its Save and Cancel pinned
    // below it, and the sheet locked against a swipe (useSheetLock).
    return (
      <JobEditForm
        businessId={businessId}
        timezone={timezone}
        job={job}
        canReassign={canReassign}
        onDone={() => setEditing(false)}
        header={
          <>
            <p className="section-label mb-0.5 mr-10">
              {job.jobNumber !== undefined
                ? `Editing job #${job.jobNumber}`
                : 'Editing job'}
            </p>
            <Drawer.Title className="mr-10 text-sheet-title text-ink">
              {job.jobType}
            </Drawer.Title>
          </>
        }
      />
    )
  }

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
            {job.canEdit &&
              job.status !== 'invoiced' &&
              !editing && (
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

          <div className="mt-2 flex items-center gap-2">
            {/* Read access can be granted without edit rights, so the menu
                is driven by the server's canEdit, not by role. An invoiced
                job keeps its menu: moving it back out is how its details
                reopen for editing. */}
            {job.canEdit ? (
              <StatusPillButton
                pill={<StatusPill status={job.status} />}
                ariaLabel="Change job status"
                disabled={!hydrated}
                buttonRef={statusButton}
                onClick={() => setStatusOpen(true)}
              />
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

          {/* Who is going, and that it repeats: read here, changed in Edit
              and in Details. It used to show only inside the edit form. */}
          <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-2">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: job.assignee?.colour }}
              />
              <span className="sr-only">
                {alsoGoingHere.length > 0 ? 'Technicians: ' : 'Technician: '}
              </span>
              <TechnicianName
                roster={rosterQuery.data}
                membershipId={job.assignedMembershipId}
              />
            </span>
            {/* Everyone also going, each with their own dot (a shared job). */}
            {alsoGoingHere.map((person, i, all) => (
              <span key={person._id} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: person.colour }}
                />
                <span className="sr-only">
                  {i === all.length - 1 ? 'and ' : ', '}
                </span>
                <TechnicianName
                  roster={rosterQuery.data}
                  membershipId={person._id}
                />
              </span>
            ))}
            {job.recurrence?.active && (
              <span className="flex items-center gap-1">
                <Repeat
                  aria-hidden
                  size={13}
                  strokeWidth={2}
                  className="text-muted"
                />
                {describeInterval(job.recurrence.interval)}
              </span>
            )}
          </div>

          {/* Why it can't be changed, beside what can't be: the Edit above
              is gone for both. These used to sit under everything else. */}
          {!job.canEdit && (
            <p className="mt-3 rounded-xl border border-amber-line bg-amber-bg px-3 py-2.5 text-caption text-amber-ink">
              This job is assigned to someone else, so it is read-only.
            </p>
          )}
          {job.status === 'invoiced' && (
            <p className="mt-3 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5 text-caption text-ink-2">
              This job has been invoiced, so its details are locked. Change
              its status to edit them.
            </p>
          )}

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
          <FormAlert
            className="mt-2"
            error={cancel.isError ? cancel.error : null}
            copy={{
              default:
                'Could not cancel this job. Check your signal and try again.',
            }}
          />

          <Section label="Property">
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 text-row-title text-ink">
                {job.property?.client?.name}
              </p>
              {/* The number the office files them under, as on the
                  client's own sheet. */}
              {job.property?.client?.clientNumber !== undefined && (
                <span className="shrink-0 text-caption tabular-nums text-muted">
                  Client #{job.property.client.clientNumber}
                </span>
              )}
            </div>
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

          {/* Every note, straight after where and who: what to know
              before going in, and this visit's own. Its own boundary,
              so the rest of the sheet draws while the editor's code
              arrives, and in the section's own loading state. */}
          <Suspense fallback={<SectionLoading label="Notes" />}>
            <JobNotesSection
              businessId={businessId}
              businessSlug={businessSlug}
              timezone={timezone}
              jobId={job._id}
              propertyId={job.propertyId}
              addressLine={job.property?.addressLine ?? ''}
              canWriteVisitNote={job.canEdit}
              plainNote={job.notes}
            />
          </Suspense>

          {/* What this visit produces: its report, and the photos taken on
              it, in one card. */}
          <JobReports
            businessId={businessId}
            businessSlug={businessSlug}
            propertyId={job.propertyId}
            jobId={job._id}
            jobType={job.jobType}
            timezone={timezone}
            photos={
              <JobPhotos
                businessId={businessId}
                jobId={job._id}
                canEdit={job.canEdit}
              />
            }
          />

          {/* The job's own facts, one row each. Price, the work order and
              "One-off" used to take a card apiece. */}
          <Section label="Details" flush>
            <DetailRows>
              <DetailRow label="Price" value={formatJobMoney(job)} />
              {/* The client's reference, read out at a site's sign-in desk
                  and needed on the invoice. A business client without one
                  is said so, so a missing PO is noticed before the job is
                  invoiced rather than when the invoice bounces. */}
              {(job.workOrder !== undefined ||
                job.property?.client?.kind === 'business') && (
                <DetailRow
                  label="Work order"
                  value={
                    job.workOrder !== undefined ? (
                      <span className="select-text">{job.workOrder}</span>
                    ) : (
                      <span className="font-normal text-muted">
                        None recorded
                      </span>
                    )
                  }
                />
              )}
              <RepeatsRow
                businessId={businessId}
                timezone={timezone}
                job={job}
                disabled={!hydrated}
                onStop={() => setConfirmStopRepeatingOpen(true)}
                onMake={() => setMakeRecurringOpen(true)}
              />
              {/* Weather for this property on this day, not the day in
                  general — two jobs on the same day can be in different
                  suburbs. */}
              <WeatherRow
                businessId={businessId}
                state={job.property?.state ?? ''}
                suburb={job.property?.suburb ?? ''}
                postcode={job.property?.postcode ?? ''}
                dayKey={dayKeyInZone(job.scheduledAt, timezone)}
                todayKey={dayKeyInZone(Date.now(), timezone)}
              />
            </DetailRows>
          </Section>

          <PropertyHistory
            businessId={businessId}
            businessSlug={businessSlug}
            timezone={timezone}
            job={job}
            addressLine={job.property?.addressLine ?? ''}
            clientName={job.property?.client?.name ?? ''}
          />

          {canDelete && job.canEdit && (
            <>
              <DeleteButton
                disabled={!hydrated}
                onClick={() => setConfirmDelete('job')}
              >
                Delete job
              </DeleteButton>
              {job.recurrence && (
                <DeleteButton
                  className="mt-2"
                  disabled={!hydrated}
                  onClick={() => setConfirmDelete('series')}
                >
                  Delete this recurring service
                </DeleteButton>
              )}
              {/* Here, not in the dialog: it closes as Delete is pressed. */}
              <FormAlert
                className="mt-2"
                error={remove.isError ? remove.error : null}
                copy={DELETE_COPY}
              />
            </>
          )}

          <ConfirmDialog
            open={confirmDelete === 'job'}
            onOpenChange={(open) => !open && setConfirmDelete(null)}
            title="Delete this job?"
            body={
              <>
                {job.jobType} on {formatWhen(job.scheduledAt, timezone)} goes
                to the Recycle bin with its notes and draft reports. The
                business owner can restore it from Settings → Recycle bin for
                30 days. Finalised reports are kept in Reports.
              </>
            }
            cancel="Keep job"
            confirm="Delete job"
            pending={remove.isPending}
            pendingLabel="Deleting…"
            onConfirm={() =>
              remove.mutate({ businessId, jobId: job._id, what: 'job' })
            }
          />
          <ConfirmDialog
            open={confirmDelete === 'series'}
            onOpenChange={(open) => !open && setConfirmDelete(null)}
            title="Delete this recurring service?"
            body={
              <>
                Every visit of it, past and future, goes to the Recycle bin
                with their notes and draft reports, and no more are booked.
                The business owner can restore it from Settings → Recycle bin
                for 30 days. Finalised reports are kept in Reports.
              </>
            }
            cancel="Keep service"
            confirm="Delete"
            pending={remove.isPending}
            pendingLabel="Deleting…"
            onConfirm={() =>
              remove.mutate({ businessId, jobId: job._id, what: 'series' })
            }
          />

          <StatusPicker
            open={statusOpen}
            onClose={() => setStatusOpen(false)}
            title="Job status"
            description={
              job.jobNumber !== undefined
                ? `Job #${job.jobNumber} · ${job.jobType}`
                : job.jobType
            }
            choices={STATUS_MENU.map((option) => ({
              value: option,
              pill: <StatusPill status={option} />,
              meaning: JOB_STATUS[option].meaning,
            }))}
            value={job.status}
            onChoose={(next) => {
              setStatusOpen(false)
              selectStatus(next)
            }}
            returnFocusRef={statusButton}
          />

          <ConfirmDialog
            open={confirmCancelOpen}
            onOpenChange={setConfirmCancelOpen}
            title="Cancel this job?"
            body={
              <>
                {job.jobType} for {job.property?.client?.name} at{' '}
                {formatTime(job.scheduledAt, timezone)} won’t happen as booked.
                Nothing is deleted — the visit stays in the schedule marked
                cancelled, and you can reopen it as booked any time.
              </>
            }
            cancel="Keep job"
            confirm="Cancel job"
            pending={cancel.isPending}
            pendingLabel="Cancelling…"
            // Back to the pill it was chosen from, which the status sheet
            // has closed away from under the dialog.
            returnFocus={() => statusButton.current}
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
                This visit stays booked as shown. The series’ other future
                visits that haven’t started are cancelled — they stay in the
                schedule marked cancelled, and no more are booked. Past and
                completed visits are not affected.
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
      ) : jobQuery.isError ? (
        <div className="px-4 py-10">
          <Drawer.Title className="text-sheet-title text-ink">Job</Drawer.Title>
          <LoadFailed
            className="mt-3"
            what="this job"
            onRetry={() => void jobQuery.refetch()}
          />
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
  header,
}: {
  businessId: Id<'businesses'>
  timezone: string
  /** The sheet's own heading, drawn above the fields. */
  header: React.ReactNode
  job: {
    _id: Id<'jobs'>
    propertyId: Id<'properties'>
    jobType: string
    price: number
    pricesHidden?: boolean
    scheduledAt: number
    durationMinutes: number
    assignedMembershipId: Id<'memberships'>
    /** Everyone going beside the lead. Absent from an older backend. */
    alsoGoing?: Array<{ _id: Id<'memberships'> }>
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

  const jobTypeList = useJobTypes(businessId).entries
  const [propertyId, setPropertyId] = useState<string>(job.propertyId)
  const [openedAt] = useState(() => Date.now())
  const propertyOptionList = useMemo(
    () => propertyOptions(properties ?? [], { timezone, now: openedAt }),
    [properties, timezone, openedAt],
  )
  // One service or several (lib/jobTypes.ts); a job saved before there
  // could be several reads back as its one.
  const [jobTypes, setJobTypes] = useState(() =>
    canonicalJobTypes(splitJobTypes(job.jobType), jobTypeList),
  )
  const [jobTypeMissing, setJobTypeMissing] = useState(false)
  const jobTypeTrigger = useRef<HTMLButtonElement>(null)
  // Seeded from the tenant's own timezone, not the viewer's browser zone —
  // matching what `formatTime` already displays elsewhere in this sheet, so
  // opening the edit form never shows a different time than the read view did.
  const [date, setDate] = useState(dayKeyOf(job.scheduledAt, timezone))
  const [time, setTime] = useState(timeKeyOf(job.scheduledAt, timezone))
  const [duration, setDuration] = useState(String(job.durationMinutes))
  const [price, setPrice] = useState(String(job.price / 100))
  const [assignee, setAssignee] = useState<string>(job.assignedMembershipId)
  // Everyone going beside the lead (a shared job), as the form opened with
  // them, and as they are now.
  const [openedAlsoGoing] = useState<Array<string>>(() =>
    (job.alsoGoing ?? []).map((person) => person._id),
  )
  const [alsoGoing, setAlsoGoing] = useState<Array<string>>(openedAlsoGoing)
  // What the form opened with, held still: `job` is live, and comparing
  // against it would send this form's stale value over a work order someone
  // else set while it was open.
  const [openedWorkOrder] = useState(job.workOrder ?? '')
  const [workOrder, setWorkOrder] = useState(openedWorkOrder)
  const { options: assignees } = useAssigneeOptions(members)
  const access = useAccess()
  // Who may go beside the lead: whoever this person may book, but not the
  // lead — and whoever is on it already, bookable by them or not, so they
  // can be taken off (the server asks only about someone added).
  const alsoGoingOptions = useMemo(() => {
    const bookable = assignees.filter((m) => m._id !== assignee)
    // Whoever is on it now — also going, or leading it before this edit —
    // bookable by this person or not, so they are named and can be taken off.
    const already = [...openedAlsoGoing, job.assignedMembershipId as string]
      .filter((id) => id !== assignee && !bookable.some((m) => m._id === id))
      .map((id) => {
        const member = members?.find((m) => m._id === id)
        return member
          ? {
              value: id,
              label: personLabel(member),
              detail: roleLabel(member.role),
            }
          : { value: id, label: 'No longer on the team' }
      })
    return [
      ...bookable.map((m) => ({
        value: m._id,
        label: personLabel(m),
        detail: roleLabel(m.role),
      })),
      ...already,
    ]
  }, [assignees, assignee, openedAlsoGoing, members, job.assignedMembershipId])
  // Everyone also going as it will be saved: never the lead. Derived rather
  // than pruned when the lead changes, so changing it there and back loses
  // nobody.
  // Someone also going made lead: the lead they replace takes their place,
  // as the server does, rather than leaving the job without a word.
  const promoted =
    assignee !== job.assignedMembershipId && openedAlsoGoing.includes(assignee)
  const alsoGoingNow = [
    ...new Set([
      ...alsoGoing,
      ...(promoted ? [job.assignedMembershipId as string] : []),
    ]),
  ].filter((id) => id !== assignee)
  // Who may lead it: whoever this person may book, and whoever leads it now
  // — a contractor also going on the owner's job may not book the owner, and
  // without the owner in the list the select would show the contractor as
  // its lead.
  const leadOptions = useMemo(() => {
    if (assignees.some((m) => m._id === job.assignedMembershipId)) {
      return assignees
    }
    const current = members?.find((m) => m._id === job.assignedMembershipId)
    return current ? [current, ...assignees] : assignees
  }, [assignees, members, job.assignedMembershipId])
  const leadName = (() => {
    if (assignee === access.membershipId) return 'you'
    const lead = members?.find((m) => m._id === assignee)
    return lead ? personLabel(lead) : 'the lead'
  })()
  const [repeats, setRepeats] = useState(false)
  const [interval, setInterval] = useState<IntervalDraft>(DEFAULT_INTERVAL)
  const hasActiveRecurrence = job.recurrence?.active ?? false
  // See the same guard in NewJobSheet: an interval that does not parse must
  // not silently become "leave it a one-off" — Save would report success
  // having quietly dropped the only change the person came here to make.
  const recurrence = repeats ? intervalFromDraft(interval) : null
  const intervalIncomplete = repeats && recurrence === null

  const hydrated = useHydrated()
  const formId = useId()

  // What the form opened with, to tell whether anything has changed since:
  // the sheet asks before a close throws a change away (useSheetLock).
  const [opened] = useState(() => ({
    propertyId: job.propertyId,
    jobType: joinJobTypes(
      canonicalJobTypes(splitJobTypes(job.jobType), jobTypeList),
    ),
    date: dayKeyOf(job.scheduledAt, timezone),
    time: timeKeyOf(job.scheduledAt, timezone),
    duration: String(job.durationMinutes),
    price: String(job.price / 100),
    assignee: job.assignedMembershipId,
  }))
  const alsoGoingChanged =
    alsoGoingNow.length !== openedAlsoGoing.length ||
    alsoGoingNow.some((id) => !openedAlsoGoing.includes(id))
  const changed =
    propertyId !== opened.propertyId ||
    joinJobTypes(jobTypes) !== opened.jobType ||
    date !== opened.date ||
    time !== opened.time ||
    duration !== opened.duration ||
    (!job.pricesHidden && price !== opened.price) ||
    assignee !== opened.assignee ||
    alsoGoingChanged ||
    workOrder.trim() !== openedWorkOrder ||
    repeats
  useSheetLock(changed)

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
      alsoGoing: Array<Id<'memberships'>> | undefined
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
    <>
    <div className={`${SHEET_BODY_ABOVE_FOOTER} pt-3`}>
    {header}
    <form
      id={formId}
      className="mt-3 flex flex-col gap-3 pb-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (intervalIncomplete) return
        if (jobTypes.length === 0) {
          setJobTypeMissing(true)
          jobTypeTrigger.current?.focus()
          return
        }
        const [hh, mm] = time.split(':').map(Number)
        const scheduledAt = zonedDateTimeToUtc(date, hh, mm, timezone)

        save.mutate({
          businessId,
          jobId: job._id,
          propertyId: propertyId as Id<'properties'>,
          jobType: joinJobTypes(jobTypes),
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
              // The whole list, and only when it changed: this form's additions
              // and removals applied to the job as it is now, so someone another
              // person added while this was open is not taken off by it.
              alsoGoing: alsoGoingChanged
                ? (withEdits(
                    (job.alsoGoing ?? []).map((person) => person._id),
                    openedAlsoGoing,
                    alsoGoingNow,
                  ).filter((id) => id !== assignee) as Array<Id<'memberships'>>)
                : undefined,
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

      <div className="flex flex-col gap-1.5">
        <EditField label="Job type">
          <JobTypePicker
            jobTypes={jobTypeList}
            value={jobTypes}
            onChange={(next) => {
              setJobTypes(next)
              if (next.length > 0) setJobTypeMissing(false)
            }}
            invalid={jobTypeMissing}
            errorId="edit-job-type-error"
            triggerRef={jobTypeTrigger}
          />
        </EditField>
        {/* Outside the <label>: inside it, this would become the field's name. */}
        {jobTypeMissing && (
          <p
            id="edit-job-type-error"
            role="alert"
            className="text-caption text-red-ink"
          >
            Choose at least one job type.
          </p>
        )}
      </div>

      {/* Only the people the server will accept are offered (`bookable`,
          which jobs.update enforces through the same `canDispatchTo`). With
          nobody to move it to but its own assignee — a subcontractor on their
          own job, the owner working inside one's account — it reads as plain
          text instead of a control they'd be rejected for using. */}
      <EditField label="Assigned to">
            {canReassign && leadOptions.length > 1 ? (
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className={`${FIELD} w-full`}
          >
                {leadOptions.map((m) => (
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
            {/* Only once who is going is actually changing — the lead, or
            someone (this person, say) taken off: an existing job that is
            already someone else's is not news. */}
            {(assignee !== job.assignedMembershipId || alsoGoingChanged) && (
              <OffViewNote
                assignee={assignee}
                people={leadOptions}
                alsoGoing={alsoGoingNow}
              />
        )}
      </EditField>

          {/* Everyone going beside the lead: a job two people work together.
          Offered only who this person may book, like "Assigned to" — and
          whoever is already on it, so they can be taken off. Nothing to offer
          (a subcontractor on their own job), no field. */}
          {alsoGoingOptions.length > 0 && (
            <EditField label="Also going">
              <Combobox
                multiple
                value={alsoGoingNow}
                // Up to the server's limit: a sixth tick is not taken, and the
                // sheet says why.
                onChange={(next) => setAlsoGoing(next.slice(0, MAX_ALSO_GOING))}
                options={alsoGoingOptions}
                title="Also going"
                description={`Everyone working this job with ${leadName}, up to ${MAX_ALSO_GOING}. They see it on their schedule, and can do everything on it that ${leadName} can.`}
                placeholder="Search the team"
                emptyLabel="Nobody else"
                ariaLabel="Also going"
              />
            </EditField>
          )}

      {/* `[&>*]:min-w-0`: a cell never grows past its half of the row. iOS
          gives date and time inputs a width of their own, and without this
          Date pushed Start off the side of the screen. */}
      <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
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

      <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
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
              To change how often this repeats, save or cancel this, use “Stop
              repeating” on the job, and set up a new series.
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

    </form>
    </div>

    {/* Pinned below the fields, so Save is always in reach — with the
        keyboard up, a long form's end is a long way down — and a failed
        save says why just above it, where it is seen. */}
    <div className={`${SHEET_FOOTER} flex flex-col gap-2`}>
        {save.isError &&
          (save.error.message === REPEAT_STEP_FAILED ? (
            <FormAlert>
              Your changes were saved, but this job was not made recurring. Use
              “Make recurring” on the job to try again.
            </FormAlert>
          ) : (
            <FormAlert error={save.error} copy={EDIT_ERROR_COPY} />
          ))}
      <div className="flex gap-2">
      <button
        type="button"
        // Not while it saves: the form would close and the save land
        // anyway, a cancel that did not cancel.
        disabled={save.isPending}
        onClick={onDone}
        className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
      >
        Cancel
      </button>
      <button
        type="submit"
        form={formId}
        disabled={save.isPending || !hydrated || intervalIncomplete}
        className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      </div>
    </div>
    </>
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

function WeatherRow({
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
  // empty weather row for a job in March would read as "fine". A pending or
  // failed lookup is likewise silent here: unlike the schedule card, this
  // row has no fixed slot to hold open.
  if (cell.status !== 'ready') return null
  const day = cell.weather

  const wet = isWet(day)
  const windy = isWindy(day)

  return (
    <DetailRow
      label="Weather"
      value={
        <span className="inline-flex items-center gap-1.5">
          <WeatherGlyph weather={day} size={16} />
          <span>
            {day.suburb}
            {day.partial && ' · rest of today'}
            {day.maxTempC !== undefined && ` · ${Math.round(day.maxTempC)}°`}
            {day.minTempC !== undefined && ` / ${Math.round(day.minTempC)}°`}
            {day.rainMm !== undefined && ` · ${day.rainMm.toFixed(1)} mm`}
            {day.windKmh !== undefined && ` · ${Math.round(day.windKmh)} km/h`}
          </span>
        </span>
      }
      below={
        <>
          {/* What it means for this job, not just what the numbers are. */}
          {wet && (
            <p className="text-caption text-amber-ink">
              Rain forecast — an external treatment applied on this visit may
              wash off.
            </p>
          )}
          {!wet && windy && (
            <p className="text-caption text-amber-ink">
              Windy — expect spray drift on exposed applications.
            </p>
          )}
          <WeatherCredit className="mt-0.5" />
        </>
      }
    />
  )
}

/**
 * How often the job comes round, and when next: the series' next visit still
 * to come. Stopping it, or making a one-off repeat, starts here too — setting
 * up a standing arrangement is not editing the job's details, and it asks
 * its own question.
 */
function RepeatsRow({
  businessId,
  timezone,
  job,
  disabled,
  onStop,
  onMake,
}: {
  businessId: Id<'businesses'>
  timezone: string
  job: {
    _id: Id<'jobs'>
    propertyId: Id<'properties'>
    scheduledAt: number
    status: string
    jobType: string
    recurrenceId?: Id<'recurrences'>
    canEdit: boolean
    recurrence: { interval: Interval; active: boolean } | null
  }
  disabled: boolean
  onStop: () => void
  onMake: () => void
}) {
  // The same visits the History section reads, so one subscription.
  const { data: visits } = useQuery(
    convexQuery(api.properties.jobHistory, {
      businessId,
      propertyId: job.propertyId,
    }),
  )
  const [now] = useState(() => Date.now())
  const changeable = job.canEdit && job.status !== 'invoiced'

  if (!job.recurrence?.active) {
    return (
      <DetailRow
        label="Repeats"
        value="One-off"
        below={
          changeable && (
            <button
              type="button"
              disabled={disabled}
              onClick={onMake}
              className="relative tap-target text-caption font-semibold text-blue disabled:opacity-50"
            >
              Make recurring
            </button>
          )
        }
      />
    )
  }

  const next = visits && nextVisit(job, visits, now)
  return (
    <DetailRow
      label="Repeats"
      value={describeInterval(job.recurrence.interval)}
      sub={
        next &&
        `Next ${formatJobDate(dayKeyOf(next.scheduledAt, timezone), dayKeyOf(now, timezone))}`
      }
      below={
        <>
          {/* Cancelling one visit is not the same as ending a contract, so
              the distinction is spelled out rather than implied. */}
          <p className="text-caption text-ink-2">
            Future visits are booked automatically. Cancelling this one leaves
            the rest in place.
          </p>
          {changeable && (
            <button
              type="button"
              disabled={disabled}
              onClick={onStop}
              className="relative tap-target mt-2 text-caption font-semibold text-red disabled:opacity-50"
            >
              Stop repeating
            </button>
          )}
        </>
      }
    />
  )
}

/** The assignee's name from the roster: a placeholder until it arrives, and
 * said plainly for someone since removed from the team. */
function TechnicianName({
  roster,
  membershipId,
}: {
  roster: ReadonlyArray<{ _id: Id<'memberships'>; name: string; role: Role }> | undefined
  membershipId: Id<'memberships'>
}) {
  if (roster === undefined) return <Bone className="h-3.5 w-24" />
  const person = roster.find((m) => m._id === membershipId)
  return <span>{person ? personLabel(person) : 'No longer on the team'}</span>
}

/**
 * What this visit produced: its report, a way to start one, and its photos,
 * in one card. Drawn by the shared `InlineReportsSection`, which the client
 * sheet uses too. The address's other reports are in its history now, each
 * under the visit it came from (`PropertyHistory`).
 */
function JobReports({
  businessId,
  businessSlug,
  propertyId,
  jobId,
  jobType,
  timezone,
  photos,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  propertyId: Id<'properties'>
  jobId: Id<'jobs'>
  jobType: string
  timezone: string
  photos: React.ReactNode
}) {
  const reportsQuery = useQuery(
    convexQuery(api.reports.listByProperty, { businessId, propertyId }),
  )

  // `undefined` while the query is out, so the section shows its loading
  // row rather than "no reports for this visit yet" about reports it has not
  // looked for.
  const forThisJob = reportsQuery.data?.filter((r) => r.jobId === jobId)

  // The boundary sits inside, not around this component, so the query above
  // is already out while the section's code loads.
  return (
    <Suspense fallback={<SectionLoading label={REPORT_AND_PHOTOS} />}>
      <InlineReportsSection
        businessSlug={businessSlug}
        timezone={timezone}
        label={REPORT_AND_PHOTOS}
        reports={forThisJob}
        failed={reportsQuery.isError}
        onRetry={() => void reportsQuery.refetch()}
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
        footer={photos}
      />
    </Suspense>
  )
}

const REPORT_AND_PHOTOS = 'Report & photos'

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
 * not evidence for a compliance document. The foot of the Report & photos
 * card; nothing at all for someone who can't add one when there are none. */
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
    <div className="border-t border-hairline p-2.5">
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
                  className="tap-target absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-black/50 text-white transition active:scale-[.95]"
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
              Upload failed. Check your signal and try again.
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
    </div>
  )
}

function Section({
  label,
  children,
  flush = false,
}: {
  label: string
  children: React.ReactNode
  /** Rows that run to the card's edges, each padding itself. */
  flush?: boolean
}) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      <div
        className={`overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation ${flush ? '' : 'p-3.5'}`}
      >
        {children}
      </div>
    </section>
  )
}

/** Deleting a job or its series, refused — in words. */
/** A failed edit, in words (`describeError`). */
const EDIT_ERROR_COPY: ErrorCopy = {
  TOO_MANY_PEOPLE: `Could not save: a job can have up to ${MAX_ALSO_GOING} people also going. Take someone off and try again.`,
  INVALID_ASSIGNEE:
    'Could not save: someone on this job is no longer on the team. Take them off and try again.',
  NO_ACCESS:
    'Could not save: your access does not cover someone you added. Ask the business owner.',
  default: 'Could not save these changes. Check your signal and try again.',
}

/**
 * `now`, with the additions and removals this form made (`opened` → `mine`)
 * applied to it — so a change someone else saved meanwhile survives.
 */
function withEdits(
  now: ReadonlyArray<string>,
  opened: ReadonlyArray<string>,
  mine: ReadonlyArray<string>,
): Array<string> {
  const added = mine.filter((id) => !opened.includes(id))
  const removed = opened.filter((id) => !mine.includes(id))
  return [...new Set([...now, ...added])].filter((id) => !removed.includes(id))
}

const DELETE_COPY: ErrorCopy = {
  offline:
    'Could not delete: this device is offline. Try again when you have signal.',
  NOT_FOUND:
    'Could not delete: it has changed since you opened this. Close it and look again.',
  NO_ACCESS:
    'Could not delete: your access does not cover this. Ask the business owner.',
  TOO_MUCH_TO_DELETE:
    'Could not delete: there are too many visits to move to the Recycle bin at once. Ask the business owner.',
  default: 'Could not delete. Check your signal and try again.',
}
