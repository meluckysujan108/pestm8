import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Repeat } from 'lucide-react'
import { z } from 'zod'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { EmptyState, LoadFailed } from '#/components/primitives/EmptyState'
import { ListPending } from '#/components/shell/Pending'
import { useAccess, useCan } from '#/lib/access'
import { rq, searchParam, warm } from '#/lib/routeQueries'
import { isSignInRefusal, listsEverythingOf } from '#/lib/jobListView'
import { useJobsWeather } from '#/lib/weather'
import { WeatherCredit } from '#/components/schedule/WeatherCredit'
import { RecurringServices } from '#/components/schedule/RecurringServices'
import { Segmented } from '#/components/primitives/Segmented'
import { useBusinessDay } from '#/lib/useBusinessDay'
import { useHydrated } from '#/lib/useHydrated'
import { todayKey } from '#/lib/format'
import { startOfDayInZone } from '../../../../convex/lib/dates'
import type { Id } from '../../../../convex/_generated/dataModel'

export const Route = createFileRoute('/$businessSlug/job/recurring')({
  validateSearch: z.object({
    jobId: z.string().optional(),
    // By service unless asked otherwise, so the page's own address stays
    // the plain one.
    view: z.enum(['date']).optional().catch(undefined),
  }),
  // The bar's two numbers, the services and the roster together; the
  // visits themselves only for "By date", the one view that draws them.
  // No `loaderDeps` on the view: a new match would put the route's
  // placeholder over the very switch that asked for it.
  loader: async ({ context: { queryClient, business }, location }) => {
    const startOfToday = startOfDayInZone(
      todayKey(business.timezone),
      business.timezone,
    )
    const access = await queryClient
      .ensureQueryData(rq.access(business._id))
      .catch(() => undefined)
    // A backend from before `jobs.recurringSummary` also lacks this field,
    // and counts the bar from the visits, as it always did.
    const olderBackend = listsEverythingOf(access) === undefined
    const byDate = searchParam(location, 'view') === 'date'
    return warm(
      queryClient,
      rq.roster(business._id),
      rq.recurringServices(business._id, startOfToday),
      ...(olderBackend
        ? []
        : [rq.recurringSummary(business._id, startOfToday)]),
      ...(byDate || olderBackend ? [rq.recurringJobs(business._id)] : []),
    )
  },
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
 *
 * "By service", the view it opens on, never reads the visits: the bar's
 * numbers are counted on the server (`jobs.recurringSummary`), and only "By
 * date" — which draws a card for each — asks for every visit, dressed for
 * its card, in the next six months.
 */
function RecurringJobPage() {
  const { business } = Route.useRouteContext()
  const canDispatch = useCan('jobs.dispatch')
  const canManageClients = useCan('clients.manage')
  const { jobId, view } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const hydrated = useHydrated()
  const day = useBusinessDay(business.timezone)
  const olderBackend = listsEverythingOf(useAccess()) === undefined

  // The window the services are read over is fixed where the page opened:
  // a new day would otherwise be a new query, and the page would blank to
  // its placeholder at midnight (for good, with no signal). What is due, to
  // book or next is still worked out against today, `day`, on every render.
  const [readFrom] = useState(() => day.startOfToday)
  const { data: services } = useSuspenseQuery(
    rq.recurringServices(business._id, readFrom),
  )
  const { data: roster } = useQuery(rq.roster(business._id))
  // Opening a visit and closing it change the address in place, which the
  // router would otherwise take as a reason to scroll back to the top of a
  // long list.
  const openJob = (id: string) =>
    navigate({
      search: (prev) => ({ ...prev, jobId: id }),
      replace: true,
      resetScroll: false,
    })

  return (
    <>
      <section className="px-4 pt-3 pb-6">
        {olderBackend ? (
          <BarFromVisits businessId={business._id} />
        ) : (
          <BarFromSummary businessId={business._id} startOfToday={readFrom} />
        )}

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
        ) : (
          <VisitsByDate business={business} onOpenJob={openJob} />
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
            resetScroll: false,
          })
        }
      />
    </>
  )
}

/** The bar, counted on the server without dressing a single visit. */
function BarFromSummary({
  businessId,
  startOfToday,
}: {
  businessId: Id<'businesses'>
  startOfToday: number
}) {
  // Warmed by the loader with the same day, and the same all day after
  // (`readFrom`), so this never suspends once the page is up.
  const { data } = useSuspenseQuery(
    rq.recurringSummary(businessId, startOfToday),
  )
  return (
    <RecurringBar
      seriesCount={data.seriesCount}
      visitCount={data.visitCount}
      horizonDays={data.horizonDays}
    />
  )
}

/** The bar for a backend from before `jobs.recurringSummary`: counted off
 *  the visits, as it always was. */
function BarFromVisits({ businessId }: { businessId: Id<'businesses'> }) {
  const { data } = useSuspenseQuery(rq.recurringJobs(businessId))
  return (
    <RecurringBar
      seriesCount={data.seriesCount}
      visitCount={data.jobs.length}
      horizonDays={data.horizonDays}
    />
  )
}

function RecurringBar({
  seriesCount,
  visitCount,
  horizonDays,
}: {
  seriesCount: number
  visitCount: number
  horizonDays: number
}) {
  const months = Math.round(horizonDays / 30)
  return (
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
        {visitCount} {visitCount === 1 ? 'visit' : 'visits'} booked in the next{' '}
        {months} months
      </span>
    </div>
  )
}

/**
 * "By date": every projected visit as its card. Read without suspense, so
 * switching to it shows its own placeholder under a bar and a switch that
 * stay put, rather than the route's.
 */
function VisitsByDate({
  business,
  onOpenJob,
}: {
  business: {
    _id: Id<'businesses'>
    state: string
    timezone: string
  }
  onOpenJob: (id: string) => void
}) {
  const visits = useQuery(rq.recurringJobs(business._id))
  const jobs = visits.data?.jobs ?? []
  // Each visit's forecast on its own day, for those in the next two weeks.
  const weather = useJobsWeather(business, jobs)

  if (visits.data === undefined) {
    if (!visits.isError) {
      return (
        <ListPending label="Loading visits" count={3} columns={3} size="job" />
      )
    }
    // Refused for want of a sign-in: the route's error component waits for
    // it to settle, or asks for two-step sign-in (`isSignInRefusal`).
    if (isSignInRefusal(visits.error)) throw visits.error
    return (
      <LoadFailed what="the visits" onRetry={() => void visits.refetch()} />
    )
  }

  const { seriesCount, horizonDays } = visits.data
  const months = Math.round(horizonDays / 30)

  if (jobs.length === 0) {
    return (
      <EmptyState
        title={
          seriesCount === 0 ? 'No Recurring Jobs yet' : 'Nothing projected yet'
        }
        body={
          seriesCount === 0
            ? 'Open a job and choose “Make recurring” to repeat it on any interval.'
            : `Every visit of your ${seriesCount === 1 ? 'Recurring Job' : 'Recurring Jobs'} falls beyond the next ${months} months. They will appear here as their dates come within it.`
        }
      />
    )
  }

  return (
    <>
      <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch xl:grid-cols-3">
        {jobs.map((job) => (
          <JobCard
            key={job._id}
            job={job}
            weather={weather.cellFor(job)}
            timezone={business.timezone}
            hideActions
            onOpen={onOpenJob}
          />
        ))}
      </div>
      {weather.showsAny(jobs) && <WeatherCredit className="mt-4" />}
    </>
  )
}
