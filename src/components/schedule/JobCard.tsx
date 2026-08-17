import { formatDuration, formatMoney, formatTime } from '#/lib/format'
import { StatusPill } from '#/components/primitives/StatusPill'
import type { JobStatus } from '#/components/primitives/StatusPill'

export type JobRow = {
  _id: string
  jobType: string
  price: number
  scheduledAt: number
  durationMinutes: number
  status: JobStatus
  suburb: string
  clientName: string
  assigneeColour: string
}

export function JobCard({
  job,
  timezone,
  onOpen,
}: {
  job: JobRow
  timezone: string
  onOpen: (jobId: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(job._id)}
      className="flex w-full items-stretch gap-3 rounded-2xl border border-hairline bg-surface p-3 text-left shadow-elevation transition active:scale-[.99]"
    >
      <span
        aria-hidden
        className="w-1 shrink-0 rounded-full"
        style={{ backgroundColor: job.assigneeColour }}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-row-title text-ink">
            {job.jobType}
          </span>
          <span className="shrink-0 text-caption text-muted">
            {formatTime(job.scheduledAt, timezone)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-body text-ink-2">
          {job.clientName}
        </span>
        {/* Suburb here, full street address in the detail sheet (§2.3). */}
        <span className="mt-0.5 flex items-center gap-2 text-caption text-muted">
          <span className="truncate">{job.suburb}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">
            {formatDuration(job.durationMinutes)}
          </span>
        </span>
        <span className="mt-2 flex items-center justify-between gap-2">
          <StatusPill status={job.status} />
          <span className="text-row-title text-ink">
            {formatMoney(job.price)}
          </span>
        </span>
      </span>
    </button>
  )
}
