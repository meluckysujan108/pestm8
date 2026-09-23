import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Repeat } from 'lucide-react'
import { z } from 'zod'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { EmptyState } from '#/components/primitives/EmptyState'
import { useCan } from '#/lib/access'
import { rq, warm } from '#/lib/routeQueries'

export const Route = createFileRoute('/$businessSlug/job/recurring')({
  validateSearch: z.object({
    jobId: z.string().optional(),
  }),
  loader: ({ context: { queryClient, business } }) =>
    warm(queryClient, rq.recurringJobs(business._id)),
  component: RecurringJobPage,
})

/**
 * The Recurring Job view: the standing arrangements a business has, and the
 * visits the engine has projected from them.
 *
 * Two numbers, and which is which matters. The bar counts SERIES — the
 * arrangements themselves — because that is what "how many recurring jobs do
 * I have" means. The cards below are projected visits, and there is no fixed
 * relationship between the two: the engine only materialises visits inside its
 * horizon, so a fortnightly contract shows thirteen cards and a job set to
 * repeat every 15 years shows none at all while still being one very real
 * Recurring Job. Counting cards would have made that last case read as zero.
 */
function RecurringJobPage() {
  const { business } = Route.useRouteContext()
  const canDispatch = useCan('jobs.dispatch')
  const { jobId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const { data } = useSuspenseQuery(rq.recurringJobs(business._id))

  const { jobs, seriesCount, horizonDays } = data
  const months = Math.round(horizonDays / 30)

  return (
    <>
      <section className="px-4 pt-3 pb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-4 py-3 shadow-elevation">
          <span className="flex items-center gap-2">
            <Repeat size={18} strokeWidth={1.7} className="text-blue" />
            <span className="text-row-title tabular-nums text-ink">
              {seriesCount}{' '}
              {/* Says "Recurring Job", not "recurring jobs in the next six
                  months" — the count is of arrangements, and the line below
                  is what explains the cards. */}
              {seriesCount === 1 ? 'Recurring Job' : 'Recurring Jobs'}
            </span>
          </span>
          <span className="text-caption tabular-nums text-muted">
            {jobs.length} {jobs.length === 1 ? 'visit' : 'visits'} booked in the
            next {months} months
          </span>
        </div>

        {jobs.length === 0 ? (
          <EmptyState
            title={
              seriesCount === 0
                ? 'No Recurring Jobs yet'
                : 'Nothing projected yet'
            }
            body={
              seriesCount === 0
                ? 'Open a job and choose "Make recurring" to repeat it on any interval.'
                : `Every visit of your ${seriesCount === 1 ? 'Recurring Job' : 'Recurring Jobs'} falls beyond the next ${months} months. They will appear here as their dates come within it.`
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch xl:grid-cols-3">
            {jobs.map((job) => (
              <JobCard
                key={job._id}
                job={job}
                timezone={business.timezone}
                hideActions
                onOpen={(id) =>
                  navigate({
                    search: (prev) => ({ ...prev, jobId: id }),
                    replace: true,
                  })
                }
              />
            ))}
          </div>
        )}
      </section>

      <JobDetailSheet
        businessId={business._id}
        businessSlug={business.slug}
        timezone={business.timezone}
        jobId={jobId ?? null}
        canReassign={canDispatch}
        onClose={() =>
          navigate({
            search: (prev) => ({ ...prev, jobId: undefined }),
            replace: true,
          })
        }
      />
    </>
  )
}
