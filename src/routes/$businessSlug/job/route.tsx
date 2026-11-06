import {
  Outlet,
  createFileRoute,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '#/components/shell/PageHeader'
import { Segmented } from '#/components/primitives/Segmented'
import { RecurringFilterButton } from '#/components/schedule/RecurringView'
import { useViewMode } from '#/lib/access'
import { JOB_VIEWS, activeJobView, recurringJobFiltersOf } from '#/lib/jobViews'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../../convex/_generated/dataModel'

export const Route = createFileRoute('/$businessSlug/job')({
  component: JobSection,
})

/**
 * The Job section: one header and one view switcher over however many views
 * the section grows. Both views are routes rather than local state, so a view
 * survives a refresh and can be linked to (§5.1) — and so the Recurring one
 * can fill out on its own without this file changing.
 *
 * A view's filters are one icon at the end of the switch's row, as on the
 * Schedule: the switch is first in the row and keeps its place whether a
 * view has an icon or not, so changing view moves nothing.
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

      {/* The row is the icon's height with or without it (the padding is
          outside it, so `min-h-9` is the row's own), so changing view
          moves nothing under it. */}
      <div className="px-4 pt-3">
        <div className="flex min-h-9 items-center justify-between gap-3">
          {/* As wide as its words, on one line: a segment's share of a
              row that shrinks to fit it is a word wide, and "Recurring
              Job" broke in two. */}
          <div className="shrink-0 whitespace-nowrap">
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
                  navigate({
                    to: view.to,
                    params: { businessSlug: business.slug },
                  })
              }}
            />
          </div>
          {active === 'recurring' && (
            <RecurringJobFilters business={business} />
          )}
        </div>
      </div>

      <Outlet />
    </>
  )
}

/**
 * The Recurring Job view's sort and person, from its address: drawn here,
 * in the switch's row, where the view's own route can't reach.
 */
function RecurringJobFilters({
  business,
}: {
  business: { _id: Id<'businesses'>; timezone: string }
}) {
  // Drawn only while that view is open, so its address is the one written.
  const navigate = useNavigate({ from: '/$businessSlug/job/recurring' })
  const hydrated = useHydrated()
  const mode = useViewMode()
  const search = useRouterState({ select: (s) => s.location.search })
  const { staffId, sort } = recurringJobFiltersOf(search)
  const byDate = search.view === 'date'
  // Warmed with the view by its loader (`warmRecurring`); never suspended
  // on here, where it would hold the switch.
  const { data: members = [] } = useQuery(rq.roster(business._id))

  const write = (next: { staff?: string; sort?: 'next' | 'client' }) =>
    navigate({
      search: (prev) => ({ ...prev, ...next }),
      replace: true,
      resetScroll: false,
    })

  return (
    <RecurringFilterButton
      business={business}
      members={members}
      staffId={staffId}
      onStaffChange={(id) => write({ staff: id === 'all' ? undefined : id })}
      onClear={() => write({ staff: undefined })}
      sort={sort}
      onSortChange={(next) =>
        write({ sort: next === 'toBook' ? undefined : next })
      }
      byDate={byDate}
      hideStaff={mode === 'mine'}
      disabled={!hydrated}
    />
  )
}
