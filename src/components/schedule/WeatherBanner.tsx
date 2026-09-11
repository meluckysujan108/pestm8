import { CloudRain, Droplets, Wind } from 'lucide-react'
import { isWet as wetAt, isWindy as windyAt } from '#/lib/weather'
import type { WeatherCell } from '#/lib/weather'

/**
 * The day's forecast for the first job's suburb, with the advice attached.
 *
 * Reads the schedule's own already-fetched lookup rather than issuing its own
 * request: it previously called a second Convex action (`forDay`) that was a
 * drifted copy of the one the cards use — no forecast-window guard, no
 * coordinates — so the banner and the cards could disagree about the same day.
 *
 * Deliberately still the DAY aggregate, not any one job's hour: this answers
 * "what is this day like", which is the question the wash-off advice below is
 * really about. The per-job numbers live on the cards.
 */
export function WeatherBanner({ cell }: { cell: WeatherCell }) {
  // Advisory only — never obscures the day's work, and never claims a forecast
  // it does not have.
  if (cell.status !== 'ready') return null
  const weather = cell.weather

  const wet = wetAt(weather)
  const windy = windyAt(weather)
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
