import { Suspense, useDeferredValue, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { usePrefetchQuery, useSuspenseQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { PagePending } from '#/components/shell/Pending'
import { WeekStrip } from '#/components/schedule/WeekStrip'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { SetupGuideCard } from '#/components/onboarding/SetupGuide'
import { InstallCard } from '#/components/install/InstallCard'
import { TeamJoinedNotices } from '#/components/onboarding/TeamJoined'
import { NewJobSheet } from '#/components/schedule/NewJobSheet'
import {
  EmptyState,
  EmptyStateButton,
  NoMatches,
} from '#/components/primitives/EmptyState'
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
import {
  joinWindowStart,
  loaderWaitMs,
  rq,
  searchParam,
  settleInBrowser,
  warm,
} from '#/lib/routeQueries'
import { useToday } from '#/lib/useToday'
import { WeekView } from '#/components/schedule/WeekView'
import { RecurringDueNote } from '#/components/schedule/RecurringDueNote'
import { NotKeptDay } from '#/components/schedule/NotKeptDay'
import { ScheduleNotKept } from '#/components/schedule/ScheduleNotKept'
import { KeptCopyNote } from '#/components/shell/KeptCopyNote'
import { logConnection } from '#/lib/connectionLog'
import { keeper } from '#/lib/offline/keeper'
import {
  aimFor,
  drawnFrom,
  drawnNow,
  firstDrawn,
} from '#/lib/offline/keptSchedule'
import {
  useKeptBeforeDay,
  useKeptNote,
  useReadable,
  useReadableAll,
} from '#/lib/offline/useKept'
import { SCHEDULE_VIEWS, SCHEDULE_VIEW_OPTIONS } from '#/lib/scheduleViews'
import { weekDayKeys, weekTotals } from '#/lib/weekView'
import type { ScheduleView } from '#/lib/scheduleViews'
import type { Access } from '#/lib/access'
import type { Id } from '../../../convex/_generated/dataModel'
import { HEADER_ADD_BUTTON } from '#/components/primitives/buttons'
import { OutboxGroup } from '#/components/schedule/OutboxGroup'
import { useOutboxDay, useOutboxPlaces } from '#/lib/outbox/useOutbox'

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
  // A booking on this phone, not sent yet, opened from its card: its
  // `localId`, never in `jobId`, which the server would refuse as no job's
  // id (lib/outbox/). Opened only once the page has hydrated and the
  // phone's bookings have been read.
  outboxId: z.string().optional(),
  // How the day is rendered, in the URL for the same reason `date` is: the way
  // a tech prefers to read their day should survive a refresh (§5.1). A link
  // to a view that no longer exists opens the default rather than erroring.
  view: z.enum(SCHEDULE_VIEWS).optional().catch(undefined),
  // Opens New Job on arrival — set-up's "Book your first job". Taken out of
  // the URL as it opens, so a refresh does not open it again.
  newJob: z.boolean().optional().catch(undefined),
})

/** A day's cards: two columns from md, the same cards re-flowed. */
const DAY_GRID = 'flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch'

/** How long a navigation in the browser waits for the owner's news (the
 * set-up guide, who joined) before the day shows without it. */
const OWNER_NEWS_WAIT_MS = 1_500

/** How soon after the page has hydrated the phone's copy may still replace
 * what the HTML drew (`keeper.upgradeFromKept`): later, cards would move
 * under a thumb already reaching for one. */
const UPGRADE_WITHIN_MS = 500

