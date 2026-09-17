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

export type RepeatValue =
  'once' | 'monthly' | 'quarterly' | 'sixMonthly' | 'yearly'

/** Intervals a pest control business actually sells. */
export const REPEAT_OPTIONS: Array<{ value: RepeatValue; label: string }> = [
  { value: 'once', label: 'One-off' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'sixMonthly', label: 'Every 6 months' },
  { value: 'yearly', label: 'Yearly' },
]

export const REPEAT_LABELS: Record<string, string> = {
  monthly: 'Repeats monthly',
  quarterly: 'Repeats quarterly',
  sixMonthly: 'Repeats every 6 months',
  yearly: 'Repeats yearly',
}

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
