import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { Bone } from '#/components/shell/Pending'
import { STAT_CARD } from '#/components/analytics/StatTile'
import { formatJobDate } from '#/lib/format'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'

export type AnalyticsPaperwork = NonNullable<
  FunctionReturnType<typeof api.analytics.paperwork>
>

/** Jobs shown before "Show all". */
const JOBS_SHOWN = 5

const jobs = (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'}`

/**
 * Finished jobs in the range that should have a report and have none
 * finalised: how many, and the jobs themselves, newest first, each opening
 * its job so the report can be written or finished.
 *
 * Given its figures (`analytics.paperwork`), like the cards beside it.
 */
export function PaperworkCard({
  businessSlug,
  today,
  data,
  failed = false,
  onRetry,
}: {
  businessSlug: string
  today: string
  /** `undefined` while it loads. */
  data: AnalyticsPaperwork | undefined
  failed?: boolean
  onRetry?: () => void
}) {
  const [all, setAll] = useState(false)
  if (failed && !data)
    return <LoadFailed what="the paperwork" onRetry={onRetry} />
  if (!data)
    return (
      <div className={STAT_CARD}>
        <Bone className="mb-3 h-3 w-20" />
        <Bone className="h-7 w-16" />
        <Bone className="mt-2 h-4 w-56" />
      </div>
    )

  const shown = all ? data.jobs : data.jobs.slice(0, JOBS_SHOWN)
  const scope = data.more ? `the newest ${data.checked}` : `${data.checked}`

  return (
    <div className={STAT_CARD}>
      <h2 className="section-label mb-1">Paperwork</h2>
      {data.checked === 0 ? (
        <p className="py-1 text-body text-muted">
          No finished job in these dates needed a report.
        </p>
      ) : data.missing === 0 ? (
        <p className="py-1 text-body text-ink-2">
          {data.checked === 1
            ? 'The one finished job that needed a report has it finalised.'
            : `All ${scope} finished jobs that needed a report have one finalised.`}
        </p>
      ) : (
        <>
          <p className="text-metric-sm text-ink">{data.missing}</p>
          <p className="mt-1 text-body text-ink-2">
            of {scope} finished {data.checked === 1 ? 'job' : 'jobs'} that
            needed a report {data.missing === 1 ? 'has' : 'have'} none
            finalised.
          </p>
          <ul className="mt-1 flex flex-col">
            {shown.map((job) => (
              <li key={job.jobId} className="border-t border-hairline-2">
                <Link
                  to="/$businessSlug/job"
                  params={{ businessSlug }}
                  search={{ jobId: job.jobId }}
                  className="flex min-h-11 items-center gap-3 rounded-xl py-2 outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:bg-surface-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-ink">
                      {job.client}
                    </span>
                    <span className="block truncate text-caption text-muted">
                      {[
                        job.jobNumber !== null && `Job ${job.jobNumber}`,
                        job.suburb,
                        job.jobType,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 text-caption text-muted">
                    {formatJobDate(job.dayKey, today)}
                  </span>
                  <ChevronRight
                    size={16}
                    strokeWidth={2.2}
                    aria-hidden
                    className="shrink-0 text-muted-2"
                  />
                </Link>
              </li>
            ))}
          </ul>
          {data.jobs.length > JOBS_SHOWN && !all && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="relative tap-target mt-1 text-body font-semibold text-blue"
            >
              Show all {data.jobs.length}
            </button>
          )}
          {data.missing > data.jobs.length && (
            <p className="mt-2 text-caption text-muted">
              Showing the newest {jobs(data.jobs.length)}.
            </p>
          )}
        </>
      )}
    </div>
  )
}
