import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import {
  RecurringView,
  warmRecurring,
} from '#/components/schedule/RecurringView'
import { useCan } from '#/lib/access'
import { searchParam } from '#/lib/routeQueries'
import { RECURRING_JOB_SORTS } from '#/lib/jobViews'

export const Route = createFileRoute('/$businessSlug/job/recurring')({
  validateSearch: z.object({
    jobId: z.string().optional(),
    // By service unless asked otherwise, so the page's own address stays
    // the plain one.
    view: z.enum(['date']).optional().catch(undefined),
    // Whose Recurring Jobs, and their order: chosen behind the filter icon
    // in the section's switch row (`JobSection`), kept here like the view.
    // Absent is everyone's, with what is to book first.
    staff: z.string().optional(),
    sort: z.enum(RECURRING_JOB_SORTS).optional().catch(undefined),
  }),
  // No `loaderDeps` on the view: a new match would put the route's
  // placeholder over the very switch that asked for it.
  loader: ({ context: { queryClient, business }, location }) =>
    warmRecurring(
      queryClient,
      business,
      searchParam(location, 'view') === 'date',
    ),
  component: RecurringJobPage,
})

/**
 * The Recurring Job view of the Job section: the Recurring view
 * (`RecurringView`, which the Schedule's Recurring shows too), and a visit
 * opened from it over the page.
 */
function RecurringJobPage() {
  const { business } = Route.useRouteContext()
  const canDispatch = useCan('jobs.dispatch')
  const canManageClients = useCan('clients.manage')
  const { jobId, view, staff, sort } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  return (
    <>
      <section className="px-4 pt-3 pb-6">
        <RecurringView
          business={business}
          byDate={view === 'date'}
          staffId={staff ?? 'all'}
          sort={sort ?? 'toBook'}
          onClearFilters={() =>
            navigate({
              search: (prev) => ({ ...prev, staff: undefined }),
              replace: true,
              resetScroll: false,
            })
          }
          onByDateChange={(byDate) =>
            navigate({
              search: (prev) => ({
                ...prev,
                view: byDate ? 'date' : undefined,
              }),
              replace: true,
            })
          }
          // Opening a visit and closing it change the address in place,
          // which the router would otherwise take as a reason to scroll back
          // to the top of a long list.
          onOpenJob={(id) =>
            navigate({
              search: (prev) => ({ ...prev, jobId: id }),
              replace: true,
              resetScroll: false,
            })
          }
        />
      </section>

      <JobDetailSheet
        businessId={business._id}
        businessSlug={business.slug}
        timezone={business.timezone}
        jobId={jobId ?? null}
        canReassign={canDispatch}
        canDelete={canManageClients}
        onClose={() =>
          navigate({
            search: (prev) => ({ ...prev, jobId: undefined }),
            replace: true,
            resetScroll: false,
          })
        }
      />
    </>
  )
}
