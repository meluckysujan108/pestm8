import { useEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { useSuspenseQueries } from '@tanstack/react-query'
import { ChevronRight, Repeat } from 'lucide-react'
import { StatusPill } from '#/components/primitives/StatusPill'
import { addDaysToKey, formatShortDayLabel, formatTime } from '#/lib/format'
import { computeStaffLoad, isOnJob } from '#/lib/scheduleFilters'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import { rq } from '#/lib/routeQueries'
import {
  outboxDrawn,
  useOutboxDay,
  useOutboxSettled,
} from '#/lib/outbox/useOutbox'
import {
  carriedFromBefore,
  dayPhase,
  splitDayRows,
  weekDayKeys,
  weekTotals,
} from '#/lib/weekView'
import { HORIZON_DAYS } from '../../../convex/lib/recurrence'
import { SummaryLine } from './DaySummary'
import { OutboxChip } from './OutboxChip'
import type { DayPhase } from '#/lib/weekView'
import type { OutboxDay } from '#/lib/outbox/useOutbox'
import type { OutboxChip as OutboxChipKind } from '#/lib/outbox/outboxRules'
import type { DayLoad } from './WeekStrip'
import type { JobRow } from './JobCard'
import type { Id } from '../../../convex/_generated/dataModel'
import { everyoneOnJob, namesOf } from '#/lib/jobPeople'

/**
 * The Schedule's Week View (Phase 4.4): the strip's seven days, each with its
 * booked jobs and — apart, never added in — its projected visits.
 *
 * Booked work is a block in the technician's colour: a tint and a rail, the
 * same "a person is a mark" rule as the job card (4.2), with the status as a
 * pill that says its word (4.3). A projection is not work anybody has agreed
 * to, so it is drawn only once its day has arrived — dashed, hollow — and
 * before that is only a number that links to the Recurring Job view. That is
 * the rule `listDay` already keeps: future projections off the schedule, due
 * ones on it, none of them in a job count.
 *
 * Filtered to one person (`staffId`), it is their week: their jobs, and the
 * visits of theirs that are due or overdue. A day ahead counts its visits on
 * the server, everyone's together (`listWeek`), so that number is left out
 * rather than said for someone it is not about.
 *
 * With `outbox`, each day also draws the person's bookings on this phone,
 * not sent yet (lib/outbox/, plan part 2c §9.3), last in its section, under
 * the carried visits: each a block like a job's with its chip where the
 * status pill goes, keeping its slot as it goes and then drawing the job it
 * made until the week is drawn afresh (`useOutboxDay`, `latchSlots`). Every
 * day under one moves when it comes, so they come only as the week first
 * draws, or when booked just now; a day with only those draws no "No jobs".
 * The counts are the server's throughout.
 */
export function WeekView({
  businessId,
  businessSlug,
  timezone,
  weekStart,
  todayKey,
  focusKey,
  focusTick = 0,
  week,
  showTeam,
  staffId = 'all',
  onOpenJob,
  onOpenDay,
  outbox,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  weekStart: string
  todayKey: string
  /** The day to bring into view — the one tapped on the strip or the grid. */
  focusKey: string
  /** Bumped on every pick, so picking the same day again still scrolls. */
  focusTick?: number
  /** `listWeek`'s days: where the recurring numbers come from, future days
   * included, since `listDay` does not return a projection ahead of its day. */
  week: Array<DayLoad & { dayKey?: string }>
  /** The team key: off in "Just my jobs", where every job is the viewer's. */
  showTeam: boolean
  /** The Schedule's person filter: a membership's id, or 'all'. */
  staffId?: string
  onOpenJob: (jobId: string) => void
  onOpenDay: (dayKey: string) => void
  /** The bookings on this phone, not sent yet, drawn on their days. */
  outbox?: {
    /** Opens one (`?outboxId=`). */
    onOpenItem: (localId: string) => void
    /** What else draws the week afresh: the filters, the mode, the account
     * worked in. */
    redrawKey: string
    /** "Just my jobs": the person's own membership. */
    mineOnly: string | null
  }
}) {
  const split = useWeekDays(businessId, weekStart, timezone)
  const committedAll = split.flatMap((d) => d.committed)
  const team = computeStaffLoad(committedAll)
  const everyone = staffId === 'all'
  const theirs = (rows: Array<JobRow>) =>
    everyone ? rows : rows.filter((job) => isOnJob(job, staffId))

  useScrollToDay(focusKey, weekStart, focusTick, useOutboxSettled())

  const beyondHorizon = weekStart > addDaysToKey(todayKey, HORIZON_DAYS)

  return (
    <div className="flex flex-col gap-3">
      {showTeam && everyone && team.length >= 2 && (
        // Whose rail is whose, for this week — the Schedule's cards no
        // longer print the technician's name.
        <ul
          aria-label="Team this week"
          className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-2"
        >
          {team.map((member) => (
            <li key={member.membershipId} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: member.colour }}
              />
              {member.name}
              <span className="tabular-nums text-muted">{member.count}</span>
            </li>
          ))}
        </ul>
      )}

      {beyondHorizon && (
        <p className="text-caption text-ink-2">
          Recurring visits appear here once they are within{' '}
          {Math.round(HORIZON_DAYS / 30)} months.
        </p>
      )}

      {split.map(({ dayKey, rows, committed, dueHere, carried }, i) => {
        const phase = dayPhase(dayKey, todayKey)
        const day: WeekDayProps = {
          initials: showTeam && everyone && team.length >= 2,
          dayKey,
          phase,
          businessSlug,
          timezone,
          committed: theirs(committed),
          dueHere: theirs(dueHere),
          carried: theirs(carriedFromBefore(carried, weekStart, timezone)),
          recurringCount: everyone
            ? (week.find((d) => d.offset === i)?.recurringCount ??
              dueHere.length)
            : phase === 'future'
              ? 0
              : theirs(dueHere).length,
          onOpenJob,
          onOpenDay,
        }
        return outbox ? (
          <WeekDayWithOutbox
            key={dayKey}
            {...day}
            businessId={businessId}
            rows={rows}
            staffId={staffId}
            outbox={outbox}
          />
        ) : (
          <WeekDay key={dayKey} {...day} />
        )
      })}
    </div>
  )
}

