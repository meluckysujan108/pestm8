import { useEffect, useState } from 'react'
import { useConvex } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

export type DayWeather = {
  maxTempC?: number
  minTempC?: number
  rainMm?: number
  windKmh?: number
  code?: number
  suburb: string
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

// Mirrors convex/weather.ts's suburbKeyOf + composite keying exactly — keep
// in sync if that file's normalisation ever changes.
function suburbKeyOf(suburb: string, postcode: string) {
  return `${suburb.trim().toLowerCase().replace(/\s+/g, '-')}-${postcode.trim()}`
}

/** Builds the same composite key `forDays` writes its output under, so a
 * lookup for one job's suburb+day never collides with a different suburb
 * on the same day. */
export function weatherKeyOf(suburb: string, postcode: string, dayKey: string) {
  return `${suburbKeyOf(suburb, postcode)}|${dayKey}`
}

/**
 * Weather for a set of days in one call. An action, not a query, because it
 * reaches an external API and so cannot be reactive.
 *
 * Days outside the forecast window simply come back absent — the calendar
 * shows nothing for them rather than an empty-looking zero, because a month
 * grid mostly extends past where any forecast exists.
 */
export function useDayWeather(
  businessId: Id<'businesses'>,
  state: string,
  days: Array<WeatherDayRequest>,
): Record<string, DayWeather> {
  const convex = useConvex()
  const [weather, setWeather] = useState<Record<string, DayWeather>>({})

  // Serialised so the effect re-runs on content change, not identity change:
  // the array is rebuilt on every render by its callers.
  const key = days
    .map((d) => `${d.dayKey}|${d.suburb}|${d.postcode}`)
    .sort()
    .join(',')

  useEffect(() => {
    if (days.length === 0) {
      setWeather({})
      return
    }

    let cancelled = false
    convex
      .action(api.weather.forDays, { businessId, state, days })
      .then((result) => {
        if (!cancelled) setWeather(result)
      })
      .catch(() => {
        // Advisory only — never blocks the schedule from rendering.
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, businessId, state, key])

  return weather
}
