import { AU_STATES } from '#/lib/au'
import { normaliseForSearch } from '#/lib/searchMatch'
import { stateOfPostcode } from '../../convex/lib/postcodes'

/**
 * Street address suggestions for the client and site forms (Prompt 6.2).
 *
 * The provider is Photon, the free keyless OpenStreetMap geocoder, called from
 * the browser and never through Convex: Convex sends every app's requests from
 * shared addresses, and Open-Meteo's per-IP allowance is already used up there
 * by other apps some days (convex/weather.ts). From the browser, each phone is
 * its own allowance.
 *
 * Photon returns the street, suburb, state and postcode correctly for Perth
 * and Darwin, but it matches streets, not houses. So only the street part of
 * what was typed is sent, every result is taken as its street, and the house
 * number typed is carried onto it: "12 Walcott St Mt Lawley" becomes
 * "12 Walcott Street, Mount Lawley WA 6050". A number from Photon is never
 * offered in place of the one typed. The rules below were worked out against
 * real replies, kept in `addressLookup.fixtures.ts`.
 */

export type AddressSuggestion = {
  /** Unique within one list; also what duplicates are recognised by. */
  key: string
  /** "12 Walcott Street, Mount Lawley WA 6050" */
  label: string
  /** The street part only, e.g. "12 Walcott Street". The suburb is kept
   * apart and appended where it is needed (maps links, reports). */
  addressLine: string
  suburb: string
  /** A state code from AU_STATES: WA, NT, … */
  state: string
  /** Four digits, or '' when Photon had no usable one. */
  postcode: string
}

const PHOTON_API = 'https://photon.komoot.io/api/'

/** How long a request may take before the person is left to type. */
const REQUEST_TIMEOUT_MS = 6000

/** Mainland Australia and Tasmania, west, south, east, north. Keeps a
 * "Smith St" search out of Trinidad, Ontario and Taupō. */
const AUSTRALIA_BBOX = '112,-44,154,-10'

/**
 * Where to lean the results when the business's state is known: its capital.
 * The bias is weak, so the results are also put in the business's state first
 * after they come back.
 */
const CAPITALS: Record<string, { lat: number; lon: number }> = {
  ACT: { lat: -35.2809, lon: 149.13 },
  NSW: { lat: -33.8688, lon: 151.2093 },
  NT: { lat: -12.4637, lon: 130.8444 },
  QLD: { lat: -27.4698, lon: 153.0251 },
  SA: { lat: -34.9285, lon: 138.6007 },
  TAS: { lat: -42.8821, lon: 147.3272 },
  VIC: { lat: -37.8136, lon: 144.9631 },
  WA: { lat: -31.9523, lon: 115.8613 },
}

/** Photon's own bias radius (zoom 16) is a few streets; 8 spans a metro area. */
const BIAS_ZOOM = '8'

/** Headroom for the results thrown away below, so five can still be shown. */
const FETCH_LIMIT = '10'
const MAX_SUGGESTIONS = 5

/** Fewer letters of street than this matches half of Australia. */
const MIN_STREET_CHARS = 3

/** Ways Photon files as streets that nobody lives on. */
export const NOT_A_STREET: ReadonlySet<string> = new Set([
  'abandoned',
  'bridleway',
  'bus_stop',
  'busway',
  'corridor',
  'cycleway',
  'footway',
  'path',
  'platform',
  'proposed',
  'raceway',
  'steps',
])

/** Words that say what kind of street it is, not which one. */
export const STREET_TYPES: ReadonlySet<string> = new Set([
  'av',
  'ave',
  'avenue',
  'blvd',
  'boulevard',
  'bvd',
  'cct',
  'circuit',
  'cl',
  'close',
  'court',
  'cr',
  'cres',
  'crescent',
  'ct',
  'dr',
  'drive',
  'esp',
  'esplanade',
  'gr',
  'grove',
  'highway',
  'hwy',
  'lane',
  'ln',
  'loop',
  'parade',
  'pde',
  'pl',
  'place',
  'rd',
  'road',
  'sq',
  'square',
  'st',
  'street',
  'tce',
  'terrace',
  'the',
  'way',
  'wy',
])

