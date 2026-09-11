/**
 * Regression check for the travel hints in `src/lib/travel.ts` — the distance
 * maths and the thresholds that decide what a job card says about the hop from
 * the previous job.
 *
 * Same reasoning as `check-dst-boundaries.mjs`: this project has no Vitest, and
 * driving pure functions through a full Playwright run (which needs a browser,
 * a dev server and a live Convex deployment) is the wrong tool for them.
 *
 * Unlike that script, this one IMPORTS the real module rather than mirroring
 * it — a mirrored copy silently drifts from the code it claims to protect.
 * Node 22's `--experimental-strip-types` runs the TypeScript directly. The
 * path is relative rather than the app's `#/` alias, which Node rejects as an
 * internal imports specifier.
 *
 * This works because `travel.ts` has no runtime imports at all: it takes
 * coordinates through a callback rather than reaching into the forecast cache
 * itself, so nothing drags React or the Convex client in behind it.
 *
 * Run: node --experimental-strip-types scripts/check-travel.mjs
 *      (or `npm run check:travel`)
 */

import { distanceKm, travelHint, travelHintsFor } from '../src/lib/travel.ts'

let failures = 0

function check(label, actual, expected) {
  if (actual !== expected) {
    failures++
    console.error(`FAIL  ${label}: expected ${expected}, got ${actual}`)
  } else {
    console.log(`ok    ${label}`)
  }
}

function checkNear(label, actual, expected, tolerance) {
  if (actual === null || Math.abs(actual - expected) > tolerance) {
    failures++
    console.error(
      `FAIL  ${label}: expected ${expected} ±${tolerance}, got ${actual}`,
    )
  } else {
    console.log(`ok    ${label}`)
  }
}

// Suburb centroids, as Open-Meteo's geocoder returns them.
const perth = { lat: -31.9523, lng: 115.8613, suburb: 'Perth' }
const fremantle = { lat: -32.0569, lng: 115.7439, suburb: 'Fremantle' }
const morley = { lat: -31.8885, lng: 115.9089, suburb: 'Morley' }
const melbourne = { lat: -37.8136, lng: 144.9631, suburb: 'Melbourne' }

// --- distanceKm ------------------------------------------------------------
// Perth CBD to Fremantle is ~16 km in a straight line. Worth pinning precisely
// because the drive is about 19 km — the gap between those two numbers is the
// whole reason every rendered distance carries a "≈".
checkNear(
  'Perth → Fremantle is ≈16 km',
  distanceKm(perth, fremantle),
  16.1,
  0.3,
)
// Perth to Melbourne is about 2,720 km — guards the formula against a
// degrees/radians slip that only shows up at continental distances.
checkNear(
  'Perth → Melbourne is ≈2720 km',
  distanceKm(perth, melbourne),
  2720,
  40,
)

check('a point to itself is 0 km', distanceKm(perth, perth), 0)
check(
  'distance is symmetric',
  distanceKm(perth, fremantle) === distanceKm(fremantle, perth),
  true,
)

// A suburb whose geocode failed has no coordinates, and a missing number must
// never quietly become 0 — that would render "Same suburb" for two addresses
// on opposite sides of the state.
check('missing lat yields null', distanceKm({ lng: 115.8 }, fremantle), null)
check('missing lng yields null', distanceKm({ lat: -31.9 }, fremantle), null)
check('both sides missing yields null', distanceKm({}, {}), null)

// --- travelHint ------------------------------------------------------------
check('no previous job means no hint', travelHint(null, fremantle), null)
check(
  'undefined previous job means no hint',
  travelHint(undefined, fremantle),
  null,
)
check(
  'a missing coordinate means no hint',
  travelHint({ suburb: 'Nowhere' }, fremantle),
  null,
)

check(
  'the same point reads as the same suburb',
  travelHint(perth, { ...perth, suburb: 'Perth' }),
  'Same suburb',
)
check(
  'under the 1.5 km threshold reads as the same suburb',
  // ~0.5 km north of Perth's centroid.
  travelHint(perth, { lat: -31.9478, lng: 115.8613, suburb: 'Perth' }),
  'Same suburb',
)
check(
  'a short hop keeps one decimal',
  travelHint(morley, { lat: -31.9523, lng: 115.9089, suburb: 'Bayswater' }),
  '≈ 7.1 km → Bayswater',
)
check(
  'a long hop rounds to whole kilometres',
  travelHint(perth, fremantle),
  '≈ 16 km → Fremantle',
)
check(
  'a hop to an unnamed suburb omits the destination',
  travelHint(perth, { lat: fremantle.lat, lng: fremantle.lng }),
  '≈ 16 km',
)

// --- travelHintsFor --------------------------------------------------------
const jobs = [
  { _id: 'a', suburb: 'Perth' },
  { _id: 'b', suburb: 'Fremantle' },
  { _id: 'c', suburb: 'Nowhere' },
  { _id: 'd', suburb: 'Morley' },
]

// Stands in for the forecast lookup the components pass. 'Nowhere' is
// deliberately absent — a suburb the geocoder could not resolve.
const coords = { Perth: perth, Fremantle: fremantle, Morley: morley }
const coordsFor = (job) => coords[job.suburb]

const hints = travelHintsFor(jobs, coordsFor)

check('the first job of the day has no hint', hints.a, null)
check('the second job measures from the first', hints.b, '≈ 16 km → Fremantle')
check('a job with no forecast has no hint', hints.c, null)
// The chain must survive a gap: 'd' measures from 'c', which has no
// coordinates, so it is null rather than silently measuring from 'b'.
check('a job after an unresolvable one has no hint', hints.d, null)

// Order is the rendered order, not the array's identity — reversing the input
// must change which job is "previous".
const reversed = travelHintsFor([jobs[1], jobs[0]], coordsFor)
check(
  'reversing the list moves the null to the new first job',
  reversed.b,
  null,
)
check(
  'reversing the list measures the other direction',
  reversed.a,
  '≈ 16 km → Perth',
)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll checks passed.')
