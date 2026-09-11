import { useEffect, useState } from 'react'
import { useConvex } from 'convex/react'
import { CloudRain, Droplets, Wind } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

type Weather = {
  maxTempC?: number
  minTempC?: number
  rainMm?: number
  windKmh?: number
  code?: number
  suburb: string
}

/** Thresholds that actually change a technician's decision. */
const RAIN_WARN_MM = 2
const WIND_WARN_KMH = 25

export function WeatherBanner({
  businessId,
  suburb,
  postcode,
  state,
  dayKey,
}: {
  businessId: Id<'businesses'>
  suburb: string
  postcode: string
  state: string
  dayKey: string
}) {
  const convex = useConvex()
  const [weather, setWeather] = useState<Weather | null>(null)

  // An action, not a query: it calls an external API, so it cannot be
  // reactive. Failures leave the banner absent rather than showing an error —
  // the forecast is advisory and must never obscure the day's work.
  useEffect(() => {
    let cancelled = false
    setWeather(null)

    convex
      .action(api.weather.forDay, {
        businessId,
        suburb,
        postcode,
        state,
        dayKey,
      })
      .then((result) => {
        if (!cancelled) setWeather(result)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [convex, businessId, suburb, postcode, state, dayKey])

  if (!weather) return null

  const wet = (weather.rainMm ?? 0) >= RAIN_WARN_MM
  const windy = (weather.windKmh ?? 0) >= WIND_WARN_KMH
  const advise = wet || windy

  return (
    <div
      className={`mx-4 mb-3 flex items-start gap-2.5 rounded-2xl border px-3.5 py-2.5 ${
        advise
          ? 'border-amber-line bg-amber-bg text-amber-ink'
          : 'border-hairline bg-surface text-ink-2 shadow-elevation'
      }`}
    >
      {wet ? (
        <CloudRain size={17} strokeWidth={1.7} className="mt-0.5 shrink-0" />
      ) : windy ? (
        <Wind size={17} strokeWidth={1.7} className="mt-0.5 shrink-0" />
      ) : (
        <Droplets
          size={17}
          strokeWidth={1.7}
          className="mt-0.5 shrink-0 text-blue"
        />
      )}

      <div className="min-w-0 flex-1">
        <p className="text-body">
          {weather.suburb}
          {weather.maxTempC !== undefined &&
            ` · ${Math.round(weather.maxTempC)}°`}
          {weather.minTempC !== undefined &&
            ` / ${Math.round(weather.minTempC)}°`}
          {weather.rainMm !== undefined && ` · ${weather.rainMm.toFixed(1)} mm`}
          {weather.windKmh !== undefined &&
            ` · ${Math.round(weather.windKmh)} km/h`}
        </p>

        {/* Why it matters, not just what it is. */}
        {wet && (
          <p className="mt-0.5 text-caption">
            Rain forecast — an external treatment applied today may wash off.
          </p>
        )}
        {!wet && windy && (
          <p className="mt-0.5 text-caption">
            Windy — spray drift is likely on exposed applications.
          </p>
        )}
      </div>
    </div>
  )
}
