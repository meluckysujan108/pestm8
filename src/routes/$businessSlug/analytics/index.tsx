import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import {
  AnalyticsOverview,
  preloadTrendChart,
} from '#/components/analytics/AnalyticsOverview'
import {
  RANGE_PRESETS,
  analyticsArgs,
  analyticsSearchOf,
  resolveRange,
} from '#/lib/analyticsView'
import { todayKey } from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'
import { useViewMode } from '#/lib/access'
import { useSetView } from '#/lib/useSetView'
import {
  loaderWaitMs,
  rq,
  searchParam,
  settleInBrowser,
  warm,
} from '#/lib/routeQueries'
import type { AnalyticsSearch } from '#/lib/analyticsView'

export const Route = createFileRoute('/$businessSlug/analytics/')({
  // In the address like every other view and filter (design-system.md,
  // Filters and views): a range worth looking at is worth a refresh, and
  // worth sending to someone. Each is left out at its default.
  validateSearch: z.object({
    range: z.enum(RANGE_PRESETS).optional().catch(undefined),
    from: z.string().optional(),
    to: z.string().optional(),
    compare: z.enum(['year', 'none']).optional().catch(undefined),
    staff: z.string().optional(),
    service: z.string().optional(),
  }),
  // The figures for the range the address asks for, through the same
  // function the page reads them by. No `loaderDeps` on the search: each
  // pick in the sheet would be a new match, and a new match is the route's
  // placeholder with the sheet gone from under the thumb. In the browser it
  // waits only so long (`loaderWaitMs`): the page has its own placeholders.
  loader: ({ context: { queryClient, business }, location }) => {
    if (typeof window !== 'undefined') preloadTrendChart()
    const search = analyticsSearchOf((key) => searchParam(location, key))
    return settleInBrowser(
      loaderWaitMs(),
      warm(
        queryClient,
        rq.analyticsReport(
          analyticsArgs(business._id, search, todayKey(business.timezone)),
        ),
      ),
    )
  },
  component: AnalyticsPage,
})

function AnalyticsPage() {
  const { business } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const mode = useViewMode()
  const setView = useSetView(business._id)
  const hydrated = useHydrated()

  const today = todayKey(business.timezone)
  const range = resolveRange(search, today)
  // The last figures stay while the next range's load, so a choice in a
  // sheet never empties the page behind it.
  const report = useQuery({
    ...rq.analyticsReport(analyticsArgs(business._id, search, today)),
    placeholderData: keepPreviousData,
  })

  const onSearch = (next: Partial<AnalyticsSearch>) =>
    navigate({
      search: (prev) => ({ ...prev, ...next }),
      // A filter is not somewhere you have been: Back leaves Analytics.
      replace: true,
    })

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={business.name}
        title="Analytics"
      />

      <AnalyticsOverview
        businessSlug={business.slug}
        today={today}
        range={range}
        compare={search.compare ?? 'previous'}
        search={search}
        report={report.data ?? undefined}
        stale={report.isPlaceholderData}
        failed={report.isError}
        onRetry={() => void report.refetch()}
        ready={hydrated}
        onSearch={onSearch}
      >
        {/* Being explicit beats a subcontractor wondering why the owner's
            numbers differ from theirs. */}
        {report.data?.scope === 'assignee' && (
          <p className="text-caption text-muted">
            These figures cover your own jobs.
            {/* The owner narrowed these himself, so the way back is his to
                take — without hunting for the header menu. */}
            {mode === 'mine' && (
              <>
                {' '}
                <button
                  type="button"
                  disabled={!hydrated || setView.isPending}
                  onClick={() => setView.mutate({ kind: 'everyone' })}
                  className="font-semibold text-blue disabled:opacity-50"
                >
                  Show the whole business
                </button>
              </>
            )}
          </p>
        )}
      </AnalyticsOverview>
    </>
  )
}
