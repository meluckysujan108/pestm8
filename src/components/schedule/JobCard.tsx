import { Repeat } from 'lucide-react'
import { formatDuration, formatMoney, formatTime } from '#/lib/format'
import { StatusPill } from '#/components/primitives/StatusPill'
import { WeatherGlyph } from './WeatherGlyph'
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
  suburb: string
  postcode?: string
  clientName: string
  assigneeColour: string
  assignedMembershipId: string
  recurrenceId?: string
}

export function JobCard({
  job,
  weather,
  timezone,
  onOpen,
}: {
  job: JobRow
  weather?: DayWeather
  timezone: string
  onOpen: (jobId: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(job._id)}
      className="flex w-full items-stretch gap-3.5 rounded-2xl border border-hairline bg-surface p-4 text-left shadow-elevation transition active:scale-[.99]"
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
              <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-caption font-bold tabular-nums text-ink-2">
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

        {/* Suburb here, full street address in the detail sheet (§2.3). */}
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