/**
 * The week's seven days as the Week View draws them: each day's booked jobs,
 * its own projected visits, and those carried onto it. Seven reads that the
 * route's loader has already asked for together; no boundary of their own,
 * so a week not in the cache keeps the previous view up (the page defers the
 * switch) instead of flashing a placeholder. The view's line and its filter
 * read the same seven, from the cache.
 */
export function useWeekDays(
  businessId: Id<'businesses'>,
  weekStart: string,
  timezone: string,
): Array<{
  dayKey: string
  /** The day's list as the server has it: what a booking sent became. */
  rows: Array<JobRow>
  committed: Array<JobRow>
  dueHere: Array<JobRow>
  carried: Array<JobRow>
}> {
  const dayKeys = weekDayKeys(weekStart)
  const days = useSuspenseQueries({
    queries: dayKeys.map((dayKey) => rq.day(businessId, dayKey)),
  }).map((result) => result.data as Array<JobRow>)
  return dayKeys.map((dayKey, i) => ({
    dayKey,
    rows: days[i],
    ...splitDayRows(days[i], dayKey, timezone),
  }))
}

/**
 * The week's line under its heading (`SummaryLine`): its jobs and its
 * recurring visits, or — filtered to one person — how many of the week's
 * jobs are theirs.
 */
export function WeekSummary({
  businessId,
  weekStart,
  timezone,
  week,
  staffId,
}: {
  businessId: Id<'businesses'>
  weekStart: string
  timezone: string
  week: Array<{ count: number; recurringCount?: number }>
  staffId: string
}) {
  const days = useWeekDays(businessId, weekStart, timezone)
  if (staffId !== 'all') {
    const all = days.flatMap((d) => d.committed)
    const shown = all.filter((job) => isOnJob(job, staffId)).length
    return (
      <SummaryLine>
        <span>
          {shown === all.length ? all.length : `${shown} of ${all.length}`}{' '}
          {all.length === 1 ? 'job' : 'jobs'}
        </span>
      </SummaryLine>
    )
  }
  const totals = weekTotals(week)
  return (
    <SummaryLine>
      <span>
        {totals.jobs} {totals.jobs === 1 ? 'job' : 'jobs'}
      </span>
      {totals.recurring > 0 && (
        <span>
          · {totals.recurring} recurring{' '}
          {totals.recurring === 1 ? 'visit' : 'visits'}
        </span>
      )}
    </SummaryLine>
  )
}

export type WeekDayProps = {
  /** Whose job each block is, as a letter too — not by colour alone. */
  initials: boolean
  dayKey: string
  phase: DayPhase
  businessSlug: string
  timezone: string
  committed: Array<JobRow>
  dueHere: Array<JobRow>
  carried: Array<JobRow>
  recurringCount: number
  onOpenJob: (jobId: string) => void
  onOpenDay: (dayKey: string) => void
}

