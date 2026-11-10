import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { z } from 'zod'
import { api } from '../../../../convex/_generated/api'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import {
  EMPTY_ACTION_CLASS,
  EmptyState,
  LoadFailed,
  NoMatches,
} from '#/components/primitives/EmptyState'
import { LoadMore } from '#/components/primitives/LoadMore'
import { CardCells, ListPending } from '#/components/shell/Pending'
import { parseJobListStatus } from '#/lib/scheduleFilters'
import { JOB_LIST_SORTS } from '#/lib/jobViews'
import type { JobListStatus } from '#/lib/routeQueries'
import { useAccess, useCan } from '#/lib/access'
import {
  JOBS_PAGE,
  jobsFirstPage,
  jobsPageArgs,
  loaderWaitMs,
  rq,
  searchParam,
  settleInBrowser,
  warm,
} from '#/lib/routeQueries'
import {
  isSignInRefusal,
  jobListSource,
  jobListView,
  jobsCaption,
  listsEverythingOf,
} from '#/lib/jobListView'
import { usePagedList } from '#/lib/usePagedList'
import { useRevealMore } from '#/lib/useRevealMore'
import { useOverdueRecurring } from '#/lib/useOverdueRecurring'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import { useJobsWeather } from '#/lib/weather'
import { WeatherCredit } from '#/components/schedule/WeatherCredit'
import { ChevronRight } from 'lucide-react'

export const Route = createFileRoute('/$businessSlug/job/')({
  validateSearch: z.object({
    // In the URL like every other filter in the app (§5.1): a filtered list is
    // worth keeping across a refresh and worth sending to someone. Read
    // through the same function as the loader below, which warms the list
    // for it — the two must agree to the byte.
    status: z
      .custom<JobListStatus>((raw) => parseJobListStatus(raw) !== undefined)
      .optional()
      .catch(undefined),
    // Whose jobs and in what order, chosen with the status behind the
    // filter icon in the section's switch row (`jobListFiltersOf`).
    staff: z.string().optional(),
    sort: z.enum(JOB_LIST_SORTS).optional().catch(undefined),
    jobId: z.string().optional(),
    // A booking on this phone, not sent yet: its `localId`, never in `jobId`
    // (`jobs.get` refuses it). Opened once the page has hydrated and the
    // phone's bookings have been read (`JobDetailSheet`).
    outboxId: z.string().optional(),
  }),
  // The list's first page and its count, for the list this person sees. No
  // `loaderDeps` on the status: that would make every pick in the filter a
  // new match, and a new match is the route's placeholder rather than the
  // list being filtered — with the filter itself gone from under the thumb.
  // In the browser it waits only so long (`loaderWaitMs`).
  loader: ({ context: { queryClient, business }, location }) => {
    const status = parseJobListStatus(searchParam(location, 'status'))
    const staff = searchParam(location, 'staff') || undefined
    const sort = JOB_LIST_SORTS.find((s) => s === searchParam(location, 'sort'))
    return settleInBrowser(
      loaderWaitMs(),
      (async () => {
        // Which list that is follows the view (`access.me`), which the
        // layout's `beforeLoad` has always asked for already: this reads it
        // back.
        const access = await queryClient
          .ensureQueryData(rq.access(business._id))
          .catch(() => undefined)
        const listsEverything = listsEverythingOf(access)
        const person = listsEverything === true ? staff : undefined
        const source = jobListSource(listsEverything, person !== undefined)
        await warm(
          queryClient,
          ...(source === 'paged'
            ? [
                jobsFirstPage(business._id, status, sort),
                rq.jobCounts(business._id, status),
              ]
            : source === 'bounded'
              ? [
                  rq.jobsList(business._id, status, {
                    staffId: person,
                    sort,
                  }),
                ]
              : [rq.jobsList(business._id)]),
        )
      })(),
    )
  },
  component: JobListPage,
})

/**
 * Every job somebody booked, newest booked first — or latest visit first,
 * or one person's (the filter icon in the section's switch row, route.tsx).
 *
 * Whoever sees the whole business reads it a page at a time — a business
 * that has been booking for years has thousands — with the status chosen on
 * the server, so "Completed" means every completed job and not the completed
 * ones among the newest few hundred. Whoever sees one person's or one team's
 * work reads it whole, as before, newest 200 (`JobListSource`). Either way
 * the cards arrive 24 at a time as the end of the list comes near.
 *
 * Nothing here suspends on the status. A key that changes with the filter,
 * read with suspense, would put the whole route back on its placeholder at
 * every pick, the filter included; the list's own placeholder stands in
 * instead, under a filter that stays put.
 */
