import {
  Outlet,
  createFileRoute,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { Segmented } from '#/components/primitives/Segmented'
import { JOB_VIEWS, activeJobView } from '#/lib/jobViews'

export const Route = createFileRoute('/$businessSlug/job')({
  component: JobSection,
})

/**
 * The Job section: one header and one view switcher over however many views
 * the section grows. Both views are routes rather than local state, so a view
 * survives a refresh and can be linked to (§5.1) — and so the Recurring one
 * can fill out on its own without this file changing.
 */
function JobSection() {
  const { business } = Route.useRouteContext()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  const active = activeJobView(pathname)

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={business.name}
        title="Jobs"
      />

      <div className="px-4 pt-3">
        <Segmented
          label="View"
          value={active}
          options={JOB_VIEWS.map((view) => ({
            value: view.value,
            label: view.label,
          }))}
          onChange={(value) => {
            const view = JOB_VIEWS.find((v) => v.value === value)
            if (view)
              navigate({ to: view.to, params: { businessSlug: business.slug } })
          }}
        />
      </div>

      <Outlet />
    </>
  )
}