/** How a street's own words get shortened when typed: "East Pt Rd" is East
 * Point Road, "Mt Eliza Rd" Mount Eliza Road. */
export const SHORT_FORMS: Readonly<Record<string, string>> = {
  bch: 'beach',
  ck: 'creek',
  gt: 'great',
  hts: 'heights',
  mt: 'mount',
  nth: 'north',
  pk: 'park',
  pt: 'point',
  sth: 'south',
  // Perth's numbered avenues (Mount Lawley, Inglewood, Maylands) are typed
  // with digits and named in words, or now and then the other way round.
  '1st': 'first',
  '2nd': 'second',
  '3rd': 'third',
  '4th': 'fourth',
  '5th': 'fifth',
  '6th': 'sixth',
  '7th': 'seventh',
  '8th': 'eighth',
  '9th': 'ninth',
  '10th': 'tenth',
}

/** How the words before a unit number get written, as they go back into the
 * field. */
const UNIT_WORDS: Record<string, string> = {
  u: 'Unit',
  unit: 'Unit',
  apt: 'Apt',
  apartment: 'Apt',
  flat: 'Flat',
  shop: 'Shop',
  suite: 'Suite',
  level: 'Level',
  lvl: 'Level',
}

/** "3rd Avenue": a street that starts with a number, not a house. */
const ORDINAL_START = /^\d+(?:st|nd|rd|th)\b/i

/**
 * The house part at the start of what was typed ("12", "12A", "3/12",
 * "Unit 3/12", "12-14", "Lot 50"), tidied as it goes back into the field,
 * and the rest.
 *
 * The number must stand alone, so "3rd Avenue" stays a street. A number with
 * nothing after it yet is a house with no street typed.
 */
export function splitHouseToken(typed: string): {
  token: string | null
  street: string
} {
  const clean = typed.replace(/\s+/g, ' ').trim()

  // Every group always takes part, if only as '': TypeScript types a group
  // as a string whether it matched or not.
  const lot = /^lot\s*(\d+[a-z]?)(?:[\s,]+|$)(.*)$/i.exec(clean)
  if (lot) {
    return { token: `Lot ${lot[1].toUpperCase()}`, street: lot[2].trim() }
  }

  // "3/12", "1-3/12", "Unit 3/12", "U3/12", "Shop 2/45", and with a word in
  // front the comma form too: "Unit 3, 12", "Suite 4, 100". Business clients
  // (Prompt 6.1) are the ones in shops, suites and levels.
  const unit =
    /^(?:(unit|u|apt|apartment|flat|shop|suite|level|lvl)\.?\s*)?(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)\s*(\/|,)\s*(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)(?:[\s,]+|$)(.*)$/i.exec(
      clean,
    )
  // A comma with no word before it is not a unit: "3, 12" is just unclear.
  if (unit && (unit[1] || unit[3] === '/')) {
    const tidy = (n: string) => n.replace(/\s/g, '').toUpperCase()
    const word = unit[1] ? UNIT_WORDS[unit[1].toLowerCase()] : undefined
    const numbers =
      unit[3] === '/'
        ? `${tidy(unit[2])}/${tidy(unit[4])}`
        : `${tidy(unit[2])}, ${tidy(unit[4])}`
    return {
      token: word ? `${word} ${numbers}` : numbers,
      street: unit[5].trim(),
    }
  }

  const house = /^(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)(?:[\s,]+|$)(.*)$/i.exec(
    clean,
  )
  if (house) {
    return {
      token: house[1].replace(/\s/g, '').toUpperCase(),
      street: house[2].trim(),
    }
  }

  return { token: null, street: clean }
}

/**
 * What is sent to Photon for what was typed: the street part alone, or null
 * when too little of it has been typed to be worth asking.
 *
 * Never the number. With one in the query Photon stops tolerating any word
 * it cannot match: "12 Walcott St Mt Lawley", "12 East Pt Rd Fannie Bay" and
 * "Lot 50 Whitewood Road Howard Springs" all find nothing, and the same
 * without the number find the street. Its matches are streets either way.
 */
