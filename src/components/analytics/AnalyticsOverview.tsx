import { Suspense, lazy } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { Bone } from '#/components/shell/Pending'
import { AnalyticsFilterButton } from '#/components/analytics/AnalyticsFilterButton'
import { RangeButton } from '#/components/analytics/RangeButton'
import {
  STAT_CARD,
  StatTile,
  StatTilePending,
} from '#/components/analytics/StatTile'
import { changeOf, rangeSearch } from '#/lib/analyticsView'
import { formatDateRange, formatMoney } from '#/lib/format'
import type { ReactNode } from 'react'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'
import type { Compare } from '../../../convex/lib/analyticsRange'
import type { AnalyticsSearch, ResolvedRange } from '#/lib/analyticsView'

// A chunk of its own, so `recharts` (~150KB gzipped) loads only for whoever
// opens Analytics, and the tiles above it never wait for it.
const LazyTrendChart = lazy(() =>
  import('#/components/analytics/TrendChart').then((m) => ({
    default: m.TrendChart,
  })),
)

/** Asked for as the route loads, so the chart's chunk is on its way before
 * the page draws. A failed fetch is asked again when the chart renders. */
export function preloadTrendChart(): void {
  void import('#/components/analytics/TrendChart').catch(() => {})
}

export type AnalyticsReport = NonNullable<
  FunctionReturnType<typeof api.analytics.report>
>

