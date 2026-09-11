import { useQuery } from '@tanstack/react-query'
import { convexAction } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'
import { weatherKeyOf, withinForecastWindow } from '../../convex/lib/forecastWindow'
import type { Id } from '../../convex/_generated/dataModel'

export { weatherKeyOf }

export type DayWeather = {
  maxTempC?: number
  minTempC?: number
  rainMm?: number
  windKmh?: number
  code?: number
  suburb: string
  /**
   * The suburb's centroid, resolved and cached server-side. Drives the
   * schedule's travel hints (`src/lib/travel.ts`); absent when geocoding for
   * that suburb failed, in which case the hint is simply not shown.
   */
  lat?: number
  lng?: number
}

export type WeatherDayRequest = {
  dayKey: string
  suburb: string
  postcode: string
}

/** Thresholds that actually change a technician's decision. */
export const RAIN_WARN_MM = 2
export const WIND_WARN_KMH = 25

export function isWet(w?: DayWeather | null) {
  return (w?.rainMm ?? 0) >= RAIN_WARN_MM
}
export function isWindy(w?: DayWeather | null) {
  return (w?.windKmh ?? 0) >= WIND_WARN_KMH
}

/**
 * What a single card should draw. The three-state distinction lives here, once,
 * rather than being re-derived from loading flags at each render site — which
 * is how "No forecast" came to mean three different things at once:
 *
 *   `pending`       we have asked and have not heard back — draw a placeholder.
 *   `absent`        we asked and there is genuinely no forecast for that
 *                   suburb/day (unresolvable suburb, or the lookup failed) —
 *                   draw "No forecast".
 *   `outOfWindow`   no forecast could exist this far out — draw nothing at all,
 *                   because "No forecast" for a job in March reads as a fault.
 *   `ready`         draw the numbers.
 */
export type WeatherCell =
  | { status: 'pending' }
  | { status: 'absent' }
  | { status: 'outOfWindow' }
  | { status: 'ready'; weather: DayWeather }

export type WeatherLookup = {
  /**
   * The raw server entries, still keyed by suburb+day. Travel hints read
   * `lat`/`lng` straight out of this (`travelHintsFor`), so it deliberately
   * stays the full entry rather than anything card-shaped.
   */
  byKey: Record<string, DayWeather>
  cell: (suburb: string, postcode: string, dayKey: string) => WeatherCell
}

/**
 * Weather for a set of suburb-days, behind TanStack Query.
 *
 * It was previously a bare Convex action fired from a `useEffect`, which meant
 * no cache, no dedupe, and a refetch on every mount — including the mount
 * caused by flipping between the mobile and desktop layouts. Worse, on a day
 * change the previous map was kept while the new request was in flight, and
 * because entries are keyed by suburb AND day, every lookup missed and every
 * card rendered "No forecast" until it resolved. That flash is the bug this
 * hook exists to remove.
 *
 * An action rather than a query because it reaches an external API, so it
 * cannot be reactive; TanStack Query supplies the caching a Convex query would
 * otherwise have given us for free.
 */
export function useWeather(
  businessId: Id<'businesses'>,
  state: string,
  todayKey: string,
  requests: Array<WeatherDayRequest>,
): WeatherLookup {
  // Canonicalised so identical requests produce an identical query key. This
  // is load-bearing, not tidiness: action query keys are hashed by TanStack's
  // default hasher, which sorts object keys but PRESERVES array order, so an
  // unsorted list would cache-miss against itself on every render.
  const seen = new Set<string>()
  const days: Array<WeatherDayRequest> = []
  for (const r of requests) {
    if (!r.suburb) continue
    // Filtered here as well as server-side so a month range does not ship 30
    // days of requests that can only come back empty.
    if (!withinForecastWindow(r.dayKey, todayKey)) continue
    const key = weatherKeyOf(r.suburb, r.postcode, r.dayKey)
    if (seen.has(key)) continue
    seen.add(key)
    days.push({ dayKey: r.dayKey, suburb: r.suburb, postcode: r.postcode })
  }
  days.sort((a, b) =>
    weatherKeyOf(a.suburb, a.postcode, a.dayKey).localeCompare(
      weatherKeyOf(b.suburb, b.postcode, b.dayKey),
    ),
  )

  const query = useQuery({
    // Spread FIRST: convexAction sets `staleTime: Infinity`, so overriding
    // after is the only way this ever refreshes.
    ...convexAction(
      api.weather.forDays,
      days.length ? { businessId, state, days } : 'skip',
    ),
    staleTime: 30 * 60_000,
    gcTime: 6 * 60 * 60_000,
    // Never on the server. Non-suspense useQuery does not fetch during SSR
    // today, but that is incidental — and the server-side Convex HTTP client is
    // authenticated, so a stray prefetch would run a real geocode plus forecast
    // on every page render. Combined with the emptiness check because
    // convexAction's own `enabled: false` would be overridden by this line.
    enabled: days.length > 0 && !import.meta.env.SSR,
    // The forecast is advisory. The hook it replaces made exactly one attempt
    // and swallowed failures; useQuery would otherwise turn one Open-Meteo
    // outage into four billed action runs per mount.
    retry: false,
    refetchOnWindowFocus: false,
  })

  const byKey: Record<string, DayWeather> = query.data ?? {}

  return {
    byKey,
    cell: (suburb, postcode, dayKey) => {
      if (!suburb || !withinForecastWindow(dayKey, todayKey)) {
        return { status: 'outOfWindow' }
      }
      // Annotated because indexing a Record is typed as a hit: a suburb the
      // server could not geocode is simply absent from the map, which is the
      // case the `absent` state exists for.
      const weather: DayWeather | undefined =
        byKey[weatherKeyOf(suburb, postcode, dayKey)]
      if (weather) return { status: 'ready', weather }
      // `isPending` rather than `isFetching`: the latter is also true while a
      // stale-but-present forecast refetches in the background, which would
      // blink a rendered card back to a placeholder mid-session. `isPending`
      // is already false once the query errors, so a failed lookup degrades to
      // "No forecast" rather than spinning forever.
      return query.isPending ? { status: 'pending' } : { status: 'absent' }
    },
  }
}
