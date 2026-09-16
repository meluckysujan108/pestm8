import { RAIN_WARN_MM, WIND_WARN_KMH } from '../../../convex/lib/forecastWindow'

/**
 * The forecast, in the words a form actually offers.
 *
 * The cache holds numbers and a WMO code; the forms offer a fixed handful of
 * verbatim words, and the two vocabularies differ per form — the Service
 * Report has five (…Evening), the AS forms seven (…Prolonged Dry Period).
 * Rather than a table per form, this picks from whatever options the field
 * declares and returns only words that field has: a form that does not offer
 * "Windy" simply gets no windy answer.
 *
 * Deliberately never suggested: "Prolonged Dry Period" and "Prolonged Wet
 * Period" are claims about a season, not a day, and a three-day forecast
 * cannot support either. The technician picks those.
 */

export type DayForecast = {
  rainMm?: number
  windKmh?: number
  /** WMO weather code, as Open-Meteo returns it. */
  code?: number
}

/** WMO codes 0-1 are clear or mainly clear; 3 is overcast. */
const CLEAR_CODES = new Set([0, 1])
const OVERCAST_CODE = 3

/**
 * @param startHour local hour work began, when known. Five-option forms treat
 *   a late start as "Evening", which is a fact about the visit rather than the
 *   sky, so it is added alongside the weather rather than instead of it.
 */
export function weatherAnswerFrom(
  forecast: DayForecast | null | undefined,
  options: Array<string>,
  startHour?: number,
): Array<string> {
  const has = (word: string) => options.includes(word)
  const answer: Array<string> = []

  if (forecast) {
    // Wind first: a wet day a technician can work around, a windy one changes
    // whether a spray goes on the wall or the neighbour's washing.
    if ((forecast.windKmh ?? 0) >= WIND_WARN_KMH && has('Windy')) answer.push('Windy')
    if ((forecast.rainMm ?? 0) >= RAIN_WARN_MM && has('Wet')) answer.push('Wet')

    if (answer.length === 0) {
      if (forecast.code === OVERCAST_CODE && has('Overcast')) answer.push('Overcast')
      else if (forecast.code !== undefined && CLEAR_CODES.has(forecast.code) && has('Sunny')) {
        answer.push('Sunny')
      } else if (has('Dry')) answer.push('Dry')
    }
  }

  if (startHour !== undefined && startHour >= 17 && has('Evening')) answer.push('Evening')
  return answer
}
