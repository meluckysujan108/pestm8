import { Repeat } from 'lucide-react'
import { formatDuration, formatMoney, formatTime } from '#/lib/format'
import { StatusPill } from '#/components/primitives/StatusPill'
import { WeatherGlyph } from './WeatherGlyph'
import { WeatherStrip } from './WeatherStrip'
import type { JobStatus } from '#/components/primitives/StatusPill'
import type { DayWeather } from '#/lib/useDayWeather'

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

/**
 * `list` is the compact row for scanning a busy day; `board` is the rich card
 * for reading one. They share this component rather than living in two files
 * so a field added to one cannot quietly go missing from the other.
 */
export type JobCardVariant = 'list' | 'board'

/** "9:30am – 11:00am · 1 hr" — the span, not just the start. */
function timeRange(job: JobRow, timezone: string): string {
  const end = job.scheduledAt + job.durationMinutes * 60_000
  return `${formatTime(job.scheduledAt, timezone)} – ${formatTime(end, timezone)} · ${formatDuration(job.durationMinutes)}`
}

/** A label on the left, its value right-aligned against it. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
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
  weather,
  timezone,
  variant = 'list',
  travel,
  onOpen,
}: {
  job: JobRow
  weather?: DayWeather
  timezone: string
  variant?: JobCardVariant
  /** Hop from the previous job in the day, e.g. "≈ 8 km → Morley". */
  travel?: string | null
  onOpen: (jobId: string) => void
}) {
  const shell =
    'flex w-full items-stretch gap-3.5 rounded-2xl border border-hairline bg-surface text-left shadow-elevation transition active:scale-[.99]'

  if (variant === 'list') {
    return (
      <button
        type="button"
        onClick={() => onOpen(job._id)}
        className={`${shell} p-4`}
      >
        <span
          aria-hidden
          className="w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: job.assigneeColour }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              {job.jobNumber !== undefined && (
                <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-caption font-bold tabular-nums text-ink-2">
                  #{job.jobNumber}
                </span>
              )}
              <span className="truncate text-sheet-title text-ink">
                {job.jobType}
              </span>
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
            <span className="shrink-0 text-caption text-muted">
              {formatTime(job.scheduledAt, timezone)}
            </span>
          </span>

          <span className="mt-1 block truncate text-body text-ink-2">
            {job.clientName}
          </span>

          {/* Suburb alone on the compact row — the full street address is the
              board variant's job, and the detail sheet's (§2.3). */}
          <span className="mt-0.5 flex items-center gap-2 text-caption text-muted">
            <span className="truncate">{job.suburb}</span>
            {weather && <WeatherGlyph weather={weather} size={14} />}
            <span aria-hidden>·</span>
            <span className="shrink-0">
              {formatDuration(job.durationMinutes)}
            </span>
          </span>

          <span className="mt-2.5 flex items-center justify-between gap-2">
            <StatusPill status={job.status} />
            <span className="text-row-title text-ink">
              {formatMoney(job.price)}
            </span>
          </span>
        </span>
      </button>
    )
  }

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
          {/* Full street address here, unlike the compact list row — a card
              this size is being read, not scanned past. */}
          <span className="mt-0.5 block truncate text-caption text-muted">
            {[job.addressLine, job.suburb, job.postcode]
              .filter(Boolean)
              .join(', ')}
          </span>
        </span>

        <span className="block border-t border-hairline-2 pt-1.5">
          <Row label="Service">{job.jobType}</Row>
          <Row label="Time">{timeRange(job, timezone)}</Row>
          {job.assigneeName && (
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

        <WeatherStrip weather={weather} />

        <span className="mt-auto flex items-end justify-between gap-2 border-t border-hairline-2 pt-3">
          <span className="min-w-0 truncate text-caption text-muted">
            {travel ?? ''}
          </span>
          <span className="shrink-0 text-metric-sm leading-none text-ink">
            {formatMoney(job.price)}
          </span>
        </span>
      </span>
    </button>
  )
}
