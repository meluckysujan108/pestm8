import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { AlertDialog, DropdownMenu } from 'radix-ui'
import {
  Camera,
  Check,
  ChevronDown,
  Pencil,
  Plus,
  Repeat,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { JobNotesSection } from '#/components/notes/JobNotesSection'
import { Combobox } from '#/components/primitives/Combobox'
import { ContactButtons } from '#/components/primitives/ContactButtons'
import { StatusPill } from '#/components/primitives/StatusPill'
import {
  JOB_TYPES,
  REPEAT_LABELS,
  REPEAT_OPTIONS,
  formatDuration,
  formatMoney,
  formatTime,
} from '#/lib/format'
import { WeatherGlyph } from './WeatherGlyph'
import { isWet, isWindy, useWeather } from '#/lib/weather'
import { useHydrated } from '#/lib/useHydrated'
import { dayKeyOf, timeKeyOf, zonedDateTimeToUtc } from '../../../convex/lib/dates'
import type { Id } from '../../../convex/_generated/dataModel'
import type { RepeatValue } from '#/lib/format'

type SettableStatus = 'booked' | 'inProgress' | 'completed' | 'cancelled'

// "Invoiced" is deliberately excluded — no mutation can put a job there yet
// (invoicing/Xero isn't built).
const STATUS_MENU_LABEL: Record<SettableStatus, string> = {
  booked: 'Booked',
  inProgress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

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
    <Drawer.Root open={jobId !== null} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />

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

          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
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
  const [editing, setEditing] = useState(false)

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

  // Sets any non-terminal, non-confirmed status — booked or in-progress —
  // via the generic patch mutation. `complete`/`cancel` stay separate above
  // since they're dedicated mutations with their own semantics.
  const convexUpdate = useConvexMutation(api.jobs.update)
  const setStatus = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      jobId: Id<'jobs'>
      status: 'booked' | 'inProgress'
    }) => convexUpdate(args),
  })

  function selectStatus(next: SettableStatus) {
    if (!job || next === job.status) return
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

  return (
    <>
      {job ? (
        <div className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3">
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
                className="mr-8 flex items-center gap-1 text-caption font-semibold text-blue"
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
                    is driven by the server's canEdit, not by role. Invoiced has
                    no mutation to leave it — that feature doesn't exist yet — so
                    the pill is just a label there, not a trigger. */}
                {job.canEdit && job.status !== 'invoiced' ? (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        aria-label="Change job status"
                        className="flex items-center gap-1 rounded-full transition active:scale-[.97]"
                      >
                        <StatusPill status={job.status} />
                        <ChevronDown size={14} strokeWidth={2} className="text-muted" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="start"
                        sideOffset={6}
                        className="z-50 w-48 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
                      >
                        {(['booked', 'inProgress', 'completed', 'cancelled'] as const).map((option) => (
                          <DropdownMenu.Item
                            key={option}
                            onSelect={() => selectStatus(option)}
                            className="flex cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-body text-ink outline-none transition data-[highlighted]:bg-surface-2"
                          >
                            {STATUS_MENU_LABEL[option]}
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
                <span className="text-body text-muted">
                  {formatTime(job.scheduledAt, timezone)} ·{' '}
                  {formatDuration(job.durationMinutes)}
                </span>
              </div>

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

                {/* Quick-contact — hold to confirm on touch, since a phone in a
                    pocket must never silently dial or text a client (§2.3). */}
                {job.property?.client && (
                  <div className="mt-3">
                    <ContactButtons
                      name={job.property.client.name}
                      phone={job.property.client.phone}
                      email={job.property.client.email}
                    />
                  </div>
                )}
              </Section>

              <Section label="Price">
                <p className="text-metric-sm text-ink">{formatMoney(job.price)}</p>
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
                  <Repeat size={16} strokeWidth={1.7} className="text-blue" />
                  <p className="text-body text-ink">
                    {REPEAT_LABELS[job.recurrence.frequency] ?? 'Repeats'}
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
                    onClick={() => setConfirmStopRepeatingOpen(true)}
                    className="mt-3 text-caption font-semibold text-red"
                  >
                    Stop repeating
                  </button>
                )}
              </>
            ) : (
              <p className="text-body text-ink">One-off</p>
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
            timezone={timezone}
          />

          <JobNotesSection
            businessId={businessId}
            businessSlug={businessSlug}
            timezone={timezone}
            jobId={job._id}
            jobType={job.jobType}
            propertyId={job.propertyId}
            addressLine={job.property?.addressLine ?? ''}
          />

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
              This job has been invoiced and can no longer be reopened here.
            </p>
          )}

          <AlertDialog.Root open={confirmCancelOpen} onOpenChange={setConfirmCancelOpen}>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
              <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-canvas p-4 shadow-elevation outline-none">
                <AlertDialog.Title className="text-row-title text-ink">
                  Cancel this job?
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-1.5 text-body text-ink-2">
                  {job.jobType} for {job.property?.client?.name} at{' '}
                  {formatTime(job.scheduledAt, timezone)} won't happen as booked.
                  Nothing is deleted — the visit stays in the schedule marked
                  cancelled, and you can reopen it as booked any time.
                </AlertDialog.Description>
                <div className="mt-4 flex gap-2">
                  <AlertDialog.Cancel asChild>
                    <button
                      type="button"
                      className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.975]"
                    >
                      Keep job
                    </button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <button
                      type="button"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate({ businessId, jobId: job._id })}
                      className="h-11 flex-1 rounded-xl bg-red text-[15px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
                    >
                      {cancel.isPending ? 'Cancelling…' : 'Cancel job'}
                    </button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>

          <AlertDialog.Root
            open={confirmStopRepeatingOpen}
            onOpenChange={setConfirmStopRepeatingOpen}
          >
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
              <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-canvas p-4 shadow-elevation outline-none">
                <AlertDialog.Title className="text-row-title text-ink">
                  Stop repeating this service?
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-1.5 text-body text-ink-2">
                  This visit stays booked as shown. Any other future visits
                  already generated for this series will be removed from the
                  schedule — this cannot be undone. Past and completed visits
                  are not affected.
                </AlertDialog.Description>
                <div className="mt-4 flex gap-2">
                  <AlertDialog.Cancel asChild>
                    <button
                      type="button"
                      className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.975]"
                    >
                      Keep repeating
                    </button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <button
                      type="button"
                      disabled={stopRepeating.isPending}
                      onClick={() => stopRepeating.mutate({ businessId, jobId: job._id })}
                      className="h-11 flex-1 rounded-xl bg-red text-[15px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
                    >
                      {stopRepeating.isPending ? 'Stopping…' : 'Stop repeating'}
                    </button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
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
        <div className="px-4 py-10">
          <Drawer.Title className="sr-only">Job</Drawer.Title>
          <p className="text-body text-muted">Loading…</p>
        </div>
      )}
    </>
  )
}

