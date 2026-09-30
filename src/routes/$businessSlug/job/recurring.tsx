import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Repeat } from 'lucide-react'
import { z } from 'zod'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { EmptyState } from '#/components/primitives/EmptyState'
import { useCan } from '#/lib/access'
import { rq, warm } from '#/lib/routeQueries'
import { useJobsWeather } from '#/lib/weather'
import { WeatherCredit } from '#/components/schedule/WeatherCredit'
import { RecurringServices } from '#/components/schedule/RecurringServices'
import { Segmented } from '#/components/primitives/Segmented'
import { useBusinessDay } from '#/lib/useBusinessDay'
import { useHydrated } from '#/lib/useHydrated'
import { todayKey } from '#/lib/format'
import { startOfDayInZone } from '../../../../convex/lib/dates'

export const Route = createFileRoute('/$businessSlug/job/recurring')({
  validateSearch: z.object({
    jobId: z.string().optional(),
    // By service unless asked otherwise, so the page's own address stays
    // the plain one.
    view: z.enum(['date']).optional().catch(undefined),
  }),
  loader: ({ context: { queryClient, business } }) =>
    warm(
      queryClient,
      rq.recurringJobs(business._id),
      rq.roster(business._id),
      rq.recurringServices(
        business._id,
        startOfDayInZone(todayKey(business.timezone), business.timezone),
      ),
    ),
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
  const canManageClients = useCan('clients.manage')
  const { jobId, view } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const hydrated = useHydrated()
  const day = useBusinessDay(business.timezone)

  const { data } = useSuspenseQuery(rq.recurringJobs(business._id))
  // The window the services are read over is fixed where the page opened:
  // a new day would otherwise be a new query, and the page would blank to
  // its placeholder at midnight (for good, with no signal). What is due, to
  // book or next is still worked out against today, `day`, on every render.
  const [readFrom] = useState(() => day.startOfToday)
  const { data: services } = useSuspenseQuery(
    rq.recurringServices(business._id, readFrom),
  )
  const { data: roster } = useQuery(rq.roster(business._id))
  const openJob = (id: string) =>
    navigate({
      search: (prev) => ({ ...prev, jobId: id }),
      replace: true,
    })

  const { jobs, seriesCount, horizonDays } = data
  // Each visit's forecast on its own day, for those in the next two weeks.
  const weather = useJobsWeather(business, jobs)
  const months = Math.round(horizonDays / 30)

  return (
    <>
      <section className="px-4 pt-3 pb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-4 py-3 shadow-elevation">
          <span className="flex items-center gap-2">
            <Repeat size={18} strokeWidth={1.7} className="text-ink-2" />
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

        <div className="mb-3">
          <Segmented
            label="Show"
            value={view ?? 'service'}
            disabled={!hydrated}
            onChange={(next) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  view: next === 'date' ? 'date' : undefined,
                }),
                replace: true,
              })
            }
            options={[
              { value: 'service', label: 'By service' },
              { value: 'date', label: 'By date' },
            ]}
          />
        </div>

        {view !== 'date' ? (
          services.services.length === 0 && services.loose.length === 0 ? (
            <EmptyState
              title="No Recurring Jobs yet"
              body="Open a job and choose “Make recurring” to repeat it on any interval."
            />
          ) : (
            <RecurringServices
              data={services}
              day={day}
              roster={roster}
              businessSlug={business.slug}
              onOpenJob={openJob}
            />
          )
        ) : jobs.length === 0 ? (
          <EmptyState
            title={
              seriesCount === 0
                ? 'No Recurring Jobs yet'
                : 'Nothing projected yet'
            }
            body={
              seriesCount === 0
                ? 'Open a job and choose “Make recurring” to repeat it on any interval.'
                : `Every visit of your ${seriesCount === 1 ? 'Recurring Job' : 'Recurring Jobs'} falls beyond the next ${months} months. They will appear here as their dates come within it.`
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch xl:grid-cols-3">
            {jobs.map((job) => (
              <JobCard
                key={job._id}
                job={job}
                weather={weather.cellFor(job)}
                timezone={business.timezone}
                hideActions
                onOpen={openJob}
              />
            ))}
          </div>
        )}
        {view === 'date' && weather.showsAny(jobs) && (
          <WeatherCredit className="mt-4" />
        )}
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
          })
        }
      />
    </>
  )
}
