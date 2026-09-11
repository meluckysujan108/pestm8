import { CloudRain, Sun, Wind } from 'lucide-react'
import { isWet, isWindy } from '#/lib/useDayWeather'
import type { DayWeather } from '#/lib/useDayWeather'

/**
 * A calendar day has room for one mark, so it shows the thing that would
 * change the plan: rain first, then wind. A fine day gets a faint sun rather
 * than nothing, so "no forecast" and "fine" stay distinguishable.
 */
export function WeatherGlyph({
  weather,
  size = 12,
}: {
  weather?: DayWeather | null
  size?: number
}) {
  if (!weather) return null

  const wet = isWet(weather)
  const windy = isWindy(weather)

  const label = wet
    ? `Rain forecast${weather.rainMm !== undefined ? `, ${weather.rainMm.toFixed(1)} mm` : ''}`
    : windy
      ? `Windy${weather.windKmh !== undefined ? `, ${Math.round(weather.windKmh)} km/h` : ''}`
      : 'Fine'

  const Icon = wet ? CloudRain : windy ? Wind : Sun

  return (
    <Icon
      size={size}
      strokeWidth={2}
      role="img"
      aria-label={label}
      className={
        wet ? 'text-blue' : windy ? 'text-amber-ink' : 'text-muted opacity-60'
      }
    />
  )
}
