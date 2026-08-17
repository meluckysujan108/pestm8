import { createFileRoute, Link } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { FollowUpTasks } from '#/components/dashboard/FollowUpTasks'
import { formatMoney } from '#/lib/format'

export const Route = createFileRoute('/$businessSlug/dashboard')({
  component: DashboardPage,
})

function DashboardPage() {
  const { business, membership } = Route.useRouteContext()
  const { data: summary } = useSuspenseQuery(
    convexQuery(api.dashboard.summary, { businessId: business._id }),
  )

  if (!summary) return null

  return (
    <>
      <PageHeader kicker={business.name} title="Dashboard" />

      <div className="flex flex-col gap-3 px-4 pt-4 pb-6 md:grid md:grid-cols-3 md:items-start">
        {/* Above the metrics on purpose: an outstanding durable notice is a
            compliance gap, which outranks a revenue figure. */}
        <FollowUpTasks businessId={business._id} />

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

        {membership.role === 'owner' && (
          <p className="text-caption text-muted md:col-span-3">
            PestM8 does not track contractor hours or rosters — by design.
          </p>
        )}
      </div>
    </>
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
