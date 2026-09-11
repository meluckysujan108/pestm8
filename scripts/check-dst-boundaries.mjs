/**
 * Regression check for the DST-gap fix in `convex/lib/dates.ts`.
 *
 * This project has no Vitest/unit-test setup, and driving a pure date-math
 * function through a full Playwright run is the wrong tool for it — so this
 * is a plain, dependency-free script instead. It MIRRORS the small set of
 * pure functions in `convex/lib/dates.ts` (`dayKeyOf`, `timeKeyOf`,
 * `offsetMs`, `zonedDateTimeToUtc`) rather than importing them, since that
 * file is TypeScript and this repo has no TS-executing script runner
 * installed. If `convex/lib/dates.ts`'s date-math changes, update this copy
 * too.
 *
 * Run: node scripts/check-dst-boundaries.mjs
 */

function pad(n) {
  return String(n).padStart(2, '0')
}

function dayKeyOf(ts, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts))
  const get = (type) => parts.find((p) => p.type === type).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function timeKeyOf(ts, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts))
  const get = (type) => parts.find((p) => p.type === type).value
  return `${get('hour')}:${get('minute')}`
}

function offsetMs(ts, timezone) {
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
  const get = (type) => Number(parts.find((p) => p.type === type).value)
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

function zonedDateTimeToUtc(dayKey, hh, mm, timezone) {
  const [year, month, day] = dayKey.split('-').map(Number)
  const naiveUtc = Date.UTC(year, month - 1, day, hh, mm, 0, 0)

  let ts = naiveUtc
  let matched = false
  for (let i = 0; i < 2; i++) {
    ts = naiveUtc - offsetMs(ts, timezone)
    if (dayKeyOf(ts, timezone) === dayKey && timeKeyOf(ts, timezone) === `${pad(hh)}:${pad(mm)}`) {
      matched = true
      break
    }
  }
  if (matched) return ts

  const offsetBeforeGap = offsetMs(ts - 2 * 60 * 60 * 1000, timezone)
  return naiveUtc - offsetBeforeGap
}

let failures = 0

function check(label, actual, expected) {
  if (actual !== expected) {
    failures++
    console.error(`FAIL  ${label}: expected ${expected}, got ${actual}`)
  } else {
    console.log(`ok    ${label}`)
  }
}

// --- DST spring-forward gaps: the bug this script exists to catch ---
// Australia/Sydney: 2026-10-04, clocks jump 2:00am -> 3:00am (AEST -> AEDT).
{
  const ts = zonedDateTimeToUtc('2026-10-04', 2, 30, 'Australia/Sydney')
  check('Sydney 2026-10-04 02:30 (in the gap) shifts to 03:30', timeKeyOf(ts, 'Australia/Sydney'), '03:30')
  check('Sydney 2026-10-04 02:30 (in the gap) stays on the same day', dayKeyOf(ts, 'Australia/Sydney'), '2026-10-04')
}
// America/Los_Angeles: 2026-03-08, clocks jump 2:00am -> 3:00am (PST -> PDT).
{
  const ts = zonedDateTimeToUtc('2026-03-08', 2, 15, 'America/Los_Angeles')
  check('LA 2026-03-08 02:15 (in the gap) shifts to 03:15', timeKeyOf(ts, 'America/Los_Angeles'), '03:15')
}

// --- Ordinary times must still round-trip with zero drift ---
for (const [tz, dayKey, hh, mm] of [
  ['Australia/Sydney', '2026-06-15', 14, 0],
  ['Australia/Perth', '2026-06-15', 9, 30],
  ['America/Los_Angeles', '2026-06-15', 23, 45],
  ['Pacific/Kiritimati', '2026-06-15', 0, 0],
  ['Pacific/Niue', '2026-06-15', 23, 59],
]) {
  const ts = zonedDateTimeToUtc(dayKey, hh, mm, tz)
  check(`${tz} ${dayKey} ${pad(hh)}:${pad(mm)} round-trips (day)`, dayKeyOf(ts, tz), dayKey)
  check(`${tz} ${dayKey} ${pad(hh)}:${pad(mm)} round-trips (time)`, timeKeyOf(ts, tz), `${pad(hh)}:${pad(mm)}`)
}

// --- Midnight (startOfDayInZone's own input) around a transition day ---
{
  const ts = zonedDateTimeToUtc('2026-10-04', 0, 0, 'Australia/Sydney')
  check('Sydney midnight on the transition day round-trips', timeKeyOf(ts, 'Australia/Sydney'), '00:00')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll checks passed.')