/** A day of the week with the person's bookings on this phone on it. */
function WeekDayWithOutbox({
  businessId,
  rows,
  staffId,
  outbox,
  ...day
}: WeekDayProps & {
  businessId: Id<'businesses'>
  rows: Array<JobRow>
  staffId: string
  outbox: NonNullable<Parameters<typeof WeekView>[0]['outbox']>
}) {
  const outboxDay = useOutboxDay({
    businessId,
    dayShown: day.dayKey,
    timezone: day.timezone,
    rows,
    drawsCards: false,
    redrawKey: `${day.dayKey}|week|${staffId}|${outbox.redrawKey}`,
    // The week draws every status, so every booking.
    allStatuses: true,
    staffId,
    mineOnly: outbox.mineOnly,
    inWeek: true,
  })
  return (
    <WeekDay {...day} outboxDay={outboxDay} onOpenItem={outbox.onOpenItem} />
  )
}

/**
 * One day of the week as the Week View draws it, given its rows and, with
 * the outbox, its bookings on this phone as `useOutboxDay` slots them.
 * Exported for the UI harness, which draws a day's group as it stands after
 * a send (tools/ui-harness).
 */
export function WeekDay({
  initials,
  dayKey,
  phase,
  businessSlug,
  timezone,
  committed,
  dueHere,
  carried,
  recurringCount,
  onOpenJob,
  onOpenDay,
  outboxDay = null,
  onOpenItem,
}: WeekDayProps & {
  /** The day's bookings on this phone, as `useOutboxDay` slots them. */
  outboxDay?: OutboxDay | null
  onOpenItem?: (localId: string) => void
}) {
  const headingId = `week-day-${dayKey}-heading`
  // A job a booking's slot draws, until the week is drawn afresh, is drawn
  // there only: in its time order here, it would push every block under it
  // down (lib/outbox/latchSlots.ts).
  const listed =
    outboxDay === null
      ? committed
      : committed.filter((job) => !outboxDay.hidden.has(job._id))
  const drawsOutbox = outboxDay !== null && outboxDrawn(outboxDay)
  const anythingAbove =
    listed.length > 0 ||
    (phase !== 'future' && dueHere.length > 0) ||
    (phase === 'today' && carried.length > 0)
  return (
    <section
      id={`week-day-${dayKey}`}
      aria-labelledby={headingId}
      className="rounded-2xl border border-hairline bg-surface p-3 shadow-elevation"
    >
      <div className="flex items-center justify-between gap-2">
        {/* To that day's own view. A push, not a replace: Back returns to
            the week. */}
        <button
          type="button"
          id={headingId}
          onClick={() => onOpenDay(dayKey)}
          aria-current={phase === 'today' ? 'date' : undefined}
          className={`-my-1 flex min-h-11 items-center gap-1 rounded-lg pr-1 text-left text-row-title transition active:scale-[.99] ${
            phase === 'today' ? 'text-red' : 'text-ink'
          }`}
        >
          {formatShortDayLabel(dayKey)}
          {phase === 'today' && <span className="sr-only">, today</span>}
          <ChevronRight size={16} strokeWidth={2.2} aria-hidden />
        </button>

        {/* Two numbers, as two elements: booked work, then the day's own
            projected visits in the words that fit the day. */}
        <p className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-caption tabular-nums text-ink-2">
          <span>
            {committed.length} {committed.length === 1 ? 'job' : 'jobs'}
          </span>
          {recurringCount > 0 && (
            <RecurringToken
              phase={phase}
              count={recurringCount}
              businessSlug={businessSlug}
            />
          )}
        </p>
      </div>

      {committed.length === 0 && dueHere.length === 0 && !drawsOutbox ? (
        <p className="mt-1 text-caption text-ink-2">No jobs</p>
      ) : listed.length === 0 ? null : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {listed.map((job) => (
            <li key={job._id}>
              <JobBlock
                job={job}
                timezone={timezone}
                onOpen={onOpenJob}
                initial={initials}
              />
            </li>
          ))}
        </ul>
      )}

      {/* The day's own projections, once the day has come: shown where they
          fell, dashed because nobody has agreed to them. Before then they
          are the number above and nothing more. */}
      {phase !== 'future' && dueHere.length > 0 && (
        <ul
          aria-label={
            phase === 'past'
              ? 'Overdue recurring visits'
              : 'Recurring visits due'
          }
          className={`mt-2 flex flex-col gap-1.5 ${
            listed.length > 0
              ? 'border-t border-dashed border-hairline pt-2'
              : ''
          }`}
        >
          {dueHere.map((job) => (
            <li key={job._id}>
              <JobBlock
                job={job}
                timezone={timezone}
                onOpen={onOpenJob}
                overdue={phase === 'past'}
                initial={initials}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Visits missed before this week began. The week shows each missed
          visit on its own day, so one from earlier this week is already
          there; one from last week is on no day of this one. Today's Job
          view carries them; this says so and goes there. */}
      {phase === 'today' && carried.length > 0 && (
        <button
          type="button"
          onClick={() => onOpenDay(dayKey)}
          className="mt-2 flex min-h-11 w-full items-center gap-2 rounded-xl bg-surface-2 px-3 text-left text-caption text-ink transition active:scale-[.99]"
        >
          <span
            className={`rounded-full px-2 text-[12px] font-semibold leading-5 ${OVERDUE_CHIP}`}
          >
            {carried.length} overdue
          </span>
          from earlier days
          <ChevronRight
            size={16}
            strokeWidth={2.2}
            className="ml-auto"
            aria-hidden
          />
        </button>
      )}

      {/* The person's bookings on this phone, not sent yet: last, so they
          move nothing in the day above them. */}
      {outboxDay !== null && drawsOutbox && (
        <section
          aria-labelledby={`${headingId}-outbox`}
          className={`mt-2 ${anythingAbove ? 'border-t border-hairline pt-2' : ''}`}
        >
          {/* Its counts change in place as the bookings go. */}
          <h3
            id={`${headingId}-outbox`}
            aria-live="polite"
            className="mb-1.5 truncate text-caption text-ink-2"
          >
            {outboxDay.heading}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {outboxDay.slots.map((slot) => (
              <li key={slot.key}>
                <JobBlock
                  job={slot.row}
                  timezone={timezone}
                  onOpen={onOpenJob}
                  initial={initials}
                  outbox={
                    slot.chip === null || !onOpenItem
                      ? undefined
                      : {
                          chip: slot.chip,
                          lineLive: outboxDay.lineLive,
                          onOpen: () => onOpenItem(slot.localId),
                        }
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}

/** The day's projected-visit number, worded for the kind of day it is. */
function RecurringToken({
  phase,
  count,
  businessSlug,
}: {
  phase: DayPhase
  count: number
  businessSlug: string
}) {
  if (phase === 'past') {
    return (
      <span
        className={`rounded-full px-2 text-[12px] font-semibold leading-5 ${OVERDUE_CHIP}`}
      >
        {count} overdue
      </span>
    )
  }

  const body = (
    <>
      <Repeat size={11} strokeWidth={2.4} aria-hidden />
      {count} {phase === 'today' ? 'due' : 'recurring'}
    </>
  )
  const token =
    'inline-flex items-center gap-1 rounded-md border border-dashed border-muted px-1.5 leading-5'

  // Ahead of its day a projection is not on any schedule; where it can be
  // seen and acted on is the Recurring Job view.
  return phase === 'future' ? (
    <Link
      to="/$businessSlug/job/recurring"
      params={{ businessSlug }}
      aria-label={`${count} recurring ${count === 1 ? 'visit' : 'visits'} not yet booked`}
      className={`${token} text-ink-2 underline-offset-2 hover:underline`}
    >
      {body}
    </Link>
  ) : (
    <span className={token}>{body}</span>
  )
}

/** A job in the week: the technician's colour as a tint and a rail, the time,
 * who and where, and the status in words. Opens the job. */
function JobBlock({
  job,
  timezone,
  onOpen,
  overdue = false,
  initial = false,
  outbox,
}: {
  job: JobRow
  timezone: string
  onOpen: (jobId: string) => void
  overdue?: boolean
  /** A booking on this phone, not sent yet: its chip where the status pill
   * goes, and its own sheet to open (plan part 2c §9.3). */
  outbox?: { chip: OutboxChipKind; lineLive: boolean; onOpen: () => void }
  /** The technician's initial beside the time. With two or more people in
   * the week, colour alone is not enough to tell their jobs apart (WCAG
   * 1.4.1) — some pairs merge for colour-blind readers — so the letter says
   * it too, and the team key above reads the letters. */
  initial?: boolean
}) {
  const projected = job.status === 'recurring'
  const people = everyoneOnJob(job)
  // Two circles at most, so the client's name keeps its room: past two
  // people, the lead's letter and how many more ("T +3"). Four letters left
  // "Karrat…" of a name on a phone. The card on the day names them all.
  const lettered = people.length > 2 ? people.slice(0, 1) : people
  const more = people.length - lettered.length
  return (
    <button
      type="button"
      onClick={() => (outbox ? outbox.onOpen() : onOpen(job._id))}
      className={`relative flex w-full items-start gap-2.5 overflow-hidden rounded-xl py-2 pr-2.5 pl-3.5 text-left transition active:scale-[.99] ${
        projected ? 'border border-dashed bg-surface' : ''
      }`}
      style={
        projected
          ? { borderColor: job.assigneeColour }
          : {
              backgroundColor: `color-mix(in srgb, ${job.assigneeColour} var(--block-tint), var(--surface))`,
            }
      }
    >
      {!projected && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1"
          style={{ backgroundColor: job.assigneeColour }}
        />
      )}
      {/* The lead's initial, and the other person's (or "+2" for more),
          overlapped: the block keeps the lead's colour, the letters say who
          else. */}
      {/* Always on a shared job: its block has the lead's colour alone, so
          only the letters say who else is going. */}
      {(initial || people.length > 1) && people.length > 0 && (
        <span aria-hidden className="mt-px flex shrink-0 -space-x-1.5">
          {lettered.map((person, i) => (
            <span
              key={`${person.name}-${i}`}
              className="flex size-5 items-center justify-center rounded-full border-2 bg-surface text-[11px] font-bold text-ink"
              style={{ borderColor: person.colour }}
            >
              {person.name.trim().charAt(0).toUpperCase()}
            </span>
          ))}
          {more > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-muted-2 bg-surface px-0.5 text-[10px] font-bold text-ink">
              +{more}
            </span>
          )}
        </span>
      )}
      <span className="w-[4.5rem] shrink-0 pt-px font-mono text-caption tabular-nums text-ink-2">
        {formatTime(job.scheduledAt, timezone)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-row-title text-ink">
          {job.clientName}
        </span>
        <span className="block truncate text-caption text-ink-2">
          {job.jobType} · {job.suburb}
        </span>
        {people.length > 0 && (
          <span className="sr-only">
            , {people.length > 1 ? 'technicians' : 'technician'}{' '}
            {namesOf(people)}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {/* A ring of card surface around the pill, so its edge holds against
            the technician's tint the way it does on a white card. */}
        <span className="inline-flex rounded-full bg-surface p-px">
          {outbox ? (
            <OutboxChip chip={outbox.chip} lineLive={outbox.lineLive} />
          ) : (
            <StatusPill status={job.status} />
          )}
        </span>
        {overdue && (
          <span
            className={`rounded-full px-2 text-[11px] font-semibold leading-4 ${OVERDUE_CHIP}`}
          >
            Overdue
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * Brings the focused day into view: when the week first opens on a day other
 * than its Monday, and whenever a day is picked on the strip or grid.
 * Measured against whatever sticky chrome covers the top of the page — the
 * page header, and the week strip (`data-schedule-chrome`) if it is sticky,
 * which it no longer is — so the day's heading lands just under it rather
 * than behind it. Not before the days above have drawn the bookings on this
 * phone they will (`settled`, `useOutboxSettled`), which would push it down.
 */
function useScrollToDay(
  focusKey: string,
  weekStart: string,
  tick: number,
  settled: boolean,
) {
  const first = useRef(true)
  useEffect(() => {
    if (!settled) return
    const isFirst = first.current
    first.current = false
    // On arrival: nothing to do on the week's own Monday, and nothing when
    // the router has just put the reader back where they were (Back from a
    // day opened here) — that position is theirs, not ours to move.
    if (isFirst && (focusKey === weekStart || window.scrollY > 0)) return

    const section = document.getElementById(`week-day-${focusKey}`)
    if (!section) return
    const covers = Array.from(
      document.querySelectorAll('header, [data-schedule-chrome]'),
    ).filter((el) => getComputedStyle(el).position === 'sticky')
    const offset = Math.max(
      0,
      ...covers.map((el) => el.getBoundingClientRect().bottom),
    )
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({
      top: section.getBoundingClientRect().top + window.scrollY - offset - 8,
      behavior: isFirst || reduce ? 'auto' : 'smooth',
    })
  }, [focusKey, weekStart, tick, settled])
}
