import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { usePrefetchQuery, useSuspenseQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { WeekStrip } from '#/components/schedule/WeekStrip'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { NewJobSheet } from '#/components/schedule/NewJobSheet'
import { EmptyState } from '#/components/primitives/EmptyState'
import {
  addDaysToKey,
  formatDayLabel,
  formatMonthLabel,
  formatWeekRange,
  startOfWeekKey,
  todayKey as todayKeyIn,
} from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'
import { useMediaQuery } from '#/lib/useMediaQuery'
import { MonthPickerSheet } from '#/components/schedule/MonthPickerSheet'
import { MonthCalendarCard } from '#/components/schedule/MonthCalendarCard'
import { DayAgendaPanel } from '#/components/schedule/DayAgendaPanel'
import { ScheduleFilterBar } from '#/components/schedule/ScheduleFilterBar'
import { useScheduleFilters } from '#/lib/scheduleFilters'
import { useWeather, weatherKeyOf } from '#/lib/weather'
import { WeatherCredit } from '#/components/schedule/WeatherCredit'
import { jobsAhead, travelHintsFor } from '#/lib/travel'
import { Segmented } from '#/components/primitives/Segmented'
import { useActing, useCan, useViewMode } from '#/lib/access'
import { rq, searchParam, warm } from '#/lib/routeQueries'
import { WeekView } from '#/components/schedule/WeekView'
import { RecurringDueNote } from '#/components/schedule/RecurringDueNote'
import { SCHEDULE_VIEWS, SCHEDULE_VIEW_OPTIONS } from '#/lib/scheduleViews'
import { weekDayKeys, weekTotals } from '#/lib/weekView'
import type { ScheduleView } from '#/lib/scheduleViews'

const searchSchema = z.object({
  // Lives in the URL, not useState: the day a tech is looking at survives a
  // refresh and is shareable (§5.1).
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // Lets a job be deep-linked straight to its detail sheet — e.g. from a
  // client's job history — without depending on which day is on screen.
  jobId: z.string().optional(),
  // How the day is rendered, in the URL for the same reason `date` is: the way
  // a tech prefers to read their day should survive a refresh (§5.1). A link
  // to a view that no longer exists opens the default rather than erroring.
  view: z.enum(SCHEDULE_VIEWS).optional().catch(undefined),
})

export const Route = createFileRoute('/$businessSlug/schedule')({
  validateSearch: searchSchema,
  // The day's jobs, its week and the roster together, instead of one after
  // another as the page reads them. No `loaderDeps` on the day: that would
  // make every tap on the strip a new match, and a new match is a placeholder
  // rather than the day you are leaving.
  loader: ({ context: { queryClient, business }, location }) => {
    const asked = searchParam(location, 'date')
    const day = /^\d{4}-\d{2}-\d{2}$/.test(asked ?? '')
      ? (asked as string)
      : todayKeyIn(business.timezone)
    const month = day.slice(0, 7)
    const desktop =
      typeof window !== 'undefined' &&
      window.matchMedia('(min-width: 1024px)').matches

    // Asked for without holding the page: what the sheets behind a tap need,
    // and — on a desktop — the month grid beside the agenda, which draws a
    // cell-exact placeholder of its own and a legend it is happy to render
    // without. Waiting for those would hold the header, the strip and the
    // agenda for the slowest of five queries rather than of three.
    if (typeof window !== 'undefined') {
      void warm(
        queryClient,
        rq.properties(business._id),
        ...(desktop
          ? [rq.month(business._id, month), rq.monthTeam(business._id, month)]
          : []),
      )
    }

    // The Week View reads all seven days: asked for together, here, rather
    // than one after another as it renders.
    const weekDays =
      searchParam(location, 'view') === 'week'
        ? weekDayKeys(startOfWeekKey(day)).map((key) =>
            rq.day(business._id, key),
          )
        : [rq.day(business._id, day)]

    return warm(
      queryClient,
      rq.week(business._id, startOfWeekKey(day)),
      ...weekDays,
      rq.roster(business._id),
    )
  },
  component: SchedulePage,
})

function SchedulePage() {
  const { business } = Route.useRouteContext()
  const canDispatch = useCan('jobs.dispatch')
  // The account being worked in, so the day opens on the right person's round.
  const acting = useActing()
  const mode = useViewMode()
  const { date, jobId, view } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const openJobId = jobId ?? null
  const setOpenJobId = (id: string | null) =>
    navigate({ search: (prev) => ({ ...prev, jobId: id ?? undefined }), replace: true })
  const activeView: ScheduleView = view ?? 'job'
  // What is drawn: the view just picked once it can be, the one before it
  // (dimmed) until then — so switching to a week not yet loaded keeps the
  // page up rather than swapping it for the route's placeholder.
  const shownView = useDeferredValue(activeView)
  // On a desktop, the week and the day draw their View control in different
  // places, so switching between them remounts it and a keyboard user's
  // focus would fall to the page. Put it back on the view just chosen.
  const restoreViewFocus = useRef(false)
  const setView = (next: ScheduleView) => {
    restoreViewFocus.current =
      document.activeElement?.closest('[role="tablist"]') != null
    navigate({ search: (prev) => ({ ...prev, view: next }), replace: true })
  }
  useEffect(() => {
    if (!restoreViewFocus.current) return
    restoreViewFocus.current = false
    document
      .querySelector<HTMLElement>(
        '[role="tablist"][aria-label="View"] [role="tab"][aria-selected="true"]',
      )
      ?.focus()
  }, [shownView])
  const [newJobOpen, setNewJobOpen] = useState(false)
  const [monthOpen, setMonthOpen] = useState(false)
  const [monthKey, setMonthKey] = useState<string | null>(null)
  // A button that opens a sheet does nothing before hydration, and does it
  // silently. Disabling until ready is honest and gives tests a real signal.
  const hydrated = useHydrated()
  // §2.4: desktop gets a persistent month grid + agenda pane instead of the
  // week strip and its sheet — a re-layout, not a second calendar.
  const isDesktop = useMediaQuery('(min-width: 1024px)')

  const today = todayKeyIn(business.timezone)
  // The day asked for, and the day on screen. A day not fetched yet suspends
  // this page, and a suspension here swaps the whole page — the strip or
  // calendar just tapped included — for the route's placeholder. Deferring
  // the day keeps the current one up, dimmed, until the next is ready; a day
  // already in the cache still switches at once. What was tapped (the
  // highlight, the next/previous week, the new job's day) follows
  // `requestedKey`; everything drawn from the day's data follows
  // `selectedKey`.
  const requestedKey = date ?? today
  const selectedKey = useDeferredValue(requestedKey)
  const stale = selectedKey !== requestedKey || shownView !== activeView
  // The delay is what keeps a cached day from flashing dimmed on its way past;
  // reduced motion takes the instant change after that delay, not no delay.
  const dimmed = `transition-opacity delay-150 motion-reduce:duration-0 ${stale ? 'opacity-60' : 'delay-0'}`
  const weekStart = startOfWeekKey(selectedKey)

  // Asked for first, and not waited on here: read in the order they are
  // needed, the day's jobs went out only once the week had come back, so
  // every cold week change paid two round trips instead of one.
  usePrefetchQuery(rq.day(business._id, selectedKey))
  const { data: week } = useSuspenseQuery(rq.week(business._id, weekStart))
  const { data: jobs } = useSuspenseQuery(rq.day(business._id, selectedKey))
  const { data: members } = useSuspenseQuery(rq.roster(business._id))
  /**
   * The phone opens on your own jobs — for everyone but the owner looking at
   * his business, whose God view means everyone on the phone as on the
   * desktop, and whose "Just my jobs" has nothing left to narrow. Inside
   * somebody's account it opens on theirs, as it would on their phone.
   */
  const { status, setStatus, staffId, setStaffId, filteredJobs } = useScheduleFilters(
    jobs,
    mode === 'everyone' || mode === 'mine' ? 'all' : acting.membershipId,
    `${mode ?? ''}:${acting.membershipId}`,
  )
  // No desktop/mobile special-case any more. The query is cached and keyed by
  // its (canonicalised) day set, so the desktop panel asking for the same day
  // shares this entry rather than issuing a second request — which is what the
  // `isDesktop ? [] : ...` dance was working around.
  const weather = useWeather(
    business._id,
    business.state,
    today,
    jobs.map((j) => ({
      dayKey: selectedKey,
      suburb: j.suburb,
      postcode: j.postcode,
      state: j.propertyState,
    })),
  )

  // Coordinates come from the raw entries: a travel hint is geography, and
  // must not disappear just because a forecast is still in flight. Measured
  // over the work still ahead only — see `jobsAhead`.
  const travel = travelHintsFor(jobsAhead(filteredJobs), (job) =>
    weather.byKey[weatherKeyOf(job.suburb, job.postcode, selectedKey)],
  )

  // `jobId` is deliberately dropped rather than carried: moving to another day
  // should close a sheet showing a job that day no longer contains.
  //
  // In the week, a day picked on the strip or the grid is scrolled to rather
  // than the page jumping back to the top — and picked again (Today, say)
  // it is scrolled to again, which the count below is for.
  const [weekFocusTick, setWeekFocusTick] = useState(0)
  const setDay = (dayKey: string) => {
    const inWeek = activeView === 'week'
    if (inWeek) setWeekFocusTick((tick) => tick + 1)
    navigate({
      search: (prev) => ({ view: prev.view, date: dayKey }),
      replace: true,
      resetScroll: !inWeek,
    })
  }
  // From the week to one of its days. A push, unlike `setDay`: Back returns
  // to the week the day was opened from.
  const openDay = (dayKey: string) =>
    navigate({ search: { date: dayKey, view: 'job' } })

  // Projected visits on the selected day, when it is still ahead: not on its
  // list and in no count, but worth saying so the day does not look clear.
  const recurringDue =
    selectedKey > today
      ? (week.find((d) => d.dayKey === selectedKey)?.recurringCount ?? 0)
      : 0
  const totals = weekTotals(week)
  const weekSummary = (
    <p className="flex flex-wrap items-center gap-x-1.5 text-caption tabular-nums text-ink-2">
      <span>
        {totals.jobs} {totals.jobs === 1 ? 'job' : 'jobs'}
      </span>
      {totals.recurring > 0 && (
        <span>
          · {totals.recurring} recurring{' '}
          {totals.recurring === 1 ? 'visit' : 'visits'}
        </span>
      )}
    </p>
  )
  const weekView = (
    <WeekView
      businessId={business._id}
      businessSlug={business.slug}
      timezone={business.timezone}
      weekStart={weekStart}
      todayKey={today}
      focusKey={requestedKey}
      focusTick={weekFocusTick}
      week={week}
      showTeam={mode !== 'mine'}
      onOpenJob={setOpenJobId}
      onOpenDay={openDay}
    />
  )

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={formatMonthLabel(selectedKey)}
        onKickerClick={hydrated ? () => setMonthOpen(true) : undefined}
        // Says which view this is at a glance, on the screen he opens most.
        title={mode === 'mine' ? 'My jobs' : 'Schedule'}
        action={
          <button
            type="button"
            aria-label="New job"
            disabled={!hydrated}
            onClick={() => setNewJobOpen(true)}
            className="flex size-9 items-center justify-center rounded-full bg-red text-white shadow-red transition active:scale-[.95] disabled:opacity-50"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
        }
      />

      {isDesktop ? (
        // Desktop (§2.4): a persistent month grid + team legend beside a
        // filterable day agenda, in place of the week strip and its sheet.
        // Same JobCard rows, same colours-are-per-subcontractor model —
        // re-flowed, not a second calendar.
        <section className="grid grid-cols-[340px_minmax(0,1fr)] items-start gap-5 px-4 pt-4 pb-6">
          <MonthCalendarCard
            businessId={business._id}
            monthKey={monthKey ?? requestedKey.slice(0, 7)}
            selectedKey={requestedKey}
            todayKey={today}
            weekStart={shownView === 'week' ? weekStart : undefined}
            onSelect={setDay}
            onMonthChange={setMonthKey}
          />
          <div aria-busy={stale || undefined} className={`min-w-0 ${dimmed}`}>
            {shownView === 'week' ? (
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sheet-title text-ink">
                      {formatWeekRange(weekStart)}
                    </h2>
                    {weekSummary}
                  </div>
                  <Segmented
                    label="View"
                    value={activeView}
                    options={SCHEDULE_VIEW_OPTIONS}
                    onChange={setView}
                  />
                </div>
                {weekView}
              </div>
            ) : (
              <DayAgendaPanel
                businessId={business._id}
                businessSlug={business.slug}
                state={business.state}
                timezone={business.timezone}
                selectedKey={selectedKey}
                todayKey={today}
                jobs={jobs}
                members={members}
                view={activeView}
                onViewChange={setView}
                onOpenJob={setOpenJobId}
                recurringDue={recurringDue}
              />
            )}
          </div>
        </section>
      ) : (
        <>
          <div
            data-schedule-chrome
            className="chrome-blur sticky top-[76px] z-20 border-b border-hairline"
          >
            <div className="flex items-center justify-between px-3 pt-2">
              <button
                type="button"
                aria-label="Previous week"
                onClick={() => setDay(addDaysToKey(requestedKey, -7))}
                className="flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
              >
                <ChevronLeft size={20} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                onClick={() => setDay(today)}
                className="text-body font-semibold text-blue"
              >
                Today
              </button>
              <button
                type="button"
                aria-label="Next week"
                onClick={() => setDay(addDaysToKey(requestedKey, 7))}
                className="flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
              >
                <ChevronRight size={20} strokeWidth={1.7} />
              </button>
            </div>
            <WeekStrip
              startKey={weekStart}
              // The tapped day, unless it belongs to a week not up yet — then
              // the strip on screen has no such day to mark, and marking none
              // would read as nothing having happened.
              selectedKey={
                startOfWeekKey(requestedKey) === weekStart
                  ? requestedKey
                  : selectedKey
              }
              todayKey={today}
              load={week}
              onSelect={setDay}
              monochrome={mode === 'mine'}
            />
          </div>

          <section
            aria-busy={stale || undefined}
            className={`px-4 pt-4 pb-6 ${dimmed}`}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="section-label">
                  {shownView === 'week'
                    ? formatWeekRange(weekStart)
                    : formatDayLabel(selectedKey)}
                </h2>
                {shownView === 'week' && weekSummary}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label="View"
                  value={activeView}
                  options={SCHEDULE_VIEW_OPTIONS}
                  onChange={setView}
                />
                {/* The week is unfiltered: its numbers are the week's. */}
                {shownView !== 'week' && (
                  <ScheduleFilterBar
                    jobs={jobs}
                    members={members}
                    status={status}
                    setStatus={setStatus}
                    staffId={staffId}
                    setStaffId={setStaffId}
                    hideStaff={mode === 'mine'}
                  />
                )}
              </div>
            </div>

            {shownView !== 'week' && (
              <div className="mb-3 empty:hidden">
                <RecurringDueNote
                  count={recurringDue}
                  businessSlug={business.slug}
                />
              </div>
            )}

            {shownView === 'week' ? (
              weekView
            ) : filteredJobs.length === 0 ? (
              <EmptyState
                title={
                  jobs.length === 0
                    ? mode === 'mine'
                      ? 'Nothing booked for you'
                      : 'Nothing booked'
                    : 'No matching jobs'
                }
                body={
                  jobs.length === 0
                    ? 'This day is clear. Tap + to book a job.'
                    : 'No jobs match this filter.'
                }
              />
            ) : (
              // Two columns from md: the same cards, re-flowed. A tablet
              // screen showing one 460px column of jobs wastes the extra
              // width that makes a week readable at a glance.
              <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch">
                {filteredJobs.map((job) => (
                  <JobCard
                    key={job._id}
                    job={job}
                    travel={travel[job._id]}
                    weather={weather.cell(job.suburb, job.postcode, selectedKey)}
                    timezone={business.timezone}
                    onOpen={setOpenJobId}
                    hideTechnician
                    dayShown={selectedKey}
                  />
                ))}
                {Object.keys(weather.byKey).length > 0 && (
                  <WeatherCredit className="md:col-span-2" />
                )}
              </div>
            )}
          </section>
        </>
      )}

      <JobDetailSheet
        businessId={business._id}
        businessSlug={business.slug}
        timezone={business.timezone}
        jobId={openJobId}
        canReassign={canDispatch}
        onClose={() => setOpenJobId(null)}
      />

      <MonthPickerSheet
        businessId={business._id}
        open={monthOpen}
        monthKey={monthKey ?? requestedKey.slice(0, 7)}
        selectedKey={requestedKey}
        todayKey={today}
        onSelect={(dayKey) => {
          setDay(dayKey)
          setMonthOpen(false)
        }}
        onMonthChange={setMonthKey}
        onClose={() => setMonthOpen(false)}
      />

      <NewJobSheet
        businessId={business._id}
        dayKey={requestedKey}
        timezone={business.timezone}
        open={newJobOpen}
        onClose={() => setNewJobOpen(false)}
      />
    </>
  )
}
