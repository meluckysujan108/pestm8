/**
 * The state an Australian postcode belongs to, or undefined for anything that
 * is not one ("", "0000", "6O53").
 *
 * The weather lookup finds a suburb by name within a state, and caches the
 * place under suburb + postcode for every business. The state typed on a
 * property is the weaker of the two facts — a new property starts as WA — so
 * the postcode's state is tried first and a wrong pick cannot put a NSW
 * suburb's forecast in Perth for everyone. The handful of border towns that
 * use the neighbour's postcodes (Barooga NSW is 3644) still resolve, because
 * the property's own state is tried next (convex/weather.ts).
 */
export function stateOfPostcode(postcode: string): string | undefined {
  const code = postcode.trim()
  if (!/^\d{4}$/.test(code)) return undefined
  const n = Number(code)
  if (n >= 200 && n <= 299) return 'ACT'
  if (n >= 800 && n <= 999) return 'NT'
  if ((n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return 'ACT'
  if (n >= 1000 && n <= 2999) return 'NSW'
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return 'VIC'
  if ((n >= 4000 && n <= 4999) || n >= 9000) return 'QLD'
  if (n >= 5000 && n <= 5999) return 'SA'
  if (n >= 6000 && n <= 6999) return 'WA'
  if (n >= 7000 && n <= 7999) return 'TAS'
  return undefined
}