function photonQueryOf(typed: string): string | null {
  const { street } = splitHouseToken(typed)
  // A street part that still starts with a number was not read as a house
  // ("3, 12 …", "12/ …"): sent, the numbers find junk, and a pick would put
  // a bare street over what was typed. Better no suggestion. "3rd Avenue"
  // is a street.
  if (/^\d/.test(street) && !ORDINAL_START.test(street)) return null
  const letters = street.replace(/[^\p{L}\p{N}]/gu, '')
  return letters.length < MIN_STREET_CHARS ? null : street
}

export function photonUrl(query: string, biasState?: string): string {
  const params = new URLSearchParams({
    q: photonQueryOf(query) ?? query.trim(),
    limit: FETCH_LIMIT,
    bbox: AUSTRALIA_BBOX,
  })
  // Houses and streets only: no suburbs, towns or states on their own.
  params.append('layer', 'house')
  params.append('layer', 'street')
  const centre = biasState ? CAPITALS[biasState.toUpperCase()] : undefined
  if (centre) {
    params.set('lat', String(centre.lat))
    params.set('lon', String(centre.lon))
    params.set('zoom', BIAS_ZOOM)
  }
  return `${PHOTON_API}?${params}`
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function wordsOf(value: string): Array<string> {
  return normaliseForSearch(value).split(/\s+/).filter(Boolean)
}

/** The same word, allowing for one still being typed ("Scarb") or a slip
 * near the end ("Mudstome"). */
function sameWord(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length)
  if (shorter < 3) return a === b
  let common = 0
  while (common < shorter && a[common] === b[common]) common += 1
  return common >= Math.min(shorter, 4)
}

/**
 * Whether a result's street is the one typed, judged by the first word that
 * names it ("Walcott" in "Walcott Street", "Georges" in "St Georges
 * Terrace").
 *
 * Photon also matches a shop or a hospital by its own name, and hands back
 * the street it is on: "Walcott St Mt Lawley" brings St John of God Mt Lawley
 * Hospital, on Thirlmere Road. Those go. The shops that are on the street
 * typed stay, as that street; "Marine Pde Cottesloe" brings nothing but
 * them.
 */
function isStreetTyped(street: string, typedWords: Array<string>): boolean {
  const first = wordsOf(street).find((word) => !STREET_TYPES.has(word))
  if (first === undefined) return true
  const naming = SHORT_FORMS[first] ?? first
  return typedWords.some((word) => sameWord(naming, SHORT_FORMS[word] ?? word))
}

/** Photon gives the state both ways: "Western Australia" on most results,
 * "WA" on some shops and houses. */
function stateCodeOf(raw: string, postcode: string): string {
  const lower = raw.toLowerCase()
  const match = AU_STATES.find(
    (s) => s.code.toLowerCase() === lower || s.name.toLowerCase() === lower,
  )
  return match?.code ?? stateOfPostcode(postcode) ?? ''
}

/** One Photon result read as a street in a place. */
export type PhotonStreet = {
  /** "Walcott Street": the street itself, or the street a shop is on. */
  street: string
  /** The suburb as it goes into the form: see `readPhotonStreet`. */
  suburb: string
  /** Every name Photon gives the place ("Mount Lawley", "Perth", "Calleya"),
   * for matching a suburb typed by hand against whichever it used. */
  places: Array<string>
  /** A state code from AU_STATES. */
  state: string
  /** Four digits, or ''. */
  postcode: string
}

/** Photon's features, or [] for a reply that is not a FeatureCollection. */
export function photonFeaturesOf(json: unknown): Array<unknown> {
  if (typeof json !== 'object' || json === null) return []
  const features = (json as { features?: unknown }).features
  return Array.isArray(features) ? features : []
}

/**
 * One Photon feature as the Australian street it is on, or null when it is
 * not one: another country, a footpath or cycleway, no name, no state.
 * Anything that is not the expected shape is null, never thrown on.
 */
