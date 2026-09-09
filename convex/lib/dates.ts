/**
 * Tenant-timezone helpers. Every business has its own timezone (§4.2) and most
 * are not Australia/Perth, so day boundaries must be computed in the tenant's
 * zone rather than the server's or the viewer's.
 */

/**
 * Milliseconds since epoch for a given wall-clock date + time of day, as seen
 * in `timezone` — the general form `startOfDayInZone` (below) is built on.
 * Used both for day boundaries (hh=mm=0) and for converting a job's edited
 * date/time inputs back into an instant in the tenant's own zone, not the
 * viewer's browser zone.
 */
export function zonedDateTimeToUtc(
  dayKey: string,
  hh: number,
  mm: number,
  timezone: string,
): number {
  const [year, month, day] = dayKey.split('-').map(Number)

  // Guess at UTC, then correct by the zone's offset at that instant. Two passes
  // settle DST boundaries, which matter for every state except WA and QLD.
  let ts = Date.UTC(year, month - 1, day, hh, mm, 0, 0)
  for (let i = 0; i < 2; i++) {
    ts = Date.UTC(year, month - 1, day, hh, mm, 0, 0) - offsetMs(ts, timezone)
    const [checkDay, checkTime] = [dayKeyOf(ts, timezone), timeKeyOf(ts, timezone)]
    if (checkDay === dayKey && checkTime === `${pad(hh)}:${pad(mm)}`) break
  }
  return ts
}

/** Milliseconds since epoch for the start of the given local day in `timezone`. */
export function startOfDayInZone(dayKey: string, timezone: string): number {
  return zonedDateTimeToUtc(dayKey, 0, 0, timezone)
}

export function endOfDayInZone(dayKey: string, timezone: string): number {
  return startOfDayInZone(dayKey, timezone) + 24 * 60 * 60 * 1000
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "YYYY-MM-DD" for an instant, as seen in `timezone`. */
export function dayKeyOf(ts: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts))

  const get = (type: string) => parts.find((p) => p.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** "HH:MM" (24-hour) for an instant, as seen in `timezone`. */
export function timeKeyOf(ts: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts))

  const get = (type: string) => parts.find((p) => p.type === type)!.value
  return `${get('hour')}:${get('minute')}`
}

function offsetMs(ts: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts))

  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUtc - ts
}

export function todayKeyInZone(timezone: string): string {
  return dayKeyOf(Date.now(), timezone)
}

export function addDaysToKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Monday-based week start, matching the design file's week strip. */
export function startOfWeekKey(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day))
  const weekday = (d.getUTCDay() + 6) % 7
  return addDaysToKey(dayKey, -weekday)
}
