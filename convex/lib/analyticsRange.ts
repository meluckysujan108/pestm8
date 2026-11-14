import { addDaysToKey } from './dates'

/**
 * The dates behind the Analytics page: the range someone picked, the range it
 * is compared with, and how the range is cut into points on a chart.
 *
 * All of it is day keys ("2026-11-11") in the business's own calendar, and
 * none of it reads a clock: the page says which days, so the same question
 * always has the same answer (and a query's answer can be cached).
 */

/** The longest range one question may cover, in days: a leap year. A year
 * compared with the year before is two of these read, and no more. */
export const MAX_RANGE_DAYS = 366

export type Compare = 'previous' | 'year' | 'none'

/** How a range is cut up for the chart. */
export type Grain = 'day' | 'week' | 'month'

export type DayRange = { from: string; to: string }

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar day, written as a day key. "2026-02-30" is not one. */
export function isRealDayKey(value: string): boolean {
  if (!DAY_KEY.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day))
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  )
}

/** Whole days from one day key to another: 0 for the same day. */
export function daysBetween(fromKey: string, toKey: string): number {
  const at = (key: string) => {
    const [year, month, day] = key.split('-').map(Number)
    return Date.UTC(year, month - 1, day)
  }
  return Math.round((at(toKey) - at(fromKey)) / 86_400_000)
}

/** How many days a range covers, both ends counted. */
export function rangeDays(range: DayRange): number {
  return daysBetween(range.from, range.to) + 1
}

/** A range that can be asked for: real days, in order, no longer than a year. */
export function isValidRange(range: DayRange): boolean {
  if (!isRealDayKey(range.from) || !isRealDayKey(range.to)) return false
  const days = rangeDays(range)
  return days >= 1 && days <= MAX_RANGE_DAYS
}

/** The same day a year earlier; 29 February becomes the 28th. */
function yearBefore(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number)
  const before = String(year - 1).padStart(4, '0')
  const candidate = `${before}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return isRealDayKey(candidate) ? candidate : `${before}-02-28`
}

/**
 * The range a range is compared with: as many days straight before it, or
 * the same dates a year earlier.
 */
export function comparisonRange(
  range: DayRange,
  compare: Compare,
): DayRange | null {
  if (compare === 'none') return null
  if (compare === 'year')
    return { from: yearBefore(range.from), to: yearBefore(range.to) }
  const days = rangeDays(range)
  return {
    from: addDaysToKey(range.from, -days),
    to: addDaysToKey(range.from, -1),
  }
}

/**
 * A point a day up to a month, a point a week up to four months, then a
 * point a calendar month: about thirty points at most, which is what a
 * phone's width can show.
 */
export function grainFor(days: number): Grain {
  if (days <= 31) return 'day'
  if (days <= 124) return 'week'
  return 'month'
}

/** Months from one day key's month to another's. */
function monthsBetween(fromKey: string, toKey: string): number {
  const [fromYear, fromMonth] = fromKey.split('-').map(Number)
  const [toYear, toMonth] = toKey.split('-').map(Number)
  return (toYear - fromYear) * 12 + (toMonth - fromMonth)
}

/**
 * Which point of a range's chart a day belongs to, counted from the range's
 * first day. Days and weeks are counted from that first day, not from a
 * Monday, so a range and the range before it cut into the same points.
 */
export function bucketIndex(
  range: DayRange,
  grain: Grain,
  dayKey: string,
): number {
  if (grain === 'month') return monthsBetween(range.from, dayKey)
  const days = daysBetween(range.from, dayKey)
  return grain === 'day' ? days : Math.floor(days / 7)
}

/** The first day of each point of a range's chart, in order. */
export function bucketStarts(range: DayRange, grain: Grain): Array<string> {
  if (grain === 'month') {
    const count = monthsBetween(range.from, range.to) + 1
    return Array.from({ length: count }, (_, i) => {
      if (i === 0) return range.from
      const [year, month] = range.from.split('-').map(Number)
      const total = year * 12 + (month - 1) + i
      return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`
    })
  }
  const step = grain === 'day' ? 1 : 7
  const count = Math.ceil(rangeDays(range) / step)
  return Array.from({ length: count }, (_, i) =>
    addDaysToKey(range.from, i * step),
  )
}

/** Finished work is "old" once it has waited longer than this, in days: the
 * page points it out. */
export const OLD_AFTER_DAYS = 14
