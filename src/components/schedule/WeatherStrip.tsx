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

/**
 * A line with nothing on it, which keeps the line's height: a value the
 * forecast left out, and every line of the placeholder.
 */
const BLANK = '\u00a0'

/**
 * The strip's box. A container: what is inside is laid out by the strip's own
 * width, never by its words wrapping, so the forecast and its placeholder are
 * one height at any width.
 */
const STRIP = '@container block rounded-xl bg-surface-2 px-3 py-2.5'

/** Without a label and a value, an empty slot of the same height. */
function Metric({
  label,
  value,
  meter,
}: {
  label?: string
  value?: string
  meter?: React.ReactNode
}) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-bold uppercase tracking-[0.07em] text-muted-2">
        {label ?? BLANK}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {/* Below 15rem only the three numbers fit on the line. */}
        {meter && (
          <span className="hidden shrink-0 @min-[15rem]:block">{meter}</span>
        )}
        <span className="truncate text-caption font-semibold tabular-nums text-ink-2">
          {value ?? BLANK}
        </span>
      </span>
    </span>
  )
}

/**
 * The forecast's layout, which the placeholder shares with blank lines: the
 * temperature over its caption, and the three metrics. Side by side from
 * 32rem, where the longest of each fits ("Snow showers · rest of today" and
 * three two-digit values); below it, the metrics on a line of their own.
 *
 * Which of the two is decided by the width alone. It used to be the row
 * wrapping once its words ran out of room, so a strip's height depended on
 * the forecast, and no placeholder could know it: at 390px every card grew
 * 49px as its forecast landed. Nothing inside wraps now. The caption
 * truncates rather than slide the metrics under the 26px numeral (`a9dc2cb`),
 * and a missing value keeps its line.
 */
function Layout({
  icon,
  temp,
  caption,
  metrics,
}: {
  icon?: React.ReactNode
  temp?: string
  caption?: string
  metrics: React.ReactNode
}) {
  return (
    <span className="flex flex-col gap-2 @lg:flex-row @lg:items-center @lg:justify-between @lg:gap-3">
      <span className="flex min-w-0 items-center gap-2.5">
        {icon}
        <span className="min-w-0">
          <span className="block text-metric-sm leading-none text-ink">
            {temp ?? BLANK}
          </span>
          <span className="mt-0.5 block truncate text-caption text-muted">
            {caption || BLANK}
          </span>
        </span>
      </span>
      <span className="flex items-start justify-between gap-3 @lg:shrink-0 @lg:justify-start @lg:gap-3.5">
        {metrics}
      </span>
    </span>
  )
}

export function WeatherStrip({ cell }: { cell: WeatherCell }) {
  // Nothing at all beyond the forecast horizon. "No forecast" for a job three
  // months out reads as a failure, when in fact no forecast could exist yet.
  if (cell.status === 'outOfWindow') return null

  if (cell.status === 'pending') {
    // The forecast's own layout with nothing on its lines, one grey block, so
    // it is the strip's height at every width and the card does not grow when
    // the forecast lands, or when signal comes back to a phone that had none.
    return (
      <span
        data-testid="weather-pending"
        aria-hidden
        className={`${STRIP} motion-safe:animate-pulse`}
      >
        <Layout
          metrics={
            <>
              <Metric />
              <Metric />
              <Metric />
            </>
          }
        />
      </span>
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
  // Said, because the numbers are then only the hours still to come: at 3pm
  // the "high" is the evening's, and the morning's rain is not in the total.
  const caption = weather.partial
    ? label
      ? `${label} · rest of today`
      : 'Rest of today'
    : label

  return (
    <span className={STRIP}>
      <Layout
        icon={
          <Icon size={26} strokeWidth={1.7} className={`shrink-0 ${tint}`} />
        }
        temp={maxTempC !== undefined ? `${Math.round(maxTempC)}°` : undefined}
        caption={caption}
        metrics={
          <>
            {rainMm !== undefined ? (
              <Metric
                label="Rain"
                value={`${rainMm.toFixed(1)} mm`}
                meter={
                  <BarMeter value={rainMm} max={RAIN_SCALE_MM} tint="bg-blue" />
                }
              />
            ) : (
              <Metric />
            )}
            {windKmh !== undefined ? (
              <Metric
                label="Wind"
                value={`${Math.round(windKmh)} km/h`}
                meter={<BarMeter value={windKmh} max={WIND_SCALE_KMH} />}
              />
            ) : (
              <Metric />
            )}
            {minTempC !== undefined && maxTempC !== undefined ? (
              <Metric
                label="Range"
                value={`${Math.round(minTempC)}° / ${Math.round(maxTempC)}°`}
              />
            ) : (
              <Metric />
            )}
          </>
        }
      />
    </span>
  )
}