export function readPhotonStreet(feature: unknown): PhotonStreet | null {
  if (typeof feature !== 'object' || feature === null) return null
  const props = (feature as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return null
  const p = props as Record<string, unknown>

  if (text(p.countrycode).toUpperCase() !== 'AU') return null

  let street = ''
  if (p.type === 'street') {
    const kind = text(p.osm_value)
    if (text(p.osm_key) === 'highway' && NOT_A_STREET.has(kind)) return null
    street = text(p.name)
  } else if (p.type === 'house') {
    street = text(p.street)
  }
  if (!street) return null

  // District is the suburb ("Mount Lawley", where city is all of "Perth");
  // a country town has only a city. Locality comes last: it is the estate
  // ("Calleya") inside the suburb (Treeby) when both are there.
  const places = [text(p.district), text(p.city), text(p.locality)]
  const suburb = places.find(Boolean) ?? ''
  const rawPostcode = text(p.postcode)
  const postcode = /^\d{4}$/.test(rawPostcode) ? rawPostcode : ''
  const state = stateCodeOf(text(p.state), postcode)
  if (!suburb || !state) return null
  return { street, suburb, places: places.filter(Boolean), state, postcode }
}

/**
 * Photon's reply as the suggestions to show for what was typed, best first.
 * Anything that is not the expected shape is skipped, never thrown on.
 */
export function parsePhotonResponse(
  json: unknown,
  typed: string,
  biasState?: string,
): Array<AddressSuggestion> {
  const { token, street: typedStreet } = splitHouseToken(typed)
  const typedWords = wordsOf(typedStreet)
  const found: Array<AddressSuggestion> = []

  for (const feature of photonFeaturesOf(json)) {
    const place = readPhotonStreet(feature)
    if (!place || !isStreetTyped(place.street, typedWords)) continue
    const { street, suburb, state, postcode } = place

    const addressLine = token ? `${token} ${street}` : street
    found.push({
      key: `${addressLine}|${suburb}|${postcode}`.toLowerCase(),
      label: `${addressLine}, ${suburb} ${state} ${postcode}`.trim(),
      addressLine,
      suburb,
      state,
      postcode,
    })
  }

  const home = biasState?.trim().toUpperCase()
  const ordered = home
    ? [
        ...found.filter((s) => s.state === home),
        ...found.filter((s) => s.state !== home),
      ]
    : found

  const seen = new Set<string>()
  const unique: Array<AddressSuggestion> = []
  for (const suggestion of ordered) {
    if (seen.has(suggestion.key)) continue
    seen.add(suggestion.key)
    unique.push(suggestion)
  }
  return unique.slice(0, MAX_SUGGESTIONS)
}

/**
 * Set to 'on' in localStorage to let a browser under automation reach Photon
 * and the other services the forms check against. See
 * `networkLookupsAllowed`.
 */
export const LOOKUP_UNDER_AUTOMATION_KEY = 'pestm8:address-lookup'

/**
 * Whether the forms may ask anything over the network: address suggestions,
 * the street check at save (addressVerify.ts), the email domain check. Off
 * when the browser is being driven by a test runner (`navigator.webdriver` —
 * Playwright sets it), unless the test opts in.
 *
 * The e2e suite types dozens of street addresses a run. Left on, every one of
 * them would reach a free public service that asks to be used fairly, and the
 * suite's results would hang on that service being up. With it off, only the
 * offline checks run there. A spec that is ABOUT the lookup opts in and
 * answers the requests itself (`page.route`).
 */
export function networkLookupsAllowed(): boolean {
  if (typeof navigator === 'undefined' || !navigator.webdriver) return true
  try {
    return localStorage.getItem(LOOKUP_UNDER_AUTOMATION_KEY) === 'on'
  } catch {
    return false
  }
}

/** The browser says there is no connection at all. One bar that answers
 * nothing still counts as online, which is what the time limits are for. */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * A GET that gives up after `timeoutMs`, or when `signal` is aborted, and
 * never throws: the reply's JSON, or `ok: false` for any failure at all
 * (refused, timed out, aborted, an error status, not JSON).
 *
 * Pass `headers` only when the service needs one: any header beyond the
 * simple ones makes the browser ask the service's permission first (a CORS
 * preflight), which is one more round trip on one bar of signal.
 */
