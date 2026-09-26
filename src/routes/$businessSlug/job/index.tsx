import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import {
  EMPTY_ACTION_CLASS,
  EmptyState,
  NoMatches,
} from '#/components/primitives/EmptyState'
import { FilterDropdown } from '#/components/primitives/FilterDropdown'
import { JOB_LIST_STATUS_OPTIONS } from '#/lib/scheduleFilters'
import { useCan } from '#/lib/access'
import { rq, warm } from '#/lib/routeQueries'
import { useOverdueRecurring } from '#/lib/useOverdueRecurring'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import { useJobsWeather } from '#/lib/weather'
import { WeatherCredit } from '#/components/schedule/WeatherCredit'

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
  // The nav badge on this tab counts overdue recurring visits, which are not
  // in this list — it holds booked work, and projections are read in the
  // Recurring Job view. So the tab says where they are.
  const overdue = useOverdueRecurring(business._id)
  // The forecast for each job on its own day, where there is one (the next
  // two weeks); further out a card simply has none. Asked for the whole list,
  // not the filtered one, so changing the filter asks nothing again.
  const weather = useJobsWeather(business, data.jobs)

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

        {overdue > 0 && (
          <Link
            to="/$businessSlug/job/recurring"
            params={{ businessSlug: business.slug }}
            className="mb-3 flex min-h-11 items-center gap-2 rounded-xl border border-hairline bg-surface px-3 text-caption text-ink shadow-elevation transition active:scale-[.99]"
          >
            <span
              className={`rounded-full px-2 text-[12px] font-semibold leading-5 ${OVERDUE_CHIP}`}
            >
              {overdue} overdue
            </span>
            recurring {overdue === 1 ? 'visit' : 'visits'} to book
            <span className="ml-auto font-semibold text-blue">
              Recurring Job ›
            </span>
          </Link>
        )}

        {data.jobs.length === 0 ? (
          <EmptyState
            title="No jobs yet"
            body="Jobs you book appear here, newest first."
            action={
              // Jobs are booked on the schedule; this opens New Job there.
              <Link
                to="/$businessSlug/schedule"
                params={{ businessSlug: business.slug }}
                search={{ newJob: true }}
                className={EMPTY_ACTION_CLASS}
              >
                Book a job
              </Link>
            }
          />
        ) : shown.length === 0 ? (
          <NoMatches
            hint="No jobs match this status."
            clearLabel="Show all statuses"
            onClear={() =>
              navigate({
                search: (prev) => ({ ...prev, status: undefined }),
                replace: true,
              })
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch xl:grid-cols-3">
            {shown.map((job) => (
              <JobCard
                key={job._id}
                job={job}
                weather={weather.cellFor(job)}
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
        {weather.showsAny(shown) && <WeatherCredit className="mt-4" />}
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
