/**
 * What is booked at a site, as the double-booking check reads it: on the
 * phone from its kept copy of `jobs.openWork` before Book, and on the server
 * when a booking saves or a phone sends one it kept. One rule, so the phone
 * and the server never disagree about what counts. Pure and browser-safe.
 */
import { addDaysToKey, dayKeyOf } from './dates'

/** Work still to happen: booked by someone, or projected by the engine. */
export const OPEN_STATUSES = ['pending', 'booked', 'recurring'] as const

export type OpenStatus = (typeof OPEN_STATUSES)[number]

export function isOpenStatus(status: string): status is OpenStatus {
  return (OPEN_STATUSES as ReadonlyArray<string>).includes(status)
}

/**
 * The slot a job or visit holds: for a Recurring Job's visit, the instant the
 * engine projected it onto, which stays its own when the visit is moved
 * (schema.ts `occurrenceAt`); otherwise when it is booked. A booking says
 * which slots it was shown by these, so a visit the office moves, or one the
 * engine projects again, is still the one that was seen.
 */
export function slotOf(job: {
  scheduledAt: number
  occurrenceAt?: number
}): number {
  return job.occurrenceAt ?? job.scheduledAt
}

/**
 * How near another booking at the same site has to be for it to be shown:
 * a week either side, by the business's calendar (the owner's answer,
 * 27 Oct 2026). Wider warns about routine repeat work; narrower misses
 * "booked Thursday, booked again Monday".
 */
export const SITE_WINDOW_DAYS = 7

/**
 * How far `jobs.openWork` reaches from the week asked for: four weeks back,
 * for the last visit (a warranty callback is common), and sixteen ahead.
 */
export const OPEN_WORK_DAYS_BACK = 28
export const OPEN_WORK_DAYS_AHEAD = 112

/**
 * Most jobs, and most Recurring Jobs, `jobs.openWork` reads. Past it the
 * answer says `capped` rather than failing: a query may read 32,000
 * documents and return 8,192 rows in a list. The largest business today
 * has under two hundred jobs in all.
 */
export const OPEN_WORK_LIMIT = 6000

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/**
 * How far any time zone's day starts ahead of UTC's (UTC+14, Kiribati), and
 * ends behind it (UTC−12). `openWorkSpan` reads that much either side of the
 * business's own days, so it never needs to know which zone it is in.
 */
const ZONE_AHEAD_MS = 14 * HOUR_MS
const ZONE_BEHIND_MS = 12 * HOUR_MS

/** "YYYY-MM-DD" as UTC midnight, the calendar's arithmetic only. */
function utcMidnight(dayKey: string): number {
  const [year, month, day] = dayKey.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

/** Whether `value` is a day that exists, written "YYYY-MM-DD". */
export function isDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

/**
 * The business's own days a `jobs.openWork` answer is whole for: from
 * `firstKey` up to, not including, `endKey`. The phone asks whether an
 * answer covers a booking's date by these (`openWorkCovers`), so last
 * week's answer still checks a Monday opened with no signal.
 */
export function openWorkDays(startKey: string): {
  firstKey: string
  endKey: string
} {
  return {
    firstKey: addDaysToKey(startKey, -OPEN_WORK_DAYS_BACK),
    endKey: addDaysToKey(startKey, OPEN_WORK_DAYS_AHEAD),
  }
}

/** Whether the answer asked for with `startKey` covers the day `dayKey`. */
export function openWorkCovers(startKey: string, dayKey: string): boolean {
  const { firstKey, endKey } = openWorkDays(startKey)
  return dayKey >= firstKey && dayKey < endKey
}

/**
 * The instants `jobs.openWork` reads: from the first moment `firstKey`
 * begins in any time zone to the last moment `endKey` begins in any, so
 * every day of `openWorkDays` is whole wherever the business is. It reads up
 * to 26 hours more at either end, which the phone, going by each row's date
 * in the business's zone, never counts on.
 *
 * That way the query needs no time zone, and so never reads the business's
 * row, which every booking, Recurring Job visit and numbered report patches:
 * a query that read it would run again for every member each time.
 * `weekFrom` is where `startKey` itself can first begin.
 */
export function openWorkSpan(startKey: string): {
  from: number
  weekFrom: number
  to: number
} {
  const { firstKey, endKey } = openWorkDays(startKey)
  return {
    from: utcMidnight(firstKey) - ZONE_AHEAD_MS,
    weekFrom: utcMidnight(startKey) - ZONE_AHEAD_MS,
    to: utcMidnight(endKey) + ZONE_BEHIND_MS,
  }
}

/** Days since 1 Jan 1970 of the day `at` falls on in `timezone`. */
function dayNumber(at: number, timezone: string): number {
  return Math.round(utcMidnight(dayKeyOf(at, timezone)) / DAY_MS)
}

/**
 * The open work among `rows` within SITE_WINDOW_DAYS of `at`, either side
 * and inclusive, by the days of the business's calendar (`timezone`), not
 * by hours: a job at 4pm next Thursday is a week from a booking at 8am this
 * Thursday.
 * Nearest first, the earlier of two as near.
 *
 * A row with no `status` is someone else's (`jobs.openWork` sends only open
 * work of theirs, and no status), so it counts as open. Each row is judged
 * by when it is booked, not by its slot: a visit moved to Friday is at the
 * door on Friday.
 */
export function openNear<T extends { scheduledAt: number; status?: string }>(
  rows: ReadonlyArray<T>,
  at: number,
  timezone: string,
): Array<T> {
  const day = dayNumber(at, timezone)
  return rows
    .filter((row) => row.status === undefined || isOpenStatus(row.status))
    .filter(
      (row) =>
        Math.abs(dayNumber(row.scheduledAt, timezone) - day) <=
        SITE_WINDOW_DAYS,
    )
    .sort(
      (a, b) =>
        Math.abs(a.scheduledAt - at) - Math.abs(b.scheduledAt - at) ||
        a.scheduledAt - b.scheduledAt,
    )
}