export async function getJsonWithin(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs: number; headers?: HeadersInit },
): Promise<{ ok: true; json: unknown } | { ok: false }> {
  const controller = new AbortController()
  const giveUp = setTimeout(() => controller.abort(), opts.timeoutMs)
  const cancel = () => controller.abort()
  if (opts.signal?.aborted) controller.abort()
  opts.signal?.addEventListener('abort', cancel)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      ...(opts.headers ? { headers: opts.headers } : {}),
    })
    if (!res.ok) return { ok: false }
    return { ok: true, json: await res.json() }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(giveUp)
    opts.signal?.removeEventListener('abort', cancel)
  }
}

/** What one lookup came to, for the line under the field. */
export type AddressLookup = {
  /**
   * 'found': suggestions to show. 'none': Photon answered and nothing fits.
   * 'failed': offline, refused, timed out, aborted or garbled. 'skipped':
   * never asked, because too little of a street has been typed or a test
   * runner is driving the browser; the field says nothing then.
   */
  status: 'found' | 'none' | 'failed' | 'skipped'
  suggestions: Array<AddressSuggestion>
}

/** Whether what was typed would be looked up at all: enough of a street,
 * and lookups allowed. Lets the field say "Searching…" only when it is. */
export function addressLookupWanted(typed: string): boolean {
  return networkLookupsAllowed() && photonQueryOf(typed) !== null
}

/**
 * Suggestions for what was typed, and how the asking went. Never throws.
 */
export async function lookUpAddresses(
  query: string,
  opts: { signal: AbortSignal; biasState?: string },
): Promise<AddressLookup> {
  if (!addressLookupWanted(query)) return { status: 'skipped', suggestions: [] }
  if (isOffline()) return { status: 'failed', suggestions: [] }
  // Given up on after a few seconds: on a site with one bar, a stalled
  // request would otherwise leave the person waiting on a list that is never
  // coming, when typing the rest by hand is quicker.
  const reply = await getJsonWithin(photonUrl(query, opts.biasState), {
    signal: opts.signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  // A reply that is not a FeatureCollection at all (a proxy's error page, a
  // captive portal's JSON) is a failure, not "no matching street".
  const features =
    reply.ok && typeof reply.json === 'object' && reply.json !== null
      ? (reply.json as { features?: unknown }).features
      : undefined
  if (!reply.ok || !Array.isArray(features)) {
    return { status: 'failed', suggestions: [] }
  }
  const suggestions = parsePhotonResponse(reply.json, query, opts.biasState)
  return { status: suggestions.length > 0 ? 'found' : 'none', suggestions }
}

/**
 * Suggestions for what was typed, or [] for any failure at all: offline, a
 * refused or broken reply, or the request being aborted because more was
 * typed. The field works exactly as a plain input without them.
 */
export async function searchAddresses(
  query: string,
  opts: { signal: AbortSignal; biasState?: string },
): Promise<Array<AddressSuggestion>> {
  return (await lookUpAddresses(query, opts)).suggestions
}

/** The indefinite article for a state code as it is read aloud: "an NT",
 * "a WA". */
const AN_STATES = new Set(['ACT', 'NSW', 'NT', 'SA'])

/**
 * The postcode's own state when it disagrees with the state chosen, for a
 * quiet hint under the fields. Prod has "Darwin 2209" and "Fannybay WA 0810".
 *
 * Only a hint: a handful of border towns really do use the neighbour's
 * postcodes (Barooga NSW is 3644), so it never stops a save.
 */
export function postcodeStateHint(
  postcode: string,
  state: string,
): { state: string; message: string } | null {
  const own = stateOfPostcode(postcode)
  if (own === undefined || own === state.trim().toUpperCase()) return null
  const article = AN_STATES.has(own) ? 'an' : 'a'
  return {
    state: own,
    message: `${postcode.trim()} is ${article} ${own} postcode.`,
  }
}