/**
 * Every job field except status (that stays on the dropdown above — a quick
 * toggle, not a form field). Reuses `NewJobSheet.tsx`'s exact widgets rather
 * than inventing new ones: native `<select>` for property/job type/assignee,
 * `date`+`time` inputs, plain number inputs for duration/price.
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
    scheduledAt: number
    durationMinutes: number
    assignedMembershipId: Id<'memberships'>
    recurrence: { _id: Id<'recurrences'>; frequency: string; active: boolean } | null
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
  const [jobType, setJobType] = useState(job.jobType)
  // Seeded from the tenant's own timezone, not the viewer's browser zone —
  // matching what `formatTime` already displays elsewhere in this sheet, so
  // opening the edit form never shows a different time than the read view did.
  const [date, setDate] = useState(dayKeyOf(job.scheduledAt, timezone))
  const [time, setTime] = useState(timeKeyOf(job.scheduledAt, timezone))
  const [duration, setDuration] = useState(String(job.durationMinutes))
  const [price, setPrice] = useState(String(job.price / 100))
  const [assignee, setAssignee] = useState<string>(job.assignedMembershipId)
  const [repeat, setRepeat] = useState<RepeatValue>('once')
  const hasActiveRecurrence = job.recurrence?.active ?? false

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
      repeat: RepeatValue
    }) => {
      const { repeat: nextRepeat, ...patch } = args
      await convexUpdate(patch)
      // convertJobToRecurring re-reads the job's own fields from the database
      // rather than trusting these client-passed values, so it always anchors
      // on whatever was just saved above, not stale pre-edit values.
      if (!hasActiveRecurrence && nextRepeat !== 'once') {
        await convexConvert({
          businessId: patch.businessId,
          jobId: patch.jobId,
          frequency: nextRepeat,
        })
      }
    },
    onSuccess: onDone,
  })

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
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
          repeat,
        })
      }}
    >
      <EditField label="Property">
        <Combobox
          value={propertyId}
          onChange={setPropertyId}
          options={(properties ?? []).map((p) => ({
            value: p._id,
            label: `${p.client?.name} — ${p.addressLine}, ${p.suburb}`,
          }))}
          placeholder="Search by name or address"
          noMatchLabel="No properties match"
          ariaLabel="Property"
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

      {/* Reassignment is an owner-only action even on your own job (jobs.update
          enforces this server-side too) — a non-owner sees who it's assigned
          to as plain text instead of a control they'd be rejected for using. */}
      <EditField label="Assigned to">
        {canReassign ? (
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          >
            {members
              ?.filter((m) => m.status === 'active')
              .map((m) => (
                <option key={m._id} value={m._id}>
                  {m.name || (m.role === 'owner' ? 'Owner' : 'Subcontractor')}
                </option>
              ))}
          </select>
        ) : (
          <p className="flex h-12 w-full items-center rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink">
            {members?.find((m) => m._id === job.assignedMembershipId)?.name ??
              'Assigned technician'}
          </p>
        )}
      </EditField>

      <div className="grid grid-cols-2 gap-3">
        <EditField label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </EditField>
        <EditField label="Start">
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
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
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </EditField>
        <EditField label="Price (AUD)">
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </EditField>
      </div>

      <EditField label="Repeat">
        {hasActiveRecurrence ? (
          <>
            <p className="flex h-12 w-full items-center rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink">
              {REPEAT_OPTIONS.find((o) => o.value === job.recurrence?.frequency)
                ?.label ?? 'Repeating'}
            </p>
            <p className="mt-1.5 text-caption text-muted">
              To change how often this repeats, use "Stop repeating" above and
              set up a new series.
            </p>
          </>
        ) : (
          <select
            value={repeat}
            onChange={(e) => setRepeat(e.target.value as RepeatValue)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          >
            {REPEAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </EditField>

      {save.isError && (
        <p
          role="alert"
          className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          Could not save these changes.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.975]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={save.isPending || !hydrated}
          className="h-11 flex-1 rounded-xl bg-red text-[15px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
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
function JobReports({
  businessId,
  businessSlug,
  propertyId,
  jobId,
  timezone,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  propertyId: Id<'properties'>
  jobId: Id<'jobs'>
  timezone: string
}) {
  const { data } = useQuery(
    convexQuery(api.reports.listByProperty, { businessId, propertyId }),
  )
  const reports = data ?? []
  const forThisJob = reports.filter((r) => r.jobId === jobId)
  const otherReports = reports.filter((r) => r.jobId !== jobId)

  return (
    <Section label="Reports">
      {forThisJob.length > 0 && (
        <div className="mb-3 flex flex-col divide-y divide-hairline">
          {forThisJob.map((report) => (
            <ReportRow key={report._id} businessSlug={businessSlug} report={report} timezone={timezone} />
          ))}
        </div>
      )}

      <Link
        to="/$businessSlug/reports/new"
        params={{ businessSlug }}
        search={{ propertyId, jobId }}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.98]"
      >
        <Plus size={16} strokeWidth={1.8} />
        New report
      </Link>

      {otherReports.length > 0 && (
        <>
          <p className="section-label mb-2 mt-4">Other reports at this property</p>
          <div className="flex flex-col divide-y divide-hairline">
            {otherReports.map((report) => (
              <ReportRow key={report._id} businessSlug={businessSlug} report={report} timezone={timezone} />
            ))}
          </div>
        </>
      )}
    </Section>
  )
}

function ReportRow({
  businessSlug,
  report,
  timezone,
}: {
  businessSlug: string
  report: {
    _id: Id<'reports'>
    legalBasis: string
    status: string
    finalisedAt?: number
    createdAt: number
  }
  timezone: string
}) {
  return (
    <Link
      to="/$businessSlug/reports/$reportId"
      params={{ businessSlug, reportId: report._id }}
      className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
    >
      <span className="min-w-0">
        <span className="block truncate text-body text-ink">
          {report.legalBasis}
        </span>
        <span className="text-caption text-muted">
          {new Intl.DateTimeFormat('en-AU', {
            timeZone: timezone,
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }).format(new Date(report.finalisedAt ?? report.createdAt))}
        </span>
      </span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
          report.status === 'finalised'
            ? 'bg-green/12 text-green'
            : 'border border-amber-line bg-amber-bg text-amber-ink'
        }`}
      >
        {report.status === 'finalised' ? 'Finalised' : 'Draft'}
      </span>
    </Link>
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
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

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
      const { default: compress } = await import('browser-image-compression')
      for (const file of files) {
        const compressed = await compress(file, {
          maxSizeMB: 1,
          maxWidthOrHeight: 2000,
          useWebWorker: true,
        })
        const uploadUrl = await getUploadUrl({ businessId })
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': compressed.type },
          body: compressed,
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
          {photos.map((photo) => (
            <div key={photo._id} className="relative">
              <img
                src={photo.url ?? undefined}
                alt=""
                className="aspect-square w-full rounded-lg object-cover"
              />
              {canEdit && (
                <button
                  type="button"
                  aria-label="Remove photo"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ businessId, jobId, photoId: photo._id })}
                  className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-black/50 text-white transition active:scale-95"
                >
                  <Trash2 size={12} strokeWidth={2} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.98] disabled:opacity-50"
          >
            <Camera size={16} strokeWidth={1.8} />
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
