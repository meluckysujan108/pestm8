import { Link } from '@tanstack/react-router'
import { ChevronRight, Repeat } from 'lucide-react'
import { dayKeyOf } from '../../../convex/lib/dates'
import { StatusPill } from '#/components/primitives/StatusPill'
import { ReportChip } from '#/components/reports/ReportRows'
import { formatJobDate, formatTime, todayKey } from '#/lib/format'
import type { InlineReport } from '#/components/reports/ReportRows'

/**
 * A visit in a list — a job's history, a client's jobs — opening it on the
 * Schedule, with each report it produced as a chip under it.
 *
 * Headed by the service, or, where every row is the same service (a
 * recurring service's own visits), by the day.
 */
export function VisitRow({
  businessSlug,
  timezone,
  visit,
  reports,
  headedBy = 'service',
  site,
}: {
  businessSlug: string
  timezone: string
  visit: {
    _id: string
    scheduledAt: number
    status: string
    jobType: string
    recurrenceId?: string
  }
  reports: ReadonlyArray<InlineReport>
  headedBy?: 'service' | 'day'
  /** Which of the client's sites, where they have more than one. */
  site?: string
}) {
  const dayKey = dayKeyOf(visit.scheduledAt, timezone)
  const day = formatJobDate(dayKey, todayKey(timezone))
  const time = formatTime(visit.scheduledAt, timezone)
  return (
    <div className="px-3.5 py-2">
      <Link
        to="/$businessSlug/schedule"
        params={{ businessSlug }}
        search={{ date: dayKey, jobId: visit._id }}
        className="flex min-h-11 items-center justify-between gap-2"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-body text-ink">
            <span className="truncate">
              {headedBy === 'day' ? day : visit.jobType}
            </span>
            {headedBy === 'service' && visit.recurrenceId !== undefined && (
              <>
                <Repeat
                  aria-hidden
                  size={13}
                  strokeWidth={2}
                  className="shrink-0 text-muted"
                />
                <span className="sr-only">, recurring</span>
              </>
            )}
          </span>
          <span className="block truncate text-caption text-muted">
            {headedBy === 'day' ? time : `${day} · ${time}`}
            {site && ` · ${site}`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <StatusPill status={visit.status} />
          <ChevronRight
            aria-hidden
            size={16}
            strokeWidth={2.2}
            className="text-muted-2"
          />
        </span>
      </Link>
      {reports.length > 0 && (
        <div className="mb-0.5 mt-1 flex flex-col gap-1.5">
          {reports.map((report) => (
            <ReportChip
              key={report._id}
              businessSlug={businessSlug}
              report={report}
            />
          ))}
        </div>
      )}
    </div>
  )
}