const jobs = (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'}`

/**
 * The Analytics overview under its header: which days and what they are
 * compared with, the filters, four headline figures, the finished work still
 * to bill (opening Payments' To bill), and the range drawn over time.
 *
 * It is given its figures rather than reading them, so the route decides how
 * they load and the UI harness can draw it from sample data. Changing the
 * range or a filter keeps the last figures on screen (dimmed, `stale`) until
 * the new ones land, so nothing collapses to a placeholder under a thumb.
 */
export function AnalyticsOverview({
  businessSlug,
  today,
  range,
  compare,
  search,
  report,
  stale = false,
  failed = false,
  onRetry,
  ready = true,
  onSearch,
  children,
}: {
  businessSlug: string
  /** Today in the business's calendar. */
  today: string
  range: ResolvedRange
  compare: Compare
  search: AnalyticsSearch
  /** `undefined` while the first figures load. */
  report: AnalyticsReport | undefined
  /** The figures shown are for the choice before this one. */
  stale?: boolean
  failed?: boolean
  onRetry?: () => void
  /** Hydrated: the controls answer a tap. */
  ready?: boolean
  onSearch: (next: Partial<AnalyticsSearch>) => void
  /** A line under everything: whose figures these are. */
  children?: ReactNode
}) {
  return (
    <>
      <div className="px-4 pt-3">
        <div className="flex min-h-9 items-center justify-between gap-3">
          <div className="min-w-0">
            <RangeButton
              range={range}
              compare={compare}
              today={today}
              disabled={!ready}
              onRange={(choice) => onSearch(rangeSearch(choice))}
              onCompare={(next) =>
                onSearch({ compare: next === 'previous' ? undefined : next })
              }
            />
          </div>
          <AnalyticsFilterButton
            service={search.service}
            staffId={search.staff ?? 'all'}
            services={report?.services ?? []}
            people={report?.people ?? []}
            disabled={!ready}
            onChange={onSearch}
          />
        </div>
        {/* One line whatever it says, so the figures under it never move. */}
        <p className="mt-2 truncate text-caption text-muted">
          {formatDateRange(range.from, range.to, today)}
          {report?.comparison
            ? ` · compared with ${formatDateRange(report.comparison.from, report.comparison.to, today)}`
            : compare === 'none'
              ? ' · not compared'
              : ''}
        </p>
      </div>

      <section
        aria-busy={stale || undefined}
        className={`flex flex-col gap-3 px-4 pt-4 pb-6 transition-opacity ${stale ? 'opacity-60' : ''}`}
      >
        {failed && !report ? (
          <LoadFailed what="the figures" onRetry={onRetry} />
        ) : !report ? (
          <OverviewPending />
        ) : (
          <Figures businessSlug={businessSlug} today={today} report={report} />
        )}
        {children}
      </section>
    </>
  )
}

function Figures({
  businessSlug,
  today,
  report,
}: {
  businessSlug: string
  today: string
  report: AnalyticsReport
}) {
  const { totals, before, series, bookedAhead, uninvoiced, pricesHidden } =
    report
  // Someone who can't see prices still gets the shape of the work: the
  // chart counts jobs instead of dollars, and the two money tiles are left
  // out rather than shown as a pair of dashes.
  const kind = pricesHidden ? 'count' : 'money'
  const points = series.map((point) => ({
    start: point.start,
    now: pricesHidden ? point.completed : (point.revenue ?? 0),
    before: pricesHidden ? point.beforeCompleted : point.beforeRevenue,
  }))
  const nothingDone =
    totals.completed === 0 && (before === null || before.completed === 0)

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {!pricesHidden && (
          <StatTile
            label="Revenue"
            value={formatMoney(totals.revenue)}
            change={changeOf(totals.revenue, before?.revenue)}
            spark={series.map((p) => p.revenue ?? 0)}
          />
        )}
        <StatTile
          label="Jobs completed"
          value={String(totals.completed)}
          change={changeOf(totals.completed, before?.completed)}
          spark={series.map((p) => p.completed)}
        />
        {!pricesHidden && (
          <StatTile
            label="Average job"
            value={formatMoney(totals.averageJob)}
            change={changeOf(totals.averageJob, before?.averageJob)}
          />
        )}
        <StatTile
          label="Booked ahead"
          value={
            pricesHidden
              ? String(bookedAhead.count)
              : formatMoney(bookedAhead.value)
          }
          note={
            pricesHidden
              ? `jobs, next ${bookedAhead.days / 7} weeks`
              : `${jobs(bookedAhead.count)}, next ${bookedAhead.days / 7} weeks`
          }
        />
      </div>

      {/* A hidden price hides the count with it (analytics.ts), so there is
          nothing to say here to someone who can't see prices. The list is
          Payments' To bill: one list of work done and not billed, whichever
          page it is reached from. */}
      {uninvoiced.value !== null && uninvoiced.count !== null && (
        <Link
          to="/$businessSlug/payments"
          params={{ businessSlug }}
          search={{ tab: 'toBill' }}
          className={`${STAT_CARD} flex items-center gap-3 outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.99]`}
        >
          <div className="min-w-0 flex-1">
            <p className="section-label mb-1">To bill</p>
            <p className="text-metric text-ink">
              {formatMoney(uninvoiced.value)}
            </p>
            <p className="mt-1 text-body text-ink-2">
              {uninvoiced.count === 0
                ? 'Nothing to bill.'
                : `${jobs(uninvoiced.count)} finished and not yet billed${uninvoiced.more ? ', or more' : ''}.`}
            </p>
            {uninvoiced.oldCount !== null && uninvoiced.oldCount > 0 && (
              <p className="mt-0.5 text-caption text-amber-ink">
                {jobs(uninvoiced.oldCount)} ({formatMoney(uninvoiced.oldValue)})
                {uninvoiced.oldCount === 1 ? ' has' : ' have'} waited more than{' '}
                {uninvoiced.oldAfterDays} days.
              </p>
            )}
          </div>
          <ChevronRight
            size={18}
            strokeWidth={2}
            aria-hidden
            className="shrink-0 text-muted-2"
          />
        </Link>
      )}

      <figure className={STAT_CARD}>
        <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="section-label">
            {pricesHidden ? 'Jobs completed over time' : 'Revenue over time'}
          </span>
          <span className="flex items-center gap-3 text-caption text-muted">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="h-0.5 w-3.5 rounded-full bg-blue" />
              This range
            </span>
            {report.comparison && (
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="w-3.5 border-t-2 border-dashed border-muted-2"
                />
                Before
              </span>
            )}
          </span>
        </figcaption>
        <div className="h-56 md:h-72">
          {nothingDone ? (
            <p className="flex h-full items-center justify-center text-center text-body text-muted">
              No finished jobs in these dates.
            </p>
          ) : (
            <Suspense fallback={<Bone className="h-full w-full rounded-xl" />}>
              <LazyTrendChart
                points={points}
                grain={report.grain}
                kind={kind}
                today={today}
              />
            </Suspense>
          )}
        </div>
      </figure>

      <dl className={`${STAT_CARD} grid grid-cols-3 gap-3 text-center`}>
        {(
          [
            ['Booked', totals.booked],
            ['Completed', totals.completed],
            ['Cancelled', totals.cancelled],
          ] as const
        ).map(([name, count]) => (
          <div key={name} className="flex flex-col-reverse">
            <dt className="text-caption text-muted">{name}</dt>
            <dd className="text-row-title text-ink tabular-nums">{count}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/** The overview loading: the same boxes, with nothing to read in them. */
function OverviewPending() {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <StatTilePending key={i} />
        ))}
      </div>
      <div className={STAT_CARD}>
        <Bone className="mb-2 h-3 w-24" />
        <Bone className="h-9 w-32" />
        <Bone className="mt-2 h-4 w-48" />
      </div>
      <div className={STAT_CARD}>
        <Bone className="mb-2 h-3 w-28" />
        <Bone className="h-56 w-full rounded-xl md:h-72" />
      </div>
    </>
  )
}
