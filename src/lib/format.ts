import { dateTimeFormat, dayKeyOf } from '../../convex/lib/dates'

/**
 * Cents in, dollars out. Money is stored as integer cents everywhere (§4.2).
 *
 * `null` means the server withheld the figure because this person cannot see
 * prices, and an em dash is the honest rendering of that. It is not the same
 * as zero, which is a real answer — and it is certainly not "$NaN", which is
 * what this produced for an absent value before the null case existed.
 */
export function formatMoney(cents: number | null): string {
  if (cents === null) return '—'
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

export function formatTime(ts: number, timezone: string): string {
  return dateTimeFormat('en-AU', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(ts))
    .replace(/\s?([ap])m/i, (_, p) => p.toLowerCase() + 'm')
}

/**
 * "Fri 25 Sept" — the day a job is booked for, as the job card and its sheet
 * say it, with the year added when it is not this year ("Fri 25 Sept 2027").
 *
 * Built from the tenant's day key, never from the device's clock or time
 * zone, so the server render and the phone always agree. Deliberately no
 * "Today" or "Tomorrow": a card left open past midnight would keep saying the
 * wrong one. `thisDayKey` (today's key, in the tenant's zone) only decides
 * whether the year needs saying.
 */
export function formatJobDate(dayKey: string, thisDayKey: string): string {
  const parts = dateTimeFormat('en-AU', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(dayKeyToDate(dayKey))
  // Assembled from the parts: en-AU puts a comma after the weekday.
  const part = (type: string) => parts.find((p) => p.type === type)?.value
  const date = `${part('weekday')} ${part('day')} ${part('month')}`
  const year = dayKey.slice(0, 4)
  return year === thisDayKey.slice(0, 4) ? date : `${date} ${year}`
}

/**
 * "Fri 25 Sept, 9:30am" — the moment something happened (a report sent, an
 * entry in its history), in the tenant's time zone, with the year only when
 * it is not this year.
 */
export function formatWhen(ts: number, timezone: string): string {
  return `${formatJobDate(dayKeyOf(ts, timezone), todayKey(timezone))}, ${formatTime(ts, timezone)}`
}

/**
 * "9:30am – 10:15am · 45 min", or "11:00pm – Sat 1:00am · 2 hr" when the job
 * runs past midnight, in the tenant's time zone. An end exactly at midnight
 * still belongs to the day it ends, so it reads "12:00am" with no weekday.
 */
export function formatTimeRange(
  start: number,
  durationMinutes: number,
  timezone: string,
): string {
  const end = start + durationMinutes * 60_000
  const endDay = dayKeyOf(Math.max(start, end - 1), timezone)
  const endLabel =
    endDay === dayKeyOf(start, timezone)
      ? formatTime(end, timezone)
      : `${formatShortWeekday(endDay)} ${formatTime(end, timezone)}`
  return `${formatTime(start, timezone)} – ${endLabel} · ${formatDuration(durationMinutes)}`
}

function formatShortWeekday(dayKey: string): string {
  return dateTimeFormat('en-AU', {
    timeZone: 'UTC',
    weekday: 'short',
  }).format(dayKeyToDate(dayKey))
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

/** "YYYY-MM-DD" for today in the tenant's timezone. */
export function todayKey(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export function dayKeyToDate(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

export function addDaysToKey(dayKey: string, days: number): string {
  const d = dayKeyToDate(dayKey)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Monday-based, matching the design file's week strip. */
export function startOfWeekKey(dayKey: string): string {
  const weekday = (dayKeyToDate(dayKey).getUTCDay() + 6) % 7
  return addDaysToKey(dayKey, -weekday)
}

export function formatDayLabel(dayKey: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(dayKeyToDate(dayKey))
}

/** "Mon 21" — a day heading inside a week, where the month is already said. */
export function formatShortDayLabel(dayKey: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
  }).format(dayKeyToDate(dayKey))
}

/**
 * "21–27 September", or "28 September – 4 October" across a month, or with
 * both years across a year — a week named the way it would be said.
 */
export function formatWeekRange(startKey: string): string {
  const endKey = addDaysToKey(startKey, 6)
  const [start, end] = [startKey, endKey].map(dayKeyToDate)
  const part = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', ...opts }).format(d)

  if (startKey.slice(0, 4) !== endKey.slice(0, 4)) {
    const full = { day: 'numeric', month: 'long', year: 'numeric' } as const
    return `${part(start, full)} – ${part(end, full)}`
  }
  if (startKey.slice(0, 7) !== endKey.slice(0, 7)) {
    const dayMonth = { day: 'numeric', month: 'long' } as const
    return `${part(start, dayMonth)} – ${part(end, dayMonth)}`
  }
  return `${part(start, { day: 'numeric' })}–${part(end, { day: 'numeric', month: 'long' })}`
}

export function formatMonthLabel(dayKey: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(dayKeyToDate(dayKey))
}

export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

// The four fixed repeat intervals that used to live here are gone: a
// Recurring Job now repeats on any number of days, weeks, months or years.
// `describeInterval`/`describeRepeat` in convex/lib/recurrence.ts render one,
// and `RecurrenceFields` collects one.

export const JOB_TYPES = [
  'General Pest Control',
  'Rodents',
  'Termite Inspection',
  'Termite Treatment',
  'Ants',
  'Cockroaches',
  'Spiders',
  'Bed Bugs',
  'Wasps',
] as const

/**
 * A job's price, or an em dash when the server withheld it.
 *
 * The row carries `pricesHidden` alongside a zeroed `price`, because dropping
 * the key renders "$NaN" and seeds an edit form with the string "NaN" — which
 * is truthy, so its `|| '0'` fallback never fires and the real figure gets
 * overwritten. Zero plus a flag degrades to a harmless "$0" on a client that
 * has not been taught the flag, and to this on one that has.
 */
export function formatJobMoney(job: {
  price: number
  pricesHidden?: boolean
}): string {
  return job.pricesHidden ? '—' : formatMoney(job.price)
}
