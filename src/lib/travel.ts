/**
 * Distance between consecutive jobs, from the suburb centroids the weather
 * lookup already resolves (`convex/weather.ts`'s `suburbGeocache`).
 *
 * This is a straight line between two SUBURB centres, not a driving route —
 * hence every rendered value carries a "≈". Anything more exact needs
 * street-level geocoding, which Open-Meteo's suburb-level geocoder cannot do.
 */

export type Coords = { lat?: number; lng?: number }

const EARTH_RADIUS_KM = 6371

/**
 * Below this, two addresses are close enough that a centroid-to-centroid
 * number is meaningless — both jobs are effectively in the same place, and
 * "≈ 0 km" would read as a measurement rather than as "no meaningful hop".
 */
const SAME_SUBURB_KM = 1.5

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** Great-circle distance in kilometres. */
export function distanceKm(from: Coords, to: Coords): number | null {
  if (
    from.lat === undefined ||
    from.lng === undefined ||
    to.lat === undefined ||
    to.lng === undefined
  ) {
    return null
  }

  const dLat = toRadians(to.lat - from.lat)
  const dLng = toRadians(to.lng - from.lng)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(dLng / 2) ** 2

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * The hop from the previous job to this one, or null when there is nothing
 * useful to say — no previous job, missing coordinates, or a distance too
 * small to mean anything.
 */
export function travelHint(
  previous: (Coords & { suburb?: string }) | null | undefined,
  current: Coords & { suburb?: string },
): string | null {
  if (!previous) return null

  const km = distanceKm(previous, current)
  if (km === null) return null

  // No arrow on the same-suburb case: "Same suburb → Mount Lawley" names a
  // destination the reader is already looking at on the card above.
  if (km < SAME_SUBURB_KM) return 'Same suburb'

  const destination = current.suburb ? ` → ${current.suburb}` : ''

  // Under 10 km a single decimal is the difference between two streets and two
  // neighbourhoods; past that it is noise on an approximation this rough.
  const rounded = km < 10 ? km.toFixed(1) : String(Math.round(km))
  return `≈ ${rounded} km${destination}`
}

/**
 * Hop text per job id, for one day's jobs **in the order they are rendered**.
 *
 * Deliberately computed over the filtered list rather than the whole day: the
 * hint describes the card above it on screen, so measuring from a job the
 * current filter is hiding would describe a journey the reader cannot see.
 * The first job has no hint — there is no previous location to come from.
 *
 * Coordinates arrive through `coordsFor` rather than as a forecast map, so this
 * module knows nothing about where they come from or how that cache is keyed.
 * That keeps the whole file free of runtime imports, which is what lets
 * `scripts/check-travel.mjs` exercise it directly under plain Node.
 */
export function travelHintsFor<T extends { _id: string; suburb: string }>(
  jobs: Array<T>,
  coordsFor: (job: T) => Coords | undefined,
): Record<string, string | null> {
  const hints: Record<string, string | null> = {}
  let previous: (Coords & { suburb?: string }) | null = null

  for (const job of jobs) {
    const found = coordsFor(job)
    const here = { lat: found?.lat, lng: found?.lng, suburb: job.suburb }
    hints[job._id] = travelHint(previous, here)
    previous = here
  }

  return hints
}
