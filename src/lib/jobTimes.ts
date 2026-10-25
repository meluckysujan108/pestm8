import { zonedDateTimeToUtc } from '../../convex/lib/dates'

/**
 * A job's time as New Job and a job's edit form ask for it: a start and an
 * end, each a time of day on the job's date, picked the same way. The server
 * keeps an instant and a length (`scheduledAt`, `durationMinutes`); these
 * turn one into the other.
 *
 * The length was a Minutes box until 25 Oct 2026, so a job of a few hours had
 * to be worked out in minutes first, and a morning's work typed as 400 was
 * refused for not being a multiple of 15.
 */

const DAY_MINUTES = 24 * 60

/** Whether a date input's value is a day ("2026-10-26"), not '' while it is
 * being cleared or retyped. */
export function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/**
 * Minutes past midnight for an `<input type="time">` value ("09:30", or with
 * the seconds a browser may add), or null for an empty or cleared one.
 */
export function minutesOfDay(time: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(time)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** "HH:MM", as a time input holds it, for minutes past midnight. */
export function timeOfDay(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/**
 * The end that keeps a job `length` minutes long from `start`: where the end
 * goes as the start moves, until someone sets the end themselves. Past
 * midnight it reads as the clock would, the next morning, which
 * `lengthBetween` then refuses: the form says so, rather than leaving the end
 * behind where it last fitted. Null with no start, or no length to keep.
 */
export function endAfter(start: string, length: number): string | null {
  const from = minutesOfDay(start)
  if (from === null || length <= 0) return null
  // The server keeps any number, and a time input holds whole minutes.
  return timeOfDay((from + Math.round(length)) % DAY_MINUTES)
}

/**
 * How long a job from `start` to `end` on `dayKey` is, in minutes; null when
 * either is empty or the end is not after the start, since a job ends on the
 * day it starts.
 *
 * Measured between the two instants in the business's zone rather than
 * between the two readings, so a job across a clock change is as long as it
 * really is, and reads back as the times that were picked. With no day yet
 * (its field cleared, to be refused at Book or Save), as the clock reads.
 */
export function lengthBetween(
  dayKey: string,
  start: string,
  end: string,
  timezone: string,
): number | null {
  const from = minutesOfDay(start)
  const to = minutesOfDay(end)
  if (from === null || to === null || to <= from) return null
  if (!isDayKey(dayKey)) return to - from
  const at = (minutes: number) =>
    zonedDateTimeToUtc(dayKey, Math.floor(minutes / 60), minutes % 60, timezone)
  // A start inside the hour the clocks skip is moved past it, and can land
  // after an end picked just beyond it.
  const length = Math.round((at(to) - at(from)) / 60_000)
  return length > 0 ? length : null
}
