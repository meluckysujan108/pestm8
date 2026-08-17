import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'

export const Route = createFileRoute('/$businessSlug/dashboard')({
  component: DashboardPage,
})

function DashboardPage() {
  const { business, membership } = Route.useRouteContext()

  return (
    <>
      <PageHeader kicker="Today" title="Dashboard" />
      <div className="px-4 pb-6">
        <div className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation">
          <p className="section-label mb-1">Signed in to</p>
          <p className="text-row-title text-ink">{business.name}</p>
          <p className="text-secondary capitalize text-muted">
            {membership.role}
          </p>
        </div>
      </div>
    </>
  )
}
