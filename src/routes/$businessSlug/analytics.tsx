import { Suspense, lazy } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { formatMoney } from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'

// A separate lazy chunk so `recharts` (~150KB gzipped) never loads on
// Schedule or any other route — only whoever actually opens Analytics pays
// for it. Mirrors `ReportActionBar.tsx`'s exact `LazyPdfViewer` pattern.
const LazyAnalyticsCharts = lazy(() =>
  import('#/components/analytics/AnalyticsCharts').then((m) => ({
    default: m.AnalyticsCharts,
  })),
)

export const Route = createFileRoute('/$businessSlug/analytics')({
  component: AnalyticsPage,
})

function AnalyticsPage() {
  const { business } = Route.useRouteContext()
  const hydrated = useHydrated()
  const { data: summary } = useSuspenseQuery(
    convexQuery(api.dashboard.summary, { businessId: business._id }),
  )

  if (!summary) return null

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={business.name}
        title="Analytics"
      />

      <div className="flex flex-col gap-3 px-4 pt-4 pb-6 md:grid md:grid-cols-3 md:items-start">
        <Card className="md:col-span-3">
          <p className="section-label mb-1">Awaiting invoice</p>
          <p className="text-metric-lg text-ink">
            {formatMoney(summary.awaitingInvoiceValue)}
          </p>
          <p className="mt-1 text-body text-muted">
            {summary.awaitingInvoice}{' '}
            {summary.awaitingInvoice === 1 ? 'job' : 'jobs'} completed and not
            yet billed
          </p>
        </Card>

        <Card>
          <p className="section-label mb-1">Today</p>
          <p className="text-metric text-ink">{summary.todayCount}</p>
          <Link
            to="/$businessSlug/schedule"
            params={{ businessSlug: business.slug }}
            className="mt-1 inline-block text-body text-blue"
          >
            Open schedule
          </Link>
        </Card>

        <Card>
          <p className="section-label mb-1">Upcoming</p>
          <p className="text-metric text-ink">{summary.upcomingCount}</p>
          <p className="mt-1 text-body text-muted">still booked</p>
        </Card>

        <Card>
          <p className="section-label mb-1">Invoiced this month</p>
          <p className="text-metric-sm text-ink">
            {formatMoney(summary.invoicedThisMonth)}
          </p>
        </Card>

        {/* Being explicit beats a subcontractor wondering why the owner's
            numbers differ from theirs. */}
        {summary.scope === 'assignee' && (
          <p className="text-caption text-muted md:col-span-3">
            These figures cover your own jobs.
          </p>
        )}
      </div>

      {hydrated ? (
        <Suspense fallback={<ChartsSkeleton />}>
          <LazyAnalyticsCharts businessId={business._id} />
        </Suspense>
      ) : (
        <ChartsSkeleton />
      )}
    </>
  )
}

function ChartsSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 pb-8 md:grid md:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex h-64 items-center justify-center rounded-2xl border border-hairline bg-surface-3 md:h-72"
        >
          <p className="text-caption text-muted">Preparing charts…</p>
        </div>
      ))}
    </div>
  )
}

function Card({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={`rounded-2xl border border-hairline bg-surface p-4 shadow-elevation ${className}`}
    >
      {children}
    </div>
  )
}
