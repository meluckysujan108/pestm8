/** Cents in, dollars out. Money is stored as integer cents everywhere (§4.2). */
export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

export function formatTime(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(ts))
    .replace(/\s?([ap])m/i, (_, p) => p.toLowerCase() + 'm')
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

export function formatMonthLabel(dayKey: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(dayKeyToDate(dayKey))
}

export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

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