export const Route = createFileRoute('/$businessSlug/schedule')({
  validateSearch: searchSchema,
  // The day's jobs, its week and the roster together, instead of one after
  // another as the page reads them. No `loaderDeps` on the day: that would
  // make every tap on the strip a new match, and a new match is a placeholder
  // rather than the day you are leaving.
  //
  // It also says what today is, and since when the join notices count, for
  // the page's first render: worked out here, they go into the HTML with
  // the answers they were asked with, so a copy of the page the service
  // worker kept from yesterday still hydrates as it was rendered.
  loader: async ({ context: { queryClient, business }, location }) => {
    const today = todayKeyIn(business.timezone)
    const joinSince = joinWindowStart()
    const asked = searchParam(location, 'date')
    const day = /^\d{4}-\d{2}-\d{2}$/.test(asked ?? '')
      ? (asked as string)
      : today
    const month = day.slice(0, 7)
    const desktop =
      typeof window !== 'undefined' &&
      window.matchMedia('(min-width: 1024px)').matches

    // Asked for without holding the page: what the sheets behind a tap need
    // (the client directory New Job and a job's edit form pick a site from),
    // and — on a desktop — the month grid beside the agenda, which draws a
    // cell-exact placeholder of its own and a legend it is happy to render
    // without. Waiting for those would hold the header, the strip and the
    // agenda for the slowest of five queries rather than of three.
    if (typeof window !== 'undefined') {
      void warm(
        queryClient,
        rq.directory(business._id),
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

    // The set-up guide sits above the day, so it is asked for with it — an
    // owner's only, read off the access the layout already holds — rather
    // than popping in afterwards and pushing the day down under a thumb.
    const owner =
      queryClient.getQueryData<Access>(rq.access(business._id).queryKey)
        ?.caps['business.manage'] === true

    const essentials = warm(
      queryClient,
      rq.week(business._id, startOfWeekKey(day)),
      ...weekDays,
      rq.roster(business._id),
    )
    const news = owner
      ? warm(
          queryClient,
          rq.setupGuide(business._id),
          rq.teamJoins(business._id, joinSince),
        )
      : Promise.resolve()
    // Everything, on the server. In the browser the day is waited for only
    // so long (`loaderWaitMs`), and the owner's news for less: on a line
    // that slow, the day is worth more than keeping news from landing
    // above it. Not at all with the line down, the socket's as well as the
    // phone's (`keeper.lineDown`): what the phone keeps answers at once, and
    // the page says what it doesn't.
    await settleInBrowser(
      keeper.lineDown() ? 0 : loaderWaitMs(),
      Promise.all([essentials, settleInBrowser(OWNER_NEWS_WAIT_MS, news)]),
    )
    return { today, joinSince }
  },
  component: SchedulePage,
})

/**
 * The Schedule, or with the line down and nothing of it on the phone, the
 * page saying so (`ScheduleNotKept`) where a placeholder would wait for good.
 *
 * Whether a day can be drawn (`useReadable`) reads as yes on the server and
 * in the hydration render, so the page hydrates as the server drew it, and
 * only then looks at what the phone holds. Today, or the day asked for, will
 * do: the schedule itself goes back to one it has when the other is missing.
 *
 * The body waits for its first day inside a boundary of its own, so this
 * much is on screen, and listening, even while it waits: a day asked for
 * as a socket dies, before the line counts as down, would otherwise hold
 * the route's placeholder up for as long as there is no signal. Once the
 * line counts as down this says so, and the body starts again on a day it
 * can draw.
 */
function SchedulePage() {
  const { business } = Route.useRouteContext()
  const loaded = Route.useLoaderData()
  const { date, view } = Route.useSearch()
  const mode = useViewMode()
  // The loader's today until the page has hydrated, then the phone's: the
  // HTML may be a copy the service worker kept from an earlier day.
  const today = useToday(business.timezone, loaded.today)
  const requestedKey = date ?? today
  const inWeek = view === 'week'
  const requestedReadable = useReadableAll(
    drawnFrom(business._id, requestedKey, inWeek),
  )
  const todayReadable = useReadableAll(drawnFrom(business._id, today, inWeek))
  const teamReadable = useReadable(rq.roster(business._id).queryKey)
  const nothingKept = !teamReadable || (!requestedReadable && !todayReadable)

  useEffect(() => {
    if (nothingKept) logConnection('kept-not-here', { what: 'schedule' })
  }, [nothingKept])

  return nothingKept ? (
    <ScheduleNotKept
      businessId={business._id}
      businessSlug={business.slug}
      kicker={formatMonthLabel(requestedKey)}
      title={mode === 'mine' ? 'My jobs' : 'Schedule'}
    />
  ) : (
    <Suspense fallback={<PagePending />}>
      <ScheduleBody today={today} requestedReadable={requestedReadable} />
    </Suspense>
  )
}

function ScheduleBody({
  today,
  requestedReadable,
}: {
  today: string
  /** Whether the day (or week) asked for can be drawn: in memory, kept on
   * the phone, or on its way down a working line. */
  requestedReadable: boolean
}) {
  const { business } = Route.useRouteContext()
  const loaded = Route.useLoaderData()
  const canDispatch = useCan('jobs.dispatch')
  const canManageClients = useCan('clients.manage')
  // The account being worked in, so the day opens on the right person's round.
  const acting = useActing()
  const mode = useViewMode()
  const { date, jobId, view, newJob, outboxId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const openJobId = jobId ?? null
  // A replace gives the entry a new history key, and a new key scrolls the
  // window to the top: opening or closing a job's sheet would lose the
  // person's place in the day or the week behind it.
  const setOpenJobId = (id: string | null) =>
    navigate({
      search: (prev) => ({
        ...prev,
        jobId: id ?? undefined,
        outboxId: undefined,
      }),
      replace: true,
      resetScroll: false,
    })
  // A booking on this phone, not sent yet, opened as a job is.
  const setOpenOutboxId = (localId: string | null) =>
    navigate({
      search: (prev) => ({
        ...prev,
        jobId: undefined,
        outboxId: localId ?? undefined,
      }),
      replace: true,
      resetScroll: false,
    })
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
  // Who a job booked from a join notice is for; nobody in particular else.
  const [newJobFor, setNewJobFor] = useState<Id<'memberships'>>()
  const dismissJoined = useConvexMutation(api.teamJoins.dismiss)
  const [monthOpen, setMonthOpen] = useState(false)
  const [monthKey, setMonthKey] = useState<string | null>(null)
  // A button that opens a sheet does nothing before hydration, and does it
  // silently. Disabling until ready is honest and gives tests a real signal.
  const hydrated = useHydrated()
  // Arrived to book a job (set-up's finish): open New Job once the sheet can
  // work, and drop the ask from the URL so a refresh lands on the day.
  useEffect(() => {
    if (!newJob || !hydrated) return
    setNewJobOpen(true)
    void navigate({
      search: (prev) => ({ ...prev, newJob: undefined }),
      replace: true,
    })
  }, [newJob, hydrated, navigate])
  // §2.4: desktop gets a persistent month grid + agenda pane instead of the
  // week strip and its sheet — a re-layout, not a second calendar.
  const isDesktop = useMediaQuery('(min-width: 1024px)')

  // The day asked for, and the day on screen. A day not fetched yet suspends
  // this page, and a suspension here swaps the whole page — the strip or
  // calendar just tapped included — for the route's placeholder. Deferring
  // the day keeps the current one up, dimmed, until the next is ready; a day
  // already in the cache still switches at once. What was tapped (the
  // highlight, the next/previous week, the new job's day) follows
  // `requestedKey`; everything drawn from the day's data follows
  // `selectedKey`.
  //
  // With the line down, a day the phone keeps no copy of would never be
  // ready: the page would sit on the one before, dimmed, for good. So the
  // day aimed for is the one asked for only while it can be drawn, else the
  // last one that was (today, if none has been yet), and the heading names
  // the day asked for over "Not on this phone" in the list's place
  // (lib/offline/keptSchedule.ts). In the week, it is all seven days that
  // must be drawable, so the day on screen may be the very one asked for
  // and still not do.
  const requestedKey = date ?? today
  const [lastDrawn, setLastDrawn] = useState(() =>
    firstDrawn(requestedKey, requestedReadable, today),
  )
  const { target, notKept } = aimFor({
    requestedKey,
    requestedReadable,
    lastDrawn,
  })
  const selectedKey = useDeferredValue(target)
  useEffect(() => {
    setLastDrawn((last) => drawnNow(last, selectedKey, target))
  }, [selectedKey, target])
  const stale = selectedKey !== target || shownView !== activeView
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

  // What is on screen is drawn from these: the note under the strip says
  // when they were last known right, if they are the phone's copy.
  const shownKeys = [
    ...drawnFrom(business._id, selectedKey, shownView === 'week'),
    rq.roster(business._id).queryKey,
  ]
  const keptNote = useKeptNote(shownKeys, business.timezone, today)
  // Once hydrated, what the HTML drew gives way to the phone's copy where
  // that is clearly newer — only straight away, or not at all (R10).
  const [firstKeys] = useState(shownKeys)
  useEffect(() => {
    void keeper.upgradeFromKept(firstKeys, UPGRADE_WITHIN_MS)
  }, [firstKeys])
  // For the phone's connection notes: how old a copy was shown, once, and
  // each day asked for that the phone doesn't keep.
  const keptNoted = useRef(false)
  useEffect(() => {
    if (keptNote.phase !== 'shown' || keptNoted.current) return
    keptNoted.current = true
    logConnection('kept-note', {
      tone: keptNote.tone,
      ageMin:
        keptNote.asOf === null
          ? -1
          : Math.round((Date.now() - keptNote.asOf) / 60_000),
    })
  }, [keptNote.phase, keptNote.tone, keptNote.asOf])
  useEffect(() => {
    if (notKept) logConnection('kept-not-here', { what: activeView })
  }, [notKept, requestedKey, activeView])
  /**
   * The phone opens on your own jobs — for everyone but the owner looking at
   * his business, whose God view means everyone on the phone as on the
   * desktop, and whose "Just my jobs" has nothing left to narrow. Inside
   * somebody's account it opens on theirs, as it would on their phone.
   */
  const defaultStaffId =
    mode === 'everyone' || mode === 'mine' ? 'all' : acting.membershipId
  const { status, setStatus, staffId, setStaffId, filteredJobs } = useScheduleFilters(
    jobs,
    defaultStaffId,
    `${mode ?? ''}:${acting.membershipId}`,
  )
  // No desktop/mobile special-case any more. The query is cached and keyed by
  // its (canonicalised) day set, so the desktop panel asking for the same day
  // shares this entry rather than issuing a second request — which is what the
  // `isDesktop ? [] : ...` dance was working around.
  // The day's bookings on this phone, not sent yet, in a group of their own
  // under its cards, each keeping its slot until the day is drawn afresh
  // (lib/outbox/latchSlots.ts). The week has none of them yet. A day the
  // phone keeps no copy of still has those: under "Not on this phone".
  const outboxDayKey = notKept ? requestedKey : selectedKey
  const outboxDay = useOutboxDay({
    businessId: business._id,
    dayShown: outboxDayKey,
    timezone: business.timezone,
    rows: notKept ? [] : jobs,
    drawsCards: shownView !== 'week' && !notKept && filteredJobs.length > 0,
    redrawKey: `${outboxDayKey}|${shownView}|${notKept}|${status}|${staffId}|${mode ?? ''}|${acting.membershipId}`,
    allStatuses: status === 'all' && shownView !== 'week',
    staffId,
    mineOnly: mode === 'mine' ? acting.membershipId : null,
  })
  // On a day not kept, under its "Not on this phone", with no forecast.
  const notKeptOutbox = (
    <OutboxGroup
      day={outboxDay}
      timezone={business.timezone}
      dayShown={outboxDayKey}
      onOpenItem={setOpenOutboxId}
      onOpenJob={setOpenJobId}
      weatherOf={() => ({ status: 'outOfWindow' })}
      grid={DAY_GRID}
      className="mt-6"
    />
  )
  // Its sites' forecasts asked for with the jobs', so a booking's strip is
  // there when its card is.
  const outboxPlaces = useOutboxPlaces(
    business._id,
    selectedKey,
    business.timezone,
  )
  const weather = useWeather(
    business._id,
    business.state,
    today,
    [...jobs, ...outboxPlaces].map((j) => ({
      dayKey: selectedKey,
      suburb: j.suburb,
      postcode: j.postcode,
      state: j.propertyState,
    })),
  )
  // The jobs a booking's slot now draws, kept out of the ordered list until
  // the next redraw.
  const listedJobs = filteredJobs.filter(
    (job) => !outboxDay.hidden.has(job._id),
  )

  // Coordinates come from the raw entries: a travel hint is geography, and
  // must not disappear just because a forecast is still in flight. Measured
  // over the work still ahead only — see `jobsAhead`.
  const travel = travelHintsFor(
    jobsAhead(listedJobs),
    (job) => weather.byKey[weatherKeyOf(job.suburb, job.postcode, selectedKey)],
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
  // And on a day that has arrived whose list is a copy the phone kept from
  // before it had: the list has none of that day's visits, the week's count
  // says how many there are.
  const keptBeforeDay = useKeptBeforeDay(
    rq.day(business._id, selectedKey).queryKey,
    business.timezone,
    selectedKey,
  )
  const recurringKept = selectedKey <= today && keptBeforeDay
  const recurringDue =
    selectedKey > today || recurringKept
      ? (week.find((d) => d.dayKey === selectedKey)?.recurringCount ?? 0)
      : 0
  // The day or week asked for that the phone keeps no copy of, as the
  // heading names it.
  const notKeptLabel =
    shownView === 'week'
      ? formatWeekRange(startOfWeekKey(requestedKey))
      : formatDayLabel(requestedKey)
  const notKeptDay = (
    <NotKeptDay label={notKeptLabel} onToday={() => setDay(today)} />
  )
  const note = (className?: string) => (
    <KeptCopyNote
      {...keptNote}
      timezone={business.timezone}
      todayKey={today}
      className={className}
    />
  )
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
        kicker={formatMonthLabel(notKept ? requestedKey : selectedKey)}
        onKickerClick={hydrated ? () => setMonthOpen(true) : undefined}
        // Says which view this is at a glance, on the screen he opens most.
        title={mode === 'mine' ? 'My jobs' : 'Schedule'}
        action={
          <button
            type="button"
            aria-label="New job"
            disabled={!hydrated}
            onClick={() => setNewJobOpen(true)}
            className={HEADER_ADD_BUTTON}
          >
            <Plus size={20} strokeWidth={2} />
          </button>
        }
      />

      {/* The owner's news, above the day: how far a new business's set-up
          has got, and who has joined lately. Then, for anyone on a phone
          using PestM8 in its browser, the way onto the Home Screen — never
          inserted after the page loads (see InstallCard). Collapses when
          there is none. */}
      <div className="pb-3 empty:hidden lg:pb-0">
        <SetupGuideCard
          businessId={business._id}
          businessSlug={business.slug}
          onBookJob={() => setNewJobOpen(true)}
        />
        <TeamJoinedNotices
          businessId={business._id}
          since={loaded.joinSince}
          onGiveJob={(membershipId) => {
            setNewJobFor(membershipId)
            setNewJobOpen(true)
          }}
        />
        <InstallCard />
      </div>

      {isDesktop ? (
        // Desktop (§2.4): a persistent month grid + team legend beside a
        // filterable day agenda, in place of the week strip and its sheet.
        // Same JobCard rows, same colours-are-per-subcontractor model —
        // re-flowed, not a second calendar.
        <section className="grid grid-cols-[340px_minmax(0,1fr)] items-start gap-5 px-4 pt-4 pb-6">
          <div className="flex min-w-0 flex-col gap-3">
            <MonthCalendarCard
              businessId={business._id}
              monthKey={monthKey ?? requestedKey.slice(0, 7)}
              selectedKey={requestedKey}
              todayKey={today}
              weekStart={shownView === 'week' ? weekStart : undefined}
              onSelect={setDay}
              onMonthChange={setMonthKey}
            />
            {/* Under the month, well below the band at the top right where
                the can't-reach notice floats with a change waiting to save,
                which would cover it above the agenda. */}
            {note('')}
          </div>
          <div className="min-w-0">
            <div aria-busy={stale || undefined} className={dimmed}>
              {notKept ? (
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="min-w-0 text-sheet-title text-ink">
                      {notKeptLabel}
                    </h2>
                    <Segmented
                      label="View"
                      value={activeView}
                      options={SCHEDULE_VIEW_OPTIONS}
                      onChange={setView}
                    />
                  </div>
                  {notKeptDay}
                  {notKeptOutbox}
                </div>
              ) : shownView === 'week' ? (
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
                  onOpenItem={setOpenOutboxId}
                  // The desktop layout only renders in the browser (it
                  // waits on a media query), so this is always live.
                  onNewJob={() => setNewJobOpen(true)}
                  recurringDue={recurringDue}
                  recurringKept={recurringKept}
                />
              )}
            </div>
          </div>
        </section>
      ) : (
        <>
          <div
            data-schedule-chrome
            // Scrolls away with the page rather than pinning under the header:
            // once the day is picked, the strip is only in the way of the
            // jobs. The header's tint, so at rest the two still read as one
            // band; no blur, as nothing ever passes beneath it.
            className="border-b border-hairline bg-chrome"
          >
            <div className="flex items-center justify-between px-3 pt-2">
              <button
                type="button"
                aria-label="Previous week"
                onClick={() => setDay(addDaysToKey(requestedKey, -7))}
                className="relative tap-target flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
              >
                <ChevronLeft size={20} strokeWidth={2} />
              </button>
              <button
                type="button"
                onClick={() => setDay(today)}
                className="relative tap-target text-body font-semibold text-blue"
              >
                Today
              </button>
              <button
                type="button"
                aria-label="Next week"
                onClick={() => setDay(addDaysToKey(requestedKey, 7))}
                className="relative tap-target flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
              >
                <ChevronRight size={20} strokeWidth={2} />
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

          {/* Under the strip, clear of the no-signal notice's band. While
              it says the line is down, the can't-reach notice gives way to
              it unless a change is waiting to save; then that notice, taller
              for Try again and the save, can cover its first line, and says
              when the screen was last updated itself. */}
          {note()}

          <section
            aria-busy={stale || undefined}
            className={`px-4 pt-4 pb-6 ${dimmed}`}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="section-label">
                  {notKept
                    ? notKeptLabel
                    : shownView === 'week'
                      ? formatWeekRange(weekStart)
                      : formatDayLabel(selectedKey)}
                </h2>
                {shownView === 'week' && !notKept && weekSummary}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label="View"
                  value={activeView}
                  options={SCHEDULE_VIEW_OPTIONS}
                  onChange={setView}
                />
                {/* The week is unfiltered: its numbers are the week's. */}
                {shownView !== 'week' && !notKept && (
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

            {shownView !== 'week' && !notKept && (
              <div className="mb-3 empty:hidden">
                <RecurringDueNote
                  count={recurringDue}
                  businessSlug={business.slug}
                  kept={recurringKept}
                />
              </div>
            )}

            {notKept ? (
              <>
                {notKeptDay}
                {notKeptOutbox}
              </>
            ) : shownView === 'week' ? (
              weekView
            ) : jobs.length === 0 && outboxDay.slots.length === 0 ? (
              <EmptyState
                title={
                  mode === 'mine' ? 'Nothing booked for you' : 'Nothing booked'
                }
                body="This day is clear."
                action={
                  <EmptyStateButton
                    onClick={() => setNewJobOpen(true)}
                    disabled={!hydrated}
                  >
                    Book a job
                  </EmptyStateButton>
                }
              />
            ) : filteredJobs.length === 0 && outboxDay.slots.length === 0 ? (
              // The day has jobs; the filters hide them. The thing to do is
              // change the filters, not book one.
              <NoMatches
                hint="No jobs on this day match these filters."
                clearLabel="Clear filters"
                onClear={() => {
                  setStatus('all')
                  setStaffId(defaultStaffId)
                }}
              />
            ) : (
              <>
                {listedJobs.length > 0 && (
                  // Two columns from md: the same cards, re-flowed. A tablet
                  // screen showing one 460px column of jobs wastes the extra
                  // width that makes a week readable at a glance.
                  <div className={DAY_GRID}>
                    {listedJobs.map((job) => (
                      <JobCard
                        key={job._id}
                        job={job}
                        travel={travel[job._id]}
                        weather={weather.cell(
                          job.suburb,
                          job.postcode,
                          selectedKey,
                        )}
                        timezone={business.timezone}
                        onOpen={setOpenJobId}
                        hideTechnician
                        dayShown={selectedKey}
                      />
                    ))}
                    {outboxDay.slots.length === 0 &&
                      Object.keys(weather.byKey).length > 0 && (
                        <WeatherCredit className="md:col-span-2" />
                      )}
                  </div>
                )}
                {/* After the cards, never among them: below the last card,
                    it moves nothing above it whenever it comes. */}
                <OutboxGroup
                  day={outboxDay}
                  timezone={business.timezone}
                  dayShown={selectedKey}
                  onOpenItem={setOpenOutboxId}
                  onOpenJob={setOpenJobId}
                  weatherOf={(row) =>
                    weather.cell(row.suburb, row.postcode ?? '', selectedKey)
                  }
                  grid={DAY_GRID}
                  className={listedJobs.length > 0 ? 'mt-6' : ''}
                />
                {/* Still the last thing on the day, under the group. */}
                {(outboxDay.slots.length > 0 || listedJobs.length === 0) &&
                  Object.keys(weather.byKey).length > 0 && (
                    <WeatherCredit className="mt-2.5" />
                  )}
              </>
            )}
          </section>
        </>
      )}

      <JobDetailSheet
        businessId={business._id}
        businessSlug={business.slug}
        timezone={business.timezone}
        jobId={openJobId}
        outboxId={outboxId ?? null}
        canReassign={canDispatch}
        canDelete={canManageClients}
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
        onClose={() => {
          setNewJobOpen(false)
          setNewJobFor(undefined)
        }}
        assignTo={newJobFor}
        // Booked for someone from their join notice: that is the notice
        // answered, so it goes (on every device).
        onBooked={() => {
          if (newJobFor) {
            void dismissJoined({
              businessId: business._id,
              membershipId: newJobFor,
            }).catch(() => {})
          }
        }}
      />
    </>
  )
}
