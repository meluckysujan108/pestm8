import { Suspense, useEffect, useState } from 'react'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Repeat } from 'lucide-react'
import { JobCard } from './JobCard'
import { RecurringServices } from './RecurringServices'
import { WeatherCredit } from './WeatherCredit'
import { EmptyState, LoadFailed } from '#/components/primitives/EmptyState'
import { Segmented } from '#/components/primitives/Segmented'
import { ListPending } from '#/components/shell/Pending'
import { useAccess } from '#/lib/access'
import { logConnection } from '#/lib/connectionLog'
import { todayKey } from '#/lib/format'
import { isSignInRefusal, listsEverythingOf } from '#/lib/jobListView'
import { useReadable, useReadableAll } from '#/lib/offline/useKept'
import { rq, warm } from '#/lib/routeQueries'
import { useBusinessDay } from '#/lib/useBusinessDay'
import { useHydrated } from '#/lib/useHydrated'
import { useJobsWeather } from '#/lib/weather'
import { startOfDayInZone } from '../../../convex/lib/dates'
import type { ReactNode } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { Id } from '../../../convex/_generated/dataModel'

type RecurringBusiness = {
  _id: Id<'businesses'>
  slug: string
  state: string
  timezone: string
}

/**
 * What the Recurring view reads first, asked for together by the loader of
 * the page that shows it (Job → Recurring Job, the Schedule's Recurring):
 * the bar's two numbers, the services and the roster; the visits themselves
 * only for "By date", the one way of reading it that draws them.
 */
export async function warmRecurring(
  queryClient: QueryClient,
  business: { _id: Id<'businesses'>; timezone: string },
  byDate: boolean,
): Promise<void> {
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
  return warm(
    queryClient,
    rq.roster(business._id),
    rq.recurringServices(business._id, startOfToday),
    ...(olderBackend ? [] : [rq.recurringSummary(business._id, startOfToday)]),
    ...(byDate || olderBackend ? [rq.recurringJobs(business._id)] : []),
  )
}

/**
 * The Recurring view: the standing arrangements a business has, and the
 * visits the engine has projected from them. One component for the two
 * places it is read, the Job section's Recurring Job and the Schedule's
 * Recurring, so the two can never disagree.
 *
 * Two numbers, and which is which matters. The bar counts SERIES — the
 * arrangements themselves — because that is what "how many recurring jobs do
 * I have" means. The cards below are projected visits, and there is no fixed
 * relationship between the two: the engine only materialises visits inside its
 * horizon, so a fortnightly contract shows thirteen cards and a job set to
 * repeat every 15 years shows none at all while still being one very real
 * Recurring Job. Counting cards would have made that last case read as zero.
 *
 * "By service", the way it opens, never reads the visits: the bar's numbers
 * are counted on the server (`jobs.recurringSummary`), and only "By date" —
 * which draws a card for each — asks for every visit, dressed for its card,
 * in the next six months.
 *
 * None of it is kept on the phone. With the line down and none of it in
 * memory, it says so (`notKeptAction` offers the way to what is kept)
 * rather than waiting for good.
 */
export function RecurringView({
  business,
  byDate,
  onByDateChange,
  onOpenJob,
  notKeptAction,
}: {
  business: RecurringBusiness
  /** "By date" rather than "By service": owned by the page, in its URL. */
  byDate: boolean
  onByDateChange: (byDate: boolean) => void
  onOpenJob: (jobId: string) => void
  /** Under "Not on this phone": the way to something the phone keeps. */
  notKeptAction?: ReactNode
}) {
  const day = useBusinessDay(business.timezone)
  const hydrated = useHydrated()
  const olderBackend = listsEverythingOf(useAccess()) === undefined

  // The window the services are read over is fixed where the view opened:
  // a new day would otherwise be a new query, and the view would blank to
  // its placeholder at midnight (for good, with no signal). What is due, to
  // book or next is still worked out against today, `day`, on every render.
  const [readFrom] = useState(() => day.startOfToday)
  const readable = useReadableAll([
    rq.recurringServices(business._id, readFrom).queryKey,
    olderBackend
      ? rq.recurringJobs(business._id).queryKey
      : rq.recurringSummary(business._id, readFrom).queryKey,
  ])

  if (!readable) return <NotKeptRecurring action={notKeptAction} />

  // A boundary of its own, under a check that is always listening: should
  // the line go while it waits (a page opened on it with no signal, before
  // the phone has said so), "Not on this phone" takes its place, where the
  // page's placeholder would wait for good. On the Schedule it also lets the
  // view switch at once, its placeholder under the heading just chosen.
  return (
    <Suspense
      fallback={
        <ListPending label="Loading Recurring Jobs" count={3} columns={3} />
      }
    >
      {olderBackend ? (
        <BarFromVisits businessId={business._id} />
      ) : (
        <BarFromSummary businessId={business._id} startOfToday={readFrom} />
      )}

      <div className="mb-3">
        <Segmented
          label="Show"
          value={byDate ? 'date' : 'service'}
          disabled={!hydrated}
          onChange={(next) => onByDateChange(next === 'date')}
          options={[
            { value: 'service', label: 'By service' },
            { value: 'date', label: 'By date' },
          ]}
        />
      </div>

      {byDate ? (
        <VisitsByDate
          business={business}
          onOpenJob={onOpenJob}
          notKeptAction={notKeptAction}
        />
      ) : (
        <ByService
          business={business}
          day={day}
          readFrom={readFrom}
          onOpenJob={onOpenJob}
        />
      )}
    </Suspense>
  )
}

/**
 * Asked for with the line down and none of it in memory: in the view's
 * place, as a day the phone keeps no copy of is (`NotKeptDay`). It goes by
 * itself once the signal is back and the view can load.
 */
function NotKeptRecurring({ action }: { action?: ReactNode }) {
  useEffect(() => {
    logConnection('kept-not-here', { what: 'recurring' })
  }, [])
  return (
    <EmptyState
      title="Not on this phone"
      body="This phone keeps this week and next. Recurring Jobs show when you have signal."
      action={action}
    />
  )
}

/** "By service": a card per running service, each opening to its visits. */
function ByService({
  business,
  day,
  readFrom,
  onOpenJob,
}: {
  business: RecurringBusiness
  day: ReturnType<typeof useBusinessDay>
  readFrom: number
  onOpenJob: (jobId: string) => void
}) {
  const { data: services } = useSuspenseQuery(
    rq.recurringServices(business._id, readFrom),
  )
  const { data: roster } = useQuery(rq.roster(business._id))

  if (services.services.length === 0 && services.loose.length === 0) {
    return (
      <EmptyState
        title="No Recurring Jobs yet"
        body="Open a job and choose “Make recurring” to repeat it on any interval."
      />
    )
  }
  return (
    <RecurringServices
      data={services}
      day={day}
      roster={roster}
      businessSlug={business.slug}
      onOpenJob={onOpenJob}
    />
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
  // (`readFrom`), so this never suspends once the view is up.
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
 * stay put, rather than the page's.
 */
function VisitsByDate({
  business,
  onOpenJob,
  notKeptAction,
}: {
  business: RecurringBusiness
  onOpenJob: (id: string) => void
  notKeptAction?: ReactNode
}) {
  const visits = useQuery(rq.recurringJobs(business._id))
  const readable = useReadable(rq.recurringJobs(business._id).queryKey)
  const jobs = visits.data?.jobs ?? []
  // Each visit's forecast on its own day, for those in the next two weeks.
  const weather = useJobsWeather(business, jobs)

  if (visits.data === undefined) {
    if (!readable) return <NotKeptRecurring action={notKeptAction} />
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
