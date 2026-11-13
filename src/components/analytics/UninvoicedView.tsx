import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { EmptyState, LoadFailed } from '#/components/primitives/EmptyState'
import { Bone } from '#/components/shell/Pending'
import { STAT_CARD } from '#/components/analytics/StatTile'
import { formatJobDate, formatMoney } from '#/lib/format'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'
import type { AgeBand } from '../../../convex/lib/analyticsRange'

export type UninvoicedReport = NonNullable<
  FunctionReturnType<typeof api.analytics.uninvoiced>
>

const BAND_LABEL: Record<AgeBand, string> = {
  week: 'Up to 7 days',
  fortnight: '8 to 14 days',
  month: '15 to 30 days',
  older: 'More than 30 days',
}

const jobs = (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'}`

/**
 * Finished work not yet invoiced, by how long it has waited: the total, the
 * four bands with a bar each, and the jobs themselves, the longest wait
 * first, each opening its job so it can be invoiced.
 *
 * Given its figures, like `AnalyticsOverview`, so the harness can draw it.
 */
export function UninvoicedView({
  businessSlug,
  today,
  report,
  narrowed = false,
  failed = false,
  onRetry,
}: {
  businessSlug: string
  today: string
  /** `undefined` while it loads. */
  report: UninvoicedReport | undefined
  /** A service or a person is chosen on Analytics, and carried here. */
  narrowed?: boolean
  failed?: boolean
  onRetry?: () => void
}) {
  if (failed && !report)
    return (
      <section className="px-4 pt-4 pb-6">
        <LoadFailed what="the jobs awaiting invoice" onRetry={onRetry} />
      </section>
    )
  if (!report)
    return (
      <section className="flex flex-col gap-3 px-4 pt-4 pb-6">
        <div className={STAT_CARD}>
          <Bone className="h-9 w-32" />
          <Bone className="mt-2 h-4 w-48" />
        </div>
        <div className={STAT_CARD}>
          {[0, 1, 2, 3].map((i) => (
            <Bone key={i} className="my-3 h-5 w-full" />
          ))}
        </div>
      </section>
    )

  const most = Math.max(...report.bands.map((band) => band.count), 1)

  return (
    <section className="flex flex-col gap-3 px-4 pt-4 pb-6">
      {narrowed && (
        <p className="text-caption text-muted">
          Narrowed as on Analytics.{' '}
          <Link
            to="/$businessSlug/analytics/uninvoiced"
            params={{ businessSlug }}
            className="font-semibold text-blue"
          >
            Show every job
          </Link>
        </p>
      )}

      {report.count === 0 ? (
        <EmptyState
          title="Nothing awaiting invoice"
          body="Finished jobs that haven’t been invoiced are listed here."
        />
      ) : (
        <>
          <div className={STAT_CARD}>
            {/* Without prices the count is the figure: never a lone dash
                where the page's one big number goes. */}
            <p className="text-metric-lg text-ink">
              {report.value === null ? report.count : formatMoney(report.value)}
            </p>
            <p className="mt-1 text-body text-ink-2">
              {report.value === null
                ? `finished ${report.count === 1 ? 'job' : 'jobs'} not yet invoiced.`
                : `${jobs(report.count)} finished and not yet invoiced.`}
            </p>
          </div>

          <div className={STAT_CARD}>
            <h2 className="section-label mb-1">How long they’ve waited</h2>
            <ul className="flex flex-col">
              {report.bands.map((band) => (
                <li key={band.key} className="py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-body text-ink">
                      {BAND_LABEL[band.key]}
                    </span>
                    <span className="text-body text-ink tabular-nums">
                      {band.value === null ? (
                        jobs(band.count)
                      ) : (
                        <>
                          {formatMoney(band.value)}
                          <span className="text-caption text-muted">
                            {' · '}
                            {jobs(band.count)}
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  {/* Ink, not a hue: a bar here is a length, not a status. */}
                  <div
                    aria-hidden
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
                  >
                    <div
                      className="h-full rounded-full bg-ink-2"
                      style={{ width: `${(band.count / most) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="section-label mb-2 px-1">Longest wait first</h2>
            <ul className="flex flex-col gap-2">
              {report.jobs.map((job) => (
                <li key={job.jobId}>
                  <Link
                    to="/$businessSlug/job"
                    params={{ businessSlug }}
                    search={{ status: 'completed', jobId: job.jobId }}
                    className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3 shadow-elevation outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.99]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-row-title text-ink">
                        {job.client}
                      </p>
                      <p className="truncate text-caption text-muted">
                        {[job.suburb, job.jobType].filter(Boolean).join(' · ')}
                      </p>
                      <p className="truncate text-caption text-muted">
                        {job.jobNumber !== null && `Job ${job.jobNumber} · `}
                        Finished {formatJobDate(job.dayKey, today)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-body font-semibold text-ink tabular-nums">
                        {formatMoney(job.price)}
                      </p>
                      <p className="text-caption text-muted tabular-nums">
                        {job.days === 0
                          ? 'Under a day'
                          : `${job.days} ${job.days === 1 ? 'day' : 'days'}`}
                      </p>
                    </div>
                    <ChevronRight
                      size={18}
                      strokeWidth={2}
                      aria-hidden
                      className="shrink-0 text-muted-2"
                    />
                  </Link>
                </li>
              ))}
            </ul>
            {report.more && (
              <p className="mt-3 px-1 text-caption text-muted">
                Showing the {report.jobs.length} that have waited longest.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}