function JobListPage() {
  const { business } = Route.useRouteContext()
  const canDispatch = useCan('jobs.dispatch')
  const canManageClients = useCan('clients.manage')
  const { status, staff, sort, jobId, outboxId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  // Follows the view live: "Just my jobs" turns the paged list into the
  // bounded one and back, in place. A person is chosen only from the whole
  // business's list — a narrower one is one person's or team's already, and
  // its filter offers no one — so a `staff` left in the address there is
  // not applied.
  const listsEverything = listsEverythingOf(useAccess())
  const person = listsEverything === true && staff ? staff : undefined
  const source = jobListSource(listsEverything, person !== undefined)
  const paging = source === 'paged'
  const filtered = status !== undefined || person !== undefined
  const resetKey = `${source}:${status ?? 'all'}:${person ?? 'all'}:${sort ?? 'booked'}`

  // The paginator is mounted only for the whole business. Skipped, rather
  // than left asking: the server answers a narrower caller with an empty,
  // finished page, and a paginator kept through such an answer and back
  // would join a fresh first page to a stale second one — jobs missing, or
  // twice.
  const paged = usePagedList({
    query: api.jobs.listPage,
    args: paging ? jobsPageArgs(business._id, status, sort) : 'skip',
    first: paging
      ? jobsFirstPage(business._id, status, sort)
      : convexQuery(api.jobs.listPage, 'skip'),
    pageSize: JOBS_PAGE,
  })
  // The same warmed first page, read here for one thing: whether the list
  // is empty. It is delivered with `access.me`, so the two never disagree
  // about whose list this is (`jobListView`).
  const { data: warmedFirst, isError: warmedFailed } = useQuery(
    paging
      ? jobsFirstPage(business._id, status, sort)
      : convexQuery(api.jobs.listPage, 'skip'),
  )
  const { data: counts } = useQuery(
    paging
      ? rq.jobCounts(business._id, status)
      : convexQuery(api.jobs.listCounts, 'skip'),
  )

  // One person's or one team's work, or an older backend's whole list. The
  // older one has no status, person or order to ask with, and is filtered
  // and ordered here as it always was.
  const listed = useQuery(
    source === 'bounded'
      ? rq.jobsList(business._id, status, { staffId: person, sort })
      : source === 'legacy'
        ? rq.jobsList(business._id)
        : convexQuery(api.jobs.list, 'skip'),
  )
  const listedJobs = listed.data?.jobs ?? []
  const whole =
    source === 'legacy' ? legacyList(listedJobs, { status, sort }) : listedJobs
  const revealed = useRevealMore(whole, JOBS_PAGE, resetKey)

  const rows = paging ? paged.rows : revealed.visible

  const view = jobListView(
    paging
      ? {
          filtered,
          rows: rows.length,
          loading: paged.loading,
          done: paged.done,
          failed: paged.error != null,
          confirmedEmpty:
            warmedFirst === undefined
              ? warmedFailed
              : warmedFirst.isDone && warmedFirst.page.length === 0,
        }
      : {
          filtered,
          rows: rows.length,
          loading: listed.data === undefined && !listed.isError,
          done: listed.data !== undefined,
          failed: listed.data === undefined && listed.isError,
          confirmedEmpty: true,
        },
  )

  const caption = paging
    ? counts
      ? jobsCaption(counts)
      : null
    : listed.data
      ? jobsCaption({
          count: whole.length,
          newest: listed.data.capped ? listed.data.limit : undefined,
        })
      : null

  // The nav badge on this tab counts overdue recurring visits, which are not
  // in this list — it holds booked work, and projections are read in the
  // Recurring Job view. So the tab says where they are.
  const overdue = useOverdueRecurring(business._id)
  // The forecast for each job on its own day, where there is one (the next
  // two weeks); further out a card simply has none. Asked for every job the
  // page holds: the pages loaded so far, or the whole bounded list (so
  // showing more of it asks nothing again). Each status is a list of its
  // own now, read from the server, so changing the filter asks once more —
  // only for days it has not asked about, and the forecasts it shares with
  // the last list stay on screen meanwhile (`useWeather`).
  const weather = useJobsWeather(business, paging ? paged.rows : listedJobs)

  // Opening a job and closing it change the address in place (`replace`),
  // and a replaced entry is a new history key — which the router would
  // otherwise scroll to the top, dropping you at the start of a list you had
  // scrolled a long way down. The filter keeps the reset: a new list starts
  // at its start.
  const openJob = (id: string) =>
    navigate({
      search: (prev) => ({ ...prev, jobId: id, outboxId: undefined }),
      replace: true,
      resetScroll: false,
    })

  // Refused for want of a sign-in, the bounded list goes to the route's
  // error component like any page that suspends (`isSignInRefusal`); the
  // paged one is thrown by `usePagedList` itself.
  if (
    listed.data === undefined &&
    listed.isError &&
    isSignInRefusal(listed.error)
  ) {
    throw listed.error
  }

  return (
    <>
      <section className="px-4 pt-3 pb-6">
        {/* The whole list's count, not the cards loaded so far — and for a
            list that holds only the newest, said out loud rather than
            quietly dropped (`jobsCaption`). Its own line, always there, so
            a filter changing it moves nothing under it. */}
        <p
          aria-live="polite"
          className="mb-3 min-h-5 text-caption tabular-nums text-muted"
        >
          {caption}
        </p>

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
            <span className="ml-auto inline-flex items-center gap-0.5 font-semibold text-blue">
              Recurring Job
              <ChevronRight size={15} strokeWidth={2.2} />
            </span>
          </Link>
        )}

        {view === 'pending' ? (
          <ListPending label="Loading jobs" count={3} columns={3} size="job" />
        ) : view === 'failed' ? (
          <LoadFailed
            what="the jobs"
            onRetry={paging ? paged.retry : () => void listed.refetch()}
          />
        ) : view === 'empty' ? (
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
        ) : view === 'noMatches' ? (
          <NoMatches
            hint="No jobs match these filters."
            clearLabel="Clear filters"
            onClear={() =>
              // The order stays: it hides nothing.
              navigate({
                search: (prev) => ({
                  ...prev,
                  status: undefined,
                  staff: undefined,
                }),
                replace: true,
              })
            }
          />
        ) : (
          <>
            <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch xl:grid-cols-3">
              {rows.map((job) => (
                <JobCard
                  key={job._id}
                  job={job}
                  weather={weather.cellFor(job)}
                  timezone={business.timezone}
                  onOpen={openJob}
                />
              ))}
              {/* The next page's cards, as cards in the same grid, so the
                  ones already there do not move when it lands. */}
              {paging && paged.loadingMore && (
                <CardCells count={3} size="job" />
              )}
            </div>
            <LoadMore
              canLoadMore={paging ? paged.canLoadMore : revealed.canLoadMore}
              loading={paging && paged.loadingMore}
              onLoadMore={paging ? paged.loadMore : revealed.loadMore}
              noun="jobs"
              shown={rows.length}
              resetKey={resetKey}
            />
          </>
        )}
        {weather.showsAny(rows) && <WeatherCredit className="mt-4" />}
      </section>

      <JobDetailSheet
        businessId={business._id}
        businessSlug={business.slug}
        timezone={business.timezone}
        jobId={jobId ?? null}
        outboxId={outboxId ?? null}
        canReassign={canDispatch}
        canDelete={canManageClients}
        onClose={() =>
          navigate({
            search: (prev) => ({
              ...prev,
              jobId: undefined,
              outboxId: undefined,
            }),
            replace: true,
            resetScroll: false,
          })
        }
        onSent={openJob}
      />
    </>
  )
}

/**
 * An older backend's whole list, filtered and ordered here: it has no
 * status or order to be asked with. No person — the filter offers none
 * until `listsEverything` says whose list this is.
 */
function legacyList<
  T extends { status: string; scheduledAt: number; _creationTime: number },
>(jobs: Array<T>, { status, sort }: { status?: string; sort?: 'visit' }) {
  const kept = status ? jobs.filter((job) => job.status === status) : jobs
  return sort === 'visit'
    ? [...kept].sort((a, b) => b.scheduledAt - a.scheduledAt)
    : kept
}
