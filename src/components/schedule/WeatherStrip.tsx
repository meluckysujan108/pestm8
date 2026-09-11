import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Sun,
} from 'lucide-react'
import { BarMeter } from '#/components/primitives/BarMeter'
import type { WeatherCell } from '#/lib/weather'
import type { LucideIcon } from 'lucide-react'

/**
 * The forecast for one job's suburb, shown on the job card itself.
 *
 * Values only — no "too windy to spray" advice. A technician reading their own
 * day knows what 18 km/h means for the job in front of them better than this
 * app does; the bars exist to make the numbers legible at a glance, not to
 * reach a conclusion on their behalf.
 *
 * Every element is a `span`: this renders inside JobCard's `button`, which may
 * only contain phrasing content.
 */

/** Scales chosen so a typical day lands mid-bar rather than pinned at either end. */
const RAIN_SCALE_MM = 10
const WIND_SCALE_KMH = 40

/** WMO codes, as returned by Open-Meteo's `weather_code`. */
function describe(code: number | undefined): {
  Icon: LucideIcon
  label: string
  tint: string
} {
  if (code === undefined) return { Icon: Cloud, label: '', tint: 'text-muted' }
  if (code === 0) return { Icon: Sun, label: 'Clear', tint: 'text-amber' }
  if (code <= 2)
    return { Icon: CloudSun, label: 'Partly cloudy', tint: 'text-amber' }
  if (code === 3) return { Icon: Cloud, label: 'Overcast', tint: 'text-muted' }
  if (code <= 48) return { Icon: CloudFog, label: 'Fog', tint: 'text-muted' }
  if (code <= 57)
    return { Icon: CloudDrizzle, label: 'Drizzle', tint: 'text-blue' }
  if (code <= 67) return { Icon: CloudRain, label: 'Rain', tint: 'text-blue' }
  if (code <= 77) return { Icon: CloudSnow, label: 'Snow', tint: 'text-blue' }
  if (code <= 82)
    return { Icon: CloudRain, label: 'Showers', tint: 'text-blue' }
  if (code <= 86)
    return { Icon: CloudSnow, label: 'Snow showers', tint: 'text-blue' }
  return { Icon: CloudLightning, label: 'Storms', tint: 'text-blue' }
}

function Metric({
  label,
  value,
  meter,
}: {
  label: string
  value: string
  meter?: React.ReactNode
}) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-bold uppercase tracking-[0.07em] text-muted-2">
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        {meter}
        <span className="text-caption font-semibold tabular-nums text-ink-2">
          {value}
        </span>
      </span>
    </span>
  )
}

export function WeatherStrip({ cell }: { cell: WeatherCell }) {
  // Nothing at all beyond the forecast horizon. "No forecast" for a job three
  // months out reads as a failure, when in fact no forecast could exist yet.
  if (cell.status === 'outOfWindow') return null

  if (cell.status === 'pending') {
    // Deliberately the same height as the resolved strip below (a 26px numeral
    // over a 2.5-unit padded box). A shorter placeholder would re-introduce the
    // board-card reflow that `a9dc2cb` fixed — the card would visibly resize as
    // each forecast landed.
    return (
      <span
        data-testid="weather-pending"
        aria-hidden
        className="block h-[62px] animate-pulse rounded-xl bg-surface-2"
      />
    )
  }

  if (cell.status === 'absent') {
    return (
      <span className="block rounded-xl bg-surface-2 px-3 py-2.5 text-caption text-muted">
        No forecast
      </span>
    )
  }

  const { weather } = cell
  const { Icon, label, tint } = describe(weather.code)
  const { maxTempC, minTempC, rainMm, windKmh } = weather

  return (
    // Wraps rather than shrinks: the temperature is 26px and does not
    // truncate, so on a narrow card letting this row compress would slide the
    // metrics underneath the numeral instead of moving them to their own line.
    <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl bg-surface-2 px-3 py-2.5">
      <span className="flex items-center gap-2.5">
        <Icon size={26} strokeWidth={1.7} className={`shrink-0 ${tint}`} />
        <span>
          {maxTempC !== undefined && (
            <span className="block text-metric-sm leading-none text-ink">
              {Math.round(maxTempC)}°
            </span>
          )}
          {label && (
            <span className="mt-0.5 block text-caption text-muted">
              {label}
            </span>
          )}
        </span>
      </span>

      <span className="flex items-start gap-3.5">
        {rainMm !== undefined && (
          <Metric
            label="Rain"
            value={`${rainMm.toFixed(1)} mm`}
            meter={
              <BarMeter value={rainMm} max={RAIN_SCALE_MM} tint="bg-blue" />
            }
          />
        )}
        {windKmh !== undefined && (
          <Metric
            label="Wind"
            value={`${Math.round(windKmh)} km/h`}
            meter={<BarMeter value={windKmh} max={WIND_SCALE_KMH} />}
          />
        )}
        {minTempC !== undefined && maxTempC !== undefined && (
          <Metric
            label="Range"
            value={`${Math.round(minTempC)}° / ${Math.round(maxTempC)}°`}
          />
        )}
      </span>
    </span>
  )
}
