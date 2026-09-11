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
 *
 * If `hh:mm` falls inside a "spring forward" DST gap (a wall-clock reading
 * that never actually happens — e.g. 2:00–2:59am on the day a DST-observing
 * state's clocks jump to 3am), the 2-pass loop below can never converge,
 * since no instant renders back to that exact reading. Rather than silently
 * returning whatever the loop happened to land on, that case is resolved
 * explicitly: shift forward by the size of the gap (2:30am becomes 3:30am),
 * the same convention `date-fns-tz`/`luxon` use.
 */
export function zonedDateTimeToUtc(
  dayKey: string,
  hh: number,
  mm: number,
  timezone: string,
): number {
  const [year, month, day] = dayKey.split('-').map(Number)
  const naiveUtc = Date.UTC(year, month - 1, day, hh, mm, 0, 0)

  // Guess at UTC, then correct by the zone's offset at that instant. Two passes
  // settle DST boundaries, which matter for every state except WA and QLD.
  let ts = naiveUtc
  let matched = false
  for (let i = 0; i < 2; i++) {
    ts = naiveUtc - offsetMs(ts, timezone)
    if (
      dayKeyOf(ts, timezone) === dayKey &&
      timeKeyOf(ts, timezone) === `${pad(hh)}:${pad(mm)}`
    ) {
      matched = true
      break
    }
  }
  if (matched) return ts

  // The requested wall-clock time doesn't exist (DST spring-forward gap).
  // `ts` (the loop's last candidate) is already a real UTC instant close to
  // the actual transition — unlike `naiveUtc`, which is offset from it by
  // the zone's own UTC offset and so isn't safe to probe around directly
  // (probing naiveUtc ± N hours lands nowhere near the transition for a
  // zone whose offset is larger than N, e.g. any positive-offset zone).
  // Sampling 2 hours before `ts` — comfortably wider than any real DST gap,
  // and guaranteed to land before the transition since `ts` itself is
  // already within it — gives the pre-transition offset; applying THAT
  // offset (not the post-transition one) to `naiveUtc` lands on the instant
  // whose local reading is the requested time shifted forward by the gap
  // size, e.g. 2:30am becomes 3:30am on a "clocks jump to 3am" day.
  const offsetBeforeGap = offsetMs(ts - 2 * 60 * 60 * 1000, timezone)
  return naiveUtc - offsetBeforeGap
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

  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value)
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
