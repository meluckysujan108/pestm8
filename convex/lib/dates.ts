/**
 * Tenant-timezone helpers. Every business has its own timezone (§4.2) and most
 * are not Australia/Perth, so day boundaries must be computed in the tenant's
 * zone rather than the server's or the viewer's.
 */

/** Milliseconds since epoch for the start of the given local day in `timezone`. */
export function startOfDayInZone(dayKey: string, timezone: string): number {
  const [year, month, day] = dayKey.split('-').map(Number)

  // Guess at UTC, then correct by the zone's offset at that instant. Two passes
  // settle DST boundaries, which matter for every state except WA and QLD.
  let ts = Date.UTC(year, month - 1, day, 0, 0, 0, 0)
  for (let i = 0; i < 2; i++) {
    ts -= offsetMs(ts, timezone) - 0
    const check = dayKeyOf(ts, timezone)
    if (check === dayKey) break
    ts = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMs(ts, timezone)
  }
  return ts
}

export function endOfDayInZone(dayKey: string, timezone: string): number {
  return startOfDayInZone(dayKey, timezone) + 24 * 60 * 60 * 1000
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
