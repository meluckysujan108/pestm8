import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import { Check, Mail, Phone, Repeat, X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { HoldButton } from '#/components/primitives/HoldButton'
import { StatusPill } from '#/components/primitives/StatusPill'
import {
  REPEAT_LABELS,
  formatDuration,
  formatMoney,
  formatTime,
} from '#/lib/format'
import { WeatherGlyph } from './WeatherGlyph'
import { isWet, isWindy, useDayWeather } from '#/lib/useDayWeather'
import type { Id } from '../../../convex/_generated/dataModel'

export function JobDetailSheet({
  businessId,
  timezone,
  jobId,
  onClose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  jobId: string | null
  onClose: () => void
}) {
  return (
    <Drawer.Root open={jobId !== null} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />

          {/* Mounted only with a real id, so the query never needs a skip
              sentinel and its key is always well-formed. */}
          {jobId !== null && (
            <JobDetailBody
              businessId={businessId}
              timezone={timezone}
              jobId={jobId as Id<'jobs'>}
              onClose={onClose}
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
  timezone,
  jobId,
  onClose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  jobId: Id<'jobs'>
  onClose: () => void
}) {
  const { data: job } = useQuery(
    convexQuery(api.jobs.get, { businessId, jobId }),
  )

  const convexComplete = useConvexMutation(api.jobs.complete)
  const complete = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; jobId: Id<'jobs'> }) =>
      convexComplete(args),
    onSuccess: onClose,
  })

  return (
    <>
      {job ? (
        <div className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3">
          <Drawer.Title className="text-sheet-title text-ink">
            {job.jobType}
          </Drawer.Title>
          <div className="mt-2 flex items-center gap-2">
            <StatusPill status={job.status} />
            <span className="text-body text-muted">
              {formatTime(job.scheduledAt, timezone)} ·{' '}
              {formatDuration(job.durationMinutes)}
            </span>
          </div>

          <Section label="Property">
            <p className="text-row-title text-ink">
              {job.property?.clientName}
            </p>
            {/* Full street address here — the list rows show suburb only. */}
            <p className="text-body text-ink-2">{job.property?.addressLine}</p>
            <p className="text-body text-muted">
              {job.property?.suburb} {job.property?.state}{' '}
              {job.property?.postcode}
            </p>

            <div className="mt-3 flex gap-2">
              {job.property?.phone && (
                <HoldButton
                  ariaLabel={`Call ${job.property.clientName}`}
                  onComplete={() => {
                    window.location.href = `tel:${job.property!.phone}`
                  }}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 py-3 text-body font-semibold text-blue"
                >
                  <Phone size={17} strokeWidth={1.7} />
                  Hold to call
                </HoldButton>
              )}
              {job.property?.email && (
                <HoldButton
                  ariaLabel={`Email ${job.property.clientName}`}
                  onComplete={() => {
                    window.location.href = `mailto:${job.property!.email}`
                  }}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 py-3 text-body font-semibold text-blue"
                >
                  <Mail size={17} strokeWidth={1.7} />
                  Hold to email
                </HoldButton>
              )}
            </div>
          </Section>

          <Section label="Price">
            <p className="text-metric-sm text-ink">{formatMoney(job.price)}</p>
          </Section>

          {/* Weather for this property on this day, not the day in general —
              two jobs on the same day can be in different suburbs. */}
          <JobWeather
            businessId={businessId}
            state={job.property?.state ?? ''}
            suburb={job.property?.suburb ?? ''}
            postcode={job.property?.postcode ?? ''}
            dayKey={dayKeyInZone(job.scheduledAt, timezone)}
          />

          {job.recurrence && (
            <Section label="Recurrence">
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
            </Section>
          )}

          {/* Read access can be granted without edit rights, so the
                  actions are driven by the server's canEdit, not by role. */}
          {job.canEdit ? (
            job.status === 'booked' && (
              <button
                type="button"
                disabled={complete.isPending}
                onClick={() =>
                  complete.mutate({
                    businessId,
                    jobId: job._id as Id<'jobs'>,
                  })
                }
                className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
              >
                <Check size={18} strokeWidth={2} />
                {complete.isPending ? 'Saving…' : 'Mark completed'}
              </button>
            )
          ) : (
            <p className="mt-6 rounded-xl border border-amber-line bg-amber-bg px-3 py-2.5 text-caption text-amber-ink">
              This job is assigned to someone else, so it is read-only.
            </p>
          )}
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
}: {
  businessId: Id<'businesses'>
  state: string
  suburb: string
  postcode: string
  dayKey: string
}) {
  const weather = useDayWeather(
    businessId,
    state,
    suburb ? [{ dayKey, suburb, postcode }] : [],
  )
  const day = weather[dayKey]

  // Absent outside the forecast window, which is most of a year — showing an
  // empty weather card for a job in March would read as "fine".
  if (!day) return null

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
