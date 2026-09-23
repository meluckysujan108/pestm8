import { dayKeyOf } from '../../convex/lib/dates'
import { addDaysToKey } from './format'
import type { JobStatus } from '../../convex/lib/jobStatus'

/**
 * The Schedule's Week View (Phase 4.4), as pure functions — what the
 * component draws, decided where a test can reach it.
 *
 * Two numbers per day, never one: booked work, and projected visits. A
 * projected visit is work nobody has agreed to, so it is in no job total
 * anywhere (convex/jobs.ts `listWeek`), and nothing here adds the two.
 */

export function weekDayKeys(startKey: string): Array<string> {
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(startKey, i))
}

export type DayPhase = 'past' | 'today' | 'future'

/** Whether a day has arrived — the difference between a projection that is
 * overdue, one that is due, and one that is simply ahead. */
export function dayPhase(dayKey: string, todayKey: string): DayPhase {
  if (dayKey < todayKey) return 'past'
  if (dayKey === todayKey) return 'today'
  return 'future'
}

/**
 * A day's rows from `listDay`, split three ways:
 * - `committed`: booked work (listDay never returns a cancelled job);
 * - `dueHere`: projections that fall on this day;
 * - `carried`: projections from earlier days that `listDay` carries onto
 *   today, so a missed visit is not left behind on its own day.
 * Disjoint, and together exactly the rows given.
 */
export function splitDayRows<
  T extends { status: JobStatus; scheduledAt: number },
>(
  rows: Array<T>,
  dayKey: string,
  timezone: string,
): { committed: Array<T>; dueHere: Array<T>; carried: Array<T> } {
  const committed: Array<T> = []
  const dueHere: Array<T> = []
  const carried: Array<T> = []
  for (const row of rows) {
    if (row.status !== 'recurring') committed.push(row)
    else if (dayKeyOf(row.scheduledAt, timezone) === dayKey) dueHere.push(row)
    else carried.push(row)
  }
  return { committed, dueHere, carried }
}

/**
 * Of the visits `listDay` carries onto today, the ones the week does not
 * already show: those from before it began. A missed visit from earlier this
 * week is on its own day in the week, marked overdue, so counting it again
 * on today would show one missed visit as two.
 */
export function carriedFromBefore<T extends { scheduledAt: number }>(
  carried: Array<T>,
  weekStart: string,
  timezone: string,
): Array<T> {
  return carried.filter(
    (row) => dayKeyOf(row.scheduledAt, timezone) < weekStart,
  )
}

/** The week's two totals, side by side. */
export function weekTotals(
  days: Array<{ count: number; recurringCount?: number }>,
): { jobs: number; recurring: number } {
  return {
    jobs: days.reduce((n, d) => n + d.count, 0),
    recurring: days.reduce((n, d) => n + (d.recurringCount ?? 0), 0),
  }
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/**
 * What a day holds, as a sentence for a screen reader — the week strip's
 * cell is a date and two small numbers, which read aloud as "21, 3, 2".
 */
export function describeDayLoad(
  day: { count: number; recurringCount?: number },
  phase: DayPhase,
): string {
  const parts = [plural(day.count, 'job', 'jobs')]
  const recurring = day.recurringCount ?? 0
  if (recurring > 0) {
    const visits = plural(recurring, 'recurring visit', 'recurring visits')
    parts.push(
      phase === 'past'
        ? `${visits} overdue`
        : phase === 'today'
          ? `${visits} due`
          : `${visits} not yet booked`,
    )
  }
  return parts.join(', ')
}
