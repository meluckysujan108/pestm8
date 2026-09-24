import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { convexAction } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'
import {
  RAIN_WARN_MM,
  WIND_WARN_KMH,
  weatherKeyOf,
  withinForecastWindow,
} from '../../convex/lib/forecastWindow'
import { dayKeyOf } from '../../convex/lib/dates'
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
  /** Only the rest of today: MET Norway, standing in while Open-Meteo is
   * refusing us, forecasts from the current hour on. */
  partial?: boolean
}

export type WeatherDayRequest = {
  dayKey: string
  suburb: string
  postcode: string
  /** The property's own state, when the caller knows it. Otherwise the
   * business's state (useWeather's `state`) is used to find the suburb. */
  state?: string
}

/** Defined beside the forecast window, so the server and the report seeding share them. */
export { RAIN_WARN_MM, WIND_WARN_KMH }

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
 * The days to ask the server about: each suburb-day once, inside the forecast
 * window, in a fixed order.
 *
 * Canonicalised so identical requests produce an identical query key. This is
 * load-bearing, not tidiness: action query keys are hashed by TanStack's
 * default hasher, which sorts object keys but PRESERVES array order, so an
 * unsorted list would cache-miss against itself on every render.
 */
export function weatherRequestDays(
  requests: Array<WeatherDayRequest>,
  todayKey: string,
): Array<WeatherDayRequest> {
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
    days.push({
      dayKey: r.dayKey,
      suburb: r.suburb,
      postcode: r.postcode,
      // Sent only when known, so the request stays exactly as before for a
      // caller that does not have it.
      ...(r.state ? { state: r.state } : {}),
    })
  }
  return days.sort((a, b) =>
    weatherKeyOf(a.suburb, a.postcode, a.dayKey).localeCompare(
      weatherKeyOf(b.suburb, b.postcode, b.dayKey),
    ),
  )
}

/**
 * What one card draws, given what the server has sent so far. `waiting` is
 * true while the answer for the current request is still on its way — the
 * first time, or while the previous answer stands in for it.
 */
export function weatherCellOf(
  byKey: Record<string, DayWeather>,
  waiting: boolean,
  todayKey: string,
  suburb: string,
  postcode: string,
  dayKey: string,
): WeatherCell {
  if (!suburb || !withinForecastWindow(dayKey, todayKey)) {
    return { status: 'outOfWindow' }
  }
  // Widened with `as`, not annotated: indexing a Record is typed as a hit,
  // and TypeScript narrows an annotated `const` straight back to its
  // initializer's type, so the check below would always be true. A suburb the
  // server could not geocode is simply absent from the map, which is the case
  // the `absent` state exists for.
  const weather = byKey[weatherKeyOf(suburb, postcode, dayKey)] as
    | DayWeather
    | undefined
  if (weather) return { status: 'ready', weather }
  return waiting ? { status: 'pending' } : { status: 'absent' }
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
  const days = weatherRequestDays(requests, todayKey)

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
    // A new set of days (a booking, a filter, the next day) keeps showing the
    // forecasts it shares with the last set while its own answer loads,
    // instead of every card dropping back to a placeholder.
    placeholderData: keepPreviousData,
  })

  const byKey: Record<string, DayWeather> = query.data ?? {}
  // `isPending` rather than `isFetching`: the latter is also true while a
  // stale-but-present forecast refetches in the background, which would blink
  // a rendered card back to a placeholder mid-session. `isPending` is already
  // false once the query errors, so a failed lookup degrades to "No forecast"
  // rather than spinning forever. And while the last set's answer stands in
  // (`isPlaceholderData`), a day it does not have is still on its way — not
  // "No forecast", which is the flash this hook exists to prevent.
  const waiting = query.isPending || query.isPlaceholderData

  return {
    byKey,
    cell: (suburb, postcode, dayKey) =>
      weatherCellOf(byKey, waiting, todayKey, suburb, postcode, dayKey),
  }
}

type WeatherJob = {
  scheduledAt: number
  suburb: string
  postcode?: string
  propertyState?: string
}

/** Each job's forecast request: its own day in the tenant's zone, its own
 * suburb, its own property's state. */
export function jobWeatherRequests(
  jobs: Array<WeatherJob>,
  timezone: string,
): Array<WeatherDayRequest> {
  return jobs.map((job) => ({
    dayKey: dayKeyOf(job.scheduledAt, timezone),
    suburb: job.suburb,
    postcode: job.postcode ?? '',
    state: job.propertyState,
  }))
}

/**
 * Forecasts for a list of jobs spread over many days — the Job tab, the
 * Recurring Job view — each on its own day, in its own suburb and state. Jobs
 * outside the forecast window draw no strip, as the card always has.
 *
 * Give it every job the page can show, not the ones a filter leaves: the
 * request then stays the same while the filter changes, and nothing is asked
 * again. `showsAny` says whether any of the jobs on screen has a forecast
 * showing, for the credit beside them.
 */
export function useJobsWeather(
  business: { _id: Id<'businesses'>; state: string; timezone: string },
  jobs: Array<WeatherJob>,
) {
  const dayOf = (ts: number) => dayKeyOf(ts, business.timezone)
  const lookup = useWeather(
    business._id,
    business.state,
    dayOf(Date.now()),
    jobWeatherRequests(jobs, business.timezone),
  )
  const cellFor = (job: WeatherJob): WeatherCell =>
    lookup.cell(job.suburb, job.postcode ?? '', dayOf(job.scheduledAt))
  return {
    cellFor,
    showsAny: (shown: Array<WeatherJob>) =>
      shown.some((job) => cellFor(job).status === 'ready'),
  }
}
