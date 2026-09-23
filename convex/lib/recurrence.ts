import { ConvexError } from 'convex/values'
import { dayKeyOf, timeKeyOf, zonedDateTimeToUtc } from './dates'
import type { Doc } from '../_generated/dataModel'

/**
 * How often a Recurring Job repeats: any whole number of days, weeks, months
 * or years.
 *
 * This replaced a fixed enum (`monthly` | `quarterly` | `sixMonthly` |
 * `yearly`). The enum was not a simplification of the real world — a business
 * sells a fortnightly rodent program, a 15-year termite warranty inspection,
 * a one-week follow-up treatment — and none of those could be booked. Rows
 * written before the change are read through `intervalOf`, which maps the old
 * four onto the same {count, unit} shape, so nothing in this file needs to
 * know whether a series predates the migration.
 */
export type IntervalUnit = 'day' | 'week' | 'month' | 'year'

/**
 * How far ahead the engine projects visits. Long enough to plan a quarter.
 *
 * Lives here rather than beside the engine because the Recurring Job view
 * needs it too: it bounds the scan for projected visits, and it is the reason
 * that view counts series rather than visits. A window in TIME, not a number
 * of visits — a series repeating every 15 years has no projected visit at all
 * until its next one falls inside it.
 */
export const HORIZON_DAYS = 180

export type Interval = { count: number; unit: IntervalUnit }

export const INTERVAL_UNITS: ReadonlyArray<IntervalUnit> = [
  'day',
  'week',
  'month',
  'year',
]

/**
 * An upper bound on the number itself, not on what it means: "every 500
 * years" is not a contract anyone sells, and a fat-fingered 99999 would other-
 * wise be stored and then quietly never produce a visit. Generous on purpose —
 * the point is to catch a typo, not to have an opinion about the business.
 */
export const MAX_INTERVAL_COUNT = 500

/** The four intervals the app sold before custom ones existed. */
const LEGACY_FREQUENCY: Record<string, Interval> = {
  monthly: { count: 1, unit: 'month' },
  quarterly: { count: 3, unit: 'month' },
  sixMonthly: { count: 6, unit: 'month' },
  yearly: { count: 1, unit: 'year' },
}

/**
 * The interval a stored series repeats on.
 *
 * Reads the new fields, falling back to the retired `frequency` enum, so this
 * is correct on both sides of convex/migrations/recurringIntervalV1.ts — and
 * stays correct for a row the backfill somehow missed. A series carrying
 * neither is treated as monthly rather than throwing: the alternative is a
 * query that dies for everyone because one row is malformed.
 */
export function intervalOf(
  recurrence: Pick<
    Doc<'recurrences'>,
    'intervalCount' | 'intervalUnit' | 'frequency'
  >,
): Interval {
  if (recurrence.intervalCount !== undefined && recurrence.intervalUnit) {
    return { count: recurrence.intervalCount, unit: recurrence.intervalUnit }
  }
  return (
    (recurrence.frequency && LEGACY_FREQUENCY[recurrence.frequency]) ?? {
      count: 1,
      unit: 'month',
    }
  )
}

/**
 * Refuses an interval that cannot describe a repeat. Called on every write
 * path, because `v.number()` admits 0, -3 and 2.5 and each of those makes
 * `occurrencesFrom` either loop forever or return the anchor over and over.
 */
export function assertInterval(interval: Interval): void {
  const { count } = interval
  if (!Number.isInteger(count) || count < 1 || count > MAX_INTERVAL_COUNT) {
    throw new ConvexError('INVALID_INTERVAL')
  }
}

/** Calendar parts of an instant as the tenant sees it, plus its wall time. */
function localPartsOf(ts: number, timezone: string) {
  const [year, month, day] = dayKeyOf(ts, timezone).split('-').map(Number)
  const [hh, mm] = timeKeyOf(ts, timezone).split(':').map(Number)
  return { year, month, day, hh, mm }
}

/** A pure calendar cursor — `Date.UTC` used as arithmetic, not as a timezone. */
function calendarDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

function keyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/**
 * The occurrences of a series that fall inside a window, as instants.
 *
 * Two things this gets right that a naive walk does not:
 *
 * STEPS ON THE TENANT'S CALENDAR, not the server's. Convex runs in UTC, so
 * stepping a raw `Date` preserves the UTC day-of-month — and a Perth job at
 * 07:00 local is 23:00Z the day BEFORE. A monthly service booked for the 1st
 * would be stored as UTC the 28th/29th/30th/31st, and the first short month
 * would clamp it there permanently: 1 Mar, then 29 Mar, 29 Apr, 29 May, never
 * the 1st again. So the walk is done on the tenant's own calendar and each
 * occurrence is converted back through `zonedDateTimeToUtc`, which also keeps
 * the wall-clock time steady across a DST transition rather than sliding an
 * hour. Days and weeks step by calendar days, months and years by calendar
 * months, so a quarterly on the 15th stays on the 15th and a weekly stays on
 * its weekday.
 *
 * STARTS AT THE WINDOW, not at the anchor. `limit` bounds the work of one
 * call; if the walk always began at the anchor, those iterations would be
 * spent on occurrences long past — a daily series would under-fill its horizon
 * within a year of being booked and, once the anchor was `limit` days old,
 * project nothing at all, for ever, with no error anywhere. The first
 * occurrence at or after `from` is found by arithmetic instead, so the cost of
 * a call depends on the window and not on how old the series is.
 */
export function occurrencesFrom(
  anchorDate: number,
  interval: Interval,
  opts: {
    /** The tenant's timezone — the calendar the series actually repeats on. */
    timezone: string
    /** Inclusive lower bound; occurrences before it are not returned. */
    from: number
    /** Inclusive upper bound. */
    until: number
    /** Most occurrences to return. */
    limit?: number
  },
): Array<number> {
  assertInterval(interval)

  const { timezone, from, until, limit = 400 } = opts
  if (until < from || limit < 1) return []

  const { count, unit } = interval
  const anchor = localPartsOf(anchorDate, timezone)

  // A year is twelve months of the same clamping rule, so 29 Feb behaves like
  // the 31st of a short month rather than rolling into 1 March.
  const months = unit === 'month' ? count : unit === 'year' ? count * 12 : 0
  const days = unit === 'day' ? count : unit === 'week' ? count * 7 : 0

  const at = (i: number): number => {
    // The anchor is returned verbatim, never round-tripped. `zonedDateTimeToUtc`
    // works to the minute, so an anchor carrying seconds would come back a few
    // hundred milliseconds off — and the engine identifies an occurrence by
    // exact instant, so the visit booked by hand at the anchor would stop
    // matching occurrence 0 and be projected a second time.
    if (i === 0) return anchorDate
    const d = calendarDate(anchor.year, anchor.month, anchor.day)
    if (months > 0) {
      d.setUTCMonth(d.getUTCMonth() + months * i)
      // Clamp to the last valid day: the 31st does not exist in every month,
      // and the cursor would otherwise roll a 31 Jan quarterly into 3 May.
      if (d.getUTCDate() !== anchor.day) d.setUTCDate(0)
    } else {
      d.setUTCDate(d.getUTCDate() + days * i)
    }
    return zonedDateTimeToUtc(keyOf(d), anchor.hh, anchor.mm, timezone)
  }

  // Jump to the window. Approximate from the calendar difference, then walk
  // the last step or two exactly — clamping and DST both make the estimate
  // off by at most one, and correcting is cheaper than trusting it.
  const target = localPartsOf(from, timezone)
  let i =
    months > 0
      ? Math.floor(
          ((target.year - anchor.year) * 12 + (target.month - anchor.month)) /
            months,
        )
      : Math.floor(
          (calendarDate(target.year, target.month, target.day).getTime() -
            calendarDate(anchor.year, anchor.month, anchor.day).getTime()) /
            (days * 24 * 60 * 60 * 1000),
        )
  if (i < 0) i = 0
  // Bounded on purpose. The estimate is off by at most one step in practice,
  // but it is arithmetic over user-supplied numbers and a correction loop with
  // no ceiling is a hang waiting for a value nobody predicted.
  const SLACK = 8
  for (let n = 0; n < SLACK && i > 0 && at(i - 1) >= from; n++) i--
  for (let n = 0; n < SLACK && at(i) < from; n++) i++

  const out: Array<number> = []
  for (; out.length < limit; i++) {
    const ts = at(i)
    if (ts > until) break
    out.push(ts)
  }
  return out
}

const UNIT_NOUN: Record<IntervalUnit, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
}

/**
 * "Every day", "Every 2 weeks", "Every 15 years" — one phrasing for every
 * interval, rather than special-casing the four that used to have names.
 * "Every 3 months" is plainer than "Quarterly" on a job card anyway, and it
 * does not leave the custom intervals reading like second-class citizens.
 */
export function describeInterval(interval: Interval): string {
  const { count, unit } = interval
  const noun = UNIT_NOUN[unit]
  return count === 1 ? `Every ${noun}` : `Every ${count} ${noun}s`
}

/** The same phrase as a sentence about a job, for the detail sheet. */
export function describeRepeat(interval: Interval): string {
  return `Repeats ${describeInterval(interval).toLowerCase()}`
}
