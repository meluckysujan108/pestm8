import { Repeat } from 'lucide-react'
import { formatDuration, formatJobMoney, formatTime } from '#/lib/format'
import { StatusPill } from '#/components/primitives/StatusPill'
import { WeatherStrip } from './WeatherStrip'
import type { JobStatus } from '#/components/primitives/StatusPill'
import type { WeatherCell } from '#/lib/weather'

export type JobRow = {
  _id: string
  jobNumber?: number
  jobType: string
  price: number
  scheduledAt: number
  durationMinutes: number
  status: JobStatus
  addressLine?: string
  suburb: string
  postcode?: string
  clientName: string
  assigneeColour: string
  assigneeName?: string
  assignedMembershipId: string
  recurrenceId?: string
}

/** "9:30am – 11:00am · 1 hr" — the span, not just the start. */
function timeRange(job: JobRow, timezone: string): string {
  const end = job.scheduledAt + job.durationMinutes * 60_000
  return `${formatTime(job.scheduledAt, timezone)} – ${formatTime(end, timezone)} · ${formatDuration(job.durationMinutes)}`
}

/** A label on the left, its value right-aligned against it. */
function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <span className="flex items-center justify-between gap-3 py-[3px]">
      <span className="shrink-0 text-caption text-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-caption font-semibold text-ink-2">
        {children}
      </span>
    </span>
  )
}

export function JobCard({
  job,
  weather = { status: 'outOfWindow' },
  timezone,
  travel,
  onOpen,
  hideTechnician = false,
}: {
  job: JobRow
  /** The day's forecast where there is one. The Job tab lists work across
   * months, where a per-row forecast neither exists nor is the point, so it
   * renders without one. */
  weather?: WeatherCell
  timezone: string
  /** Hop from the previous job in the day, e.g. "≈ 8 km → Morley". */
  travel?: string | null
  onOpen: (jobId: string) => void
  /** "Just my jobs": every card is the viewer's, so naming him on each one is
   * noise rather than information. */
  hideTechnician?: boolean
}) {
  const shell =
    'flex w-full items-stretch gap-3.5 rounded-2xl border border-hairline bg-surface text-left shadow-elevation transition active:scale-[.99]'

  return (
    <button
      type="button"
      onClick={() => onOpen(job._id)}
      className={`${shell} h-full p-0`}
    >
      <span
        aria-hidden
        className="w-1.5 shrink-0 rounded-l-2xl"
        style={{ backgroundColor: job.assigneeColour }}
      />

      <span className="flex min-w-0 flex-1 flex-col gap-3 p-4 pl-1">
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            {job.jobNumber !== undefined && (
              <span className="shrink-0 font-mono text-caption font-bold tabular-nums text-muted">
                #{job.jobNumber}
              </span>
            )}
            <StatusPill status={job.status} />
            {job.recurrenceId !== undefined && (
              <Repeat
                size={13}
                strokeWidth={1.7}
                role="img"
                aria-label="Recurring job"
                className="shrink-0 text-blue"
              />
            )}
          </span>
          <span className="shrink-0 font-mono text-caption tabular-nums text-muted">
            {formatTime(job.scheduledAt, timezone)}
          </span>
        </span>

        <span className="block min-w-0">
          <span className="block truncate text-sheet-title text-ink">
            {job.clientName}
          </span>
          {/* The full street address: a card this size is being read, not
              scanned past. */}
          <span className="mt-0.5 block truncate text-caption text-muted">
            {[job.addressLine, job.suburb, job.postcode]
              .filter(Boolean)
              .join(', ')}
          </span>
        </span>

        <span className="block border-t border-hairline-2 pt-1.5">
          <Row label="Service">{job.jobType}</Row>
          <Row label="Time">{timeRange(job, timezone)}</Row>
          {job.assigneeName && !hideTechnician && (
            <Row label="Technician">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: job.assigneeColour }}
                />
                {job.assigneeName}
              </span>
            </Row>
          )}
        </span>

        <WeatherStrip cell={weather} />

        <span className="mt-auto flex items-end justify-between gap-2 border-t border-hairline-2 pt-3">
          <span className="min-w-0 truncate text-caption text-muted">
            {travel ?? ''}
          </span>
          <span className="shrink-0 text-metric-sm leading-none text-ink">
            {formatJobMoney(job)}
          </span>
        </span>
      </span>
    </button>
  )
}
