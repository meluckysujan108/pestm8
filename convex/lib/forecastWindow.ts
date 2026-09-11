/**
 * How far a forecast is worth asking for. Open-Meteo runs roughly 16 days
 * ahead and a few days back; outside that it returns nothing useful.
 *
 * Shared by the server action and the client hook deliberately. Both need to
 * know it — the server so it does not fetch, the client so it does not ask and
 * so it can tell "no forecast exists for this date" apart from "the forecast
 * has not arrived yet". Those are different things on screen: the first should
 * render nothing, the second a placeholder. When the constant lived only on
 * the server, the client could not draw that distinction at all.
 *
 * Pure module, no Convex imports, so the client can bundle it.
 */
export const FORECAST_AHEAD_DAYS = 14
export const FORECAST_BEHIND_DAYS = 2

/**
 * `todayKey` is the caller's own "today", which must be computed in the
 * TENANT's timezone. Defaulting it to UTC would be wrong for every Australian
 * tenant for the first 8–11 hours of each local day: local `today + 14` would
 * compute as 15 days out and be excluded. Invisible while only one day is ever
 * requested; wrong every morning once a month range asks for the whole window.
 */
export function withinForecastWindow(dayKey: string, todayKey: string): boolean {
  const day = Date.parse(`${dayKey}T00:00:00Z`)
  const today = Date.parse(`${todayKey}T00:00:00Z`)
  if (Number.isNaN(day) || Number.isNaN(today)) return false

  const days = Math.round((day - today) / 86_400_000)
  return days >= -FORECAST_BEHIND_DAYS && days <= FORECAST_AHEAD_DAYS
}

/**
 * Normalised suburb identity. Mirrored on both sides of the wire, so it lives
 * here rather than being copy-pasted with a comment asking the next person to
 * keep two versions in step.
 */
export function suburbKeyOf(suburb: string, postcode: string): string {
  return `${suburb.trim().toLowerCase().replace(/\s+/g, '-')}-${postcode.trim()}`
}

/**
 * The key a forecast is stored and looked up under. Composite because a single
 * day can span several suburbs — keying by `dayKey` alone lets one suburb's
 * forecast silently overwrite another's.
 *
 * Two spellings for the same key: the server already holds a normalised
 * `suburbKey`, while callers holding a raw suburb + postcode want to skip that
 * step. One of these delegates to the other so the two can never disagree —
 * which is exactly how the previously-hand-mirrored copies drifted.
 */
export function compositeKeyOf(suburbKey: string, dayKey: string): string {
  return `${suburbKey}|${dayKey}`
}

export function weatherKeyOf(
  suburb: string,
  postcode: string,
  dayKey: string,
): string {
  return compositeKeyOf(suburbKeyOf(suburb, postcode), dayKey)
}
