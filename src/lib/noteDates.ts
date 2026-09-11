import { addDaysToKey, formatTime } from './format'

function dayKeyOf(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

/**
 * The phone's Notes list sections: Today, Yesterday, Previous 7 Days,
 * Previous 30 Days, then one section per month. Keys sort in display order.
 */
export function noteGroupOf(ts: number, timezone: string, now: number): string {
  const today = dayKeyOf(now, timezone)
  const day = dayKeyOf(ts, timezone)
  if (day >= today) return '0|Today'
  if (day === addDaysToKey(today, -1)) return '1|Yesterday'
  if (day > addDaysToKey(today, -7)) return '2|Previous 7 Days'
  if (day > addDaysToKey(today, -30)) return '3|Previous 30 Days'
  const label = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    month: 'long',
    year: 'numeric',
  }).format(new Date(ts))
  // Later months sort first; the key only needs to be monotonic.
  return `4|${9999 - Number(day.slice(0, 4))}${99 - Number(day.slice(5, 7))}|${label}`
}

export function noteGroupLabel(key: string): string {
  return key.slice(key.lastIndexOf('|') + 1)
}

/** "2:14pm" today, a weekday this week, otherwise a short date. */
export function editedLabel(ts: number, timezone: string, now: number): string {
  const today = dayKeyOf(now, timezone)
  const day = dayKeyOf(ts, timezone)
  if (day === today) return formatTime(ts, timezone)
  if (day === addDaysToKey(today, -1)) return 'Yesterday'
  const opts: Intl.DateTimeFormatOptions =
    day > addDaysToKey(today, -7)
      ? { weekday: 'long' }
      : day.slice(0, 4) === today.slice(0, 4)
        ? { day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' }
  return new Intl.DateTimeFormat('en-AU', { timeZone: timezone, ...opts }).format(new Date(ts))
}
