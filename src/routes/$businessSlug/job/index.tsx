import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { EmptyState } from '#/components/primitives/EmptyState'
import { FilterDropdown } from '#/components/primitives/FilterDropdown'
import { JOB_LIST_STATUS_OPTIONS } from '#/lib/scheduleFilters'
import { useCan } from '#/lib/access'
import { rq, warm } from '#/lib/routeQueries'

const STATUS_VALUES = JOB_LIST_STATUS_OPTIONS.map((option) => option.value)

export const Route = createFileRoute('/$businessSlug/job/')({
  validateSearch: z.object({
    // In the URL like every other filter in the app (§5.1): a filtered list is
    // worth keeping across a refresh and worth sending to someone.
    status: z
      .enum(STATUS_VALUES as [string, ...Array<string>])
      .optional()
      .catch(undefined),
    jobId: z.string().optional(),
  }),
  loader: ({ context: { queryClient, business } }) =>
    warm(queryClient, rq.jobs(business._id)),
  component: JobListPage,
})

function JobListPage() {
  const { business } = Route.useRouteContext()
  const canDispatch = useCan('jobs.dispatch')
  const { status, jobId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const { data } = useSuspenseQuery(rq.jobs(business._id))

  const shown = status
    ? data.jobs.filter((job) => job.status === status)
    : data.jobs

  return (
    <>
      <section className="px-4 pt-3 pb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption tabular-nums text-muted">
            {shown.length} {shown.length === 1 ? 'job' : 'jobs'}
            {/* Said out loud rather than quietly dropped: the list holds the
                newest `limit`, so a filter searches those and not the archive. */}
            {data.capped && ` · newest ${data.limit}`}
          </p>
          <FilterDropdown
            label="Filter by status"
            value={status ?? 'all'}
            active={status !== undefined}
            onChange={(value) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  status: value === 'all' ? undefined : value,
                }),
                replace: true,
              })
            }
            options={[
              { value: 'all', label: 'All statuses' },
              ...JOB_LIST_STATUS_OPTIONS,
            ]}
          />
        </div>

        {shown.length === 0 ? (
          <EmptyState
            title={data.jobs.length === 0 ? 'No jobs yet' : 'No matching jobs'}
            body={
              data.jobs.length === 0
                ? 'Jobs you book appear here, newest first.'
                : 'No jobs match this status.'
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch xl:grid-cols-3">
            {shown.map((job) => (
              <JobCard
                key={job._id}
                job={job}
                timezone={business.timezone}
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
