import { editDistance } from '../../convex/lib/contactNames'
import { stateOfPostcode } from '../../convex/lib/postcodes'
import {
  SHORT_FORMS,
  STREET_TYPES,
  getJsonWithin,
  isOffline,
  networkLookupsAllowed,
  photonFeaturesOf,
  postcodeStateHint,
  readPhotonStreet,
  splitHouseToken,
} from '#/lib/addressLookup'
import { AU_STATES } from '#/lib/au'
import { normaliseForSearch } from '#/lib/searchMatch'

/**
 * The checks an address gets before a form saves it (field verification).
 *
 * Three kinds, kept apart because they fail differently:
 * - `addressErrors`: the one thing that can never work, a postcode that is not
 *   four digits. Synchronous, and the only check that blocks a save.
 * - `checkAddressOffline`: the suburb, state and postcode against each other,
 *   from G-NAF's suburb tables (src/lib/localities, built by
 *   scripts/build-localities.mjs). No network: a technician at a door with
 *   one bar still gets them. Warnings only.
 * - `checkStreetOnline`: whether the map knows the street in that suburb.
 *   Photon, from the browser, given up on after 3 seconds. Anything short of
 *   a clear answer says nothing. Warnings only.
 *
 * Every warning is worded as "couldn't find" or "usually", never "wrong":
 * the person at the door is looking at the letterbox, and a new estate can be
 * missing from the map and the tables for a year. The form shows them above
 * Save and lets the second press save anyway.
 *
 * The offline checks run at save on the four fields as they are then, even
 * after a suggestion was picked: a browser's or password manager's autofill
 * can rewrite the suburb and postcode after the pick. `addressSignature` says
 * whether they still hold what was picked; when they do not, the address is
 * treated as typed by hand and the street check runs too
 * (`checkAddressAtSave`).
 */

export type AddressValue = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
}

export type AddressField = keyof AddressValue

export type AddressIssue = {
  /** The field the issue is shown against, and focused for. */
  field: AddressField
  /** 'error' blocks the save; 'warning' asks for a second press. */
  level: 'error' | 'warning'
  /** A whole sentence for the person typing. */
  message: string
  /** A one-tap fix: the button's words, and what it puts in the fields. */
  fix?: { label: string; patch: Partial<AddressValue> }
}

export type StreetCheck = {
  /**
   * 'found': the map has the street in that suburb. 'not-found': the map
   * knows the suburb and not the street (with `issue`). 'unchecked': no
   * clear answer — offline, blocked, slow, a test runner driving the browser,
   * too little typed, or the map does not know the suburb either.
   */
  status: 'found' | 'not-found' | 'unchecked'
  issue?: AddressIssue
}

const STATE_CODES: ReadonlySet<string> = new Set(AU_STATES.map((s) => s.code))

function stateCode(raw: string): string {
  const code = raw.trim().toUpperCase()
  return STATE_CODES.has(code) ? code : ''
}

// ---------------------------------------------------------------------------
// Hard errors

/**
 * The problems that stop a save, as the person types: only a postcode that is
 * not four digits, which no address can have. Blank is the form's business.
 *
 * The NT's and the ACT's postcodes start with a 0 that people drop ("810"),
 * so a three-digit one that becomes the chosen state's with the 0 back gets
 * that as its fix.
 */
export function addressErrors(value: AddressValue): Array<AddressIssue> {
  const typed = value.postcode.trim()
  if (typed === '' || /^\d{4}$/.test(typed)) return []

  const digits = typed.replace(/\s/g, '')
  const state = stateCode(value.state)
  let fixed: string | null = null
  if (/^\d{4}$/.test(digits)) fixed = digits
  else if (/^\d{3}$/.test(digits) && stateOfPostcode(`0${digits}`) === state) {
    fixed = `0${digits}`
  }

  const message =
    fixed !== null && fixed.startsWith('0') && !digits.startsWith('0')
      ? `A postcode has 4 digits. ${state} postcodes start with a 0.`
      : 'A postcode has 4 digits.'
  return [
    {
      field: 'postcode',
      level: 'error',
      message,
      ...(fixed !== null
        ? { fix: { label: `Use ${fixed}`, patch: { postcode: fixed } } }
        : {}),
    },
  ]
}

// ---------------------------------------------------------------------------
// The suburb tables

export type Locality = {
  /** As G-NAF has it: "Mount Lawley", "Fannie Bay", "O'Connor". */
  name: string
  /** `suburbKey(name)`. */
  key: string
  /** Every postcode street addresses in it use, the most used first. */
  postcodes: Array<string>
}

export type LocalityTable = {
  state: string
  /** In the table's order: the most addresses first. */
  all: Array<Locality>
  /** `suburbKey` → every locality with that key. Two can share one: NSW has
   * one Punchbowl in 2196 and another in 2460. */
  byKey: Map<string, Array<Locality>>
  /** Every postcode any street address in the state uses. One that is not
   * here is a PO-box or large-customer postcode (Perth 6001, Midland 6936),
   * which is never taken as a mistake. */
  postcodes: Set<string>
}

/** How suburb names get shortened, both in what is typed and in G-NAF's own
 * names (it has "Mt Liebig" and "Mount Lawley", "St Kilda" and no Saints). */
const SUBURB_SHORT_FORMS: Readonly<Record<string, string>> = {
  mt: 'mount',
  st: 'saint',
  nth: 'north',
  sth: 'south',
}

function suburbWords(name: string): Array<string> {
  return normaliseForSearch(name.replace(/['’]/g, ''))
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => SUBURB_SHORT_FORMS[word] ?? word)
}

/**
 * A suburb name compared the way people type it: case, spaces, hyphens,
 * apostrophes, "Mt"/"Mount", "St"/"Saint" and "Nth"/"Sth" set aside.
 * "Mt Lawley", "mount lawley" and "MountLawley" are one key.
 */
export function suburbKey(name: string): string {
  return suburbWords(name).join('')
}

/** One table's text ("<name> <postcode> <postcode>…" a line) as a table. */
export function parseLocalities(state: string, text: string): LocalityTable {
  const all: Array<Locality> = []
  const byKey = new Map<string, Array<Locality>>()
  const postcodes = new Set<string>()
  for (const line of text.split('\n')) {
    const match = /^(.*?)((?: \d{4})+)$/.exec(line.trim())
    if (!match) continue
    const locality = {
      name: match[1],
      key: suburbKey(match[1]),
      postcodes: match[2].trim().split(' '),
    }
    all.push(locality)
    byKey.set(locality.key, [...(byKey.get(locality.key) ?? []), locality])
    for (const postcode of locality.postcodes) postcodes.add(postcode)
  }
  return { state, all, byKey, postcodes }
}

/**
 * One chunk per state, fetched the first time that state is checked: a WA
 * business never downloads NSW's 70 KB. The service worker keeps every chunk
 * it has fetched, so a table once loaded works with no signal.
 */
const TABLES = import.meta.glob<string>('./localities/*.ts', {
  import: 'default',
})

const tables = new Map<string, Promise<LocalityTable | null>>()

/**
 * A state's suburb table, or null for a state code there is none for, or a
 * chunk that could not be fetched (offline before it was ever loaded; the
 * next call tries again). Never rejects.
 *
 * Call it early — when a form opens, with the business's state — so the
 * table is in hand by the time Save is pressed.
 */
export function loadLocalities(state: string): Promise<LocalityTable | null> {
  const code = stateCode(state)
  const load = TABLES[`./localities/${code}.ts`] as
    (() => Promise<string>) | undefined
  if (!code || !load) return Promise.resolve(null)
  let table = tables.get(code)
  if (!table) {
    table = load().then(
      (text) => parseLocalities(code, text),
      () => {
        tables.delete(code)
        return null
      },
    )
    tables.set(code, table)
  }
  return table
}

type SuburbMatch =
  /** The suburb itself. */
  | { kind: 'exact'; localities: Array<Locality> }
  /**
   * The city's name for its centre, which G-NAF names differently: "Darwin"
   * for Darwin City, "Palmerston" for Palmerston City, "Canberra" for any of
   * the ACT. Accepted, and its postcode is not questioned.
   */
  | { kind: 'alias'; localities: Array<Locality> }

function findSuburb(table: LocalityTable, typed: string): SuburbMatch | null {
  const key = suburbKey(typed)
  if (key === '') return null
  const exact = table.byKey.get(key)
  if (exact) return { kind: 'exact', localities: exact }
  const city = table.byKey.get(`${key}city`)
  if (city) return { kind: 'alias', localities: city }
  if (table.state === 'ACT' && key === 'canberra') {
    return { kind: 'alias', localities: [] }
  }
  return null
}

/**
 * The suburb most likely meant, in one state's table, or null. A slip of a
 * letter or two ("Fanny Bay", "Fannybay" for Fannie Bay; one for a short
 * name), else the one suburb whose name starts with what was typed
 * ("Fannie"). Where two are equally close, the one more people live in.
 */
function closestSuburb(table: LocalityTable, typed: string): Locality | null {
  const key = suburbKey(typed)
  if (key.length < 4) return null
  const allowed = key.length <= 7 ? 1 : 2
  let best: Locality | null = null
  let bestDistance = Infinity
  for (const locality of table.all) {
    if (Math.abs(locality.key.length - key.length) > allowed) continue
    const distance = editDistance(key, locality.key)
    if (distance <= allowed && distance < bestDistance) {
      best = locality
      bestDistance = distance
    }
  }
  if (best) return best

  // Only when exactly one suburb starts that way: "Mount" alone names
  // dozens, and guessing one is worse than saying nothing.
  const words = suburbWords(typed)
  const starting = table.all.filter((locality) => {
    const theirs = suburbWords(locality.name)
    return (
      theirs.length > words.length && words.every((w, i) => theirs[i] === w)
    )
  })
  return starting.length === 1 ? starting[0] : null
}

/** "usually 6050", "usually 2196 or 2460". */
function usualPostcodes(postcodes: Array<string>): string {
  if (postcodes.length === 1) return postcodes[0]
  return `${postcodes.slice(0, -1).join(', ')} or ${postcodes[postcodes.length - 1]}`
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`
}

/** The locality of exactly that name in a state, or null. */
async function localityIn(
  state: string,
  typed: string,
): Promise<Locality | null> {
  const table = await loadLocalities(state)
  const match = table ? findSuburb(table, typed) : null
  return match?.localities[0] ?? null
}

/**
 * Where else a suburb of exactly that name is: the work area first, then the
 * rest in order. Loads the other tables, so only called when the suburb is
 * in neither the state chosen nor the postcode's.
 */
async function elsewhere(
  typed: string,
  skip: Array<string>,
  workState: string,
): Promise<{ state: string; locality: Locality } | null> {
  const order = [workState, ...AU_STATES.map((s) => s.code)].filter(
    (code, i, all) =>
      code !== '' && !skip.includes(code) && all.indexOf(code) === i,
  )
  for (const state of order) {
    const locality = await localityIn(state, typed)
    if (locality) return { state, locality }
  }
  return null
}

/**
 * The warnings for the suburb, state and postcode as they are now, from the
 * suburb tables alone: no network, never throws, never an error.
 *
 * - The address is outside the work area (`workState`, the business's own).
 * - The postcode is another state's: "2209 is an NSW postcode." The fix is
 *   the suburb's own postcode when the suburb is in the state chosen (the
 *   state was right: prod has "Darwin 2209"), else the postcode's state
 *   (the state was left on its default: "Fannie Bay WA 0820").
 * - The suburb is not in the state chosen: "Did you mean Fannie Bay?", or
 *   "Mount Lawley is in WA.", or that it could not be found at all.
 * - The postcode is not the suburb's: "Mount Lawley's postcode is usually
 *   6050." A suburb whose addresses use several postcodes accepts any of
 *   them, and a postcode no street address in the state uses (a PO box's) is
 *   never questioned.
 *
 * A table that cannot be loaded leaves out the checks that need it.
 */
export async function checkAddressOffline(
  value: AddressValue,
  opts: { workState?: string },
): Promise<Array<AddressIssue>> {
  const issues: Array<AddressIssue> = []
  const suburb = value.suburb.trim()
  const postcode = value.postcode.trim()
  const validPostcode = /^\d{4}$/.test(postcode)
  const postcodeState = validPostcode ? stateOfPostcode(postcode) : undefined
  const state = stateCode(value.state) || (postcodeState ?? '')
  const workState = stateCode(opts.workState ?? '')

  if (state && workState && state !== workState) {
    issues.push({
      field: 'state',
      level: 'warning',
      message: `This address is in ${state} — outside ${workState}, where you work.`,
    })
  }
  if (!state) return issues

  const table = await loadLocalities(state)
  const match = table && suburb ? findSuburb(table, suburb) : null

  // The postcode is another state's.
  let movedTo: string | null = null
  const hint = validPostcode ? postcodeStateHint(postcode, state) : null
  if (hint) {
    const own = match?.localities[0]
    const known = match?.localities.some((l) => l.postcodes.includes(postcode))
    // A place whose addresses use the neighbour's postcode, and that G-NAF
    // files under this state with it, is right as typed: Amata SA is 0872,
    // Wallaroo NSW 2618. (Barooga NSW, 3644, is filed under VIC only, and
    // costs its addresses one "Save anyway".)
    if (!known) {
      if (own) {
        const name = match.kind === 'alias' ? suburb : own.name
        issues.push({
          field: 'postcode',
          level: 'warning',
          message: `${hint.message} ${possessive(name)} is usually ${usualPostcodes(own.postcodes)}.`,
          fix: {
            label: `Use ${own.postcodes[0]}`,
            patch: { postcode: own.postcodes[0] },
          },
        })
      } else {
        movedTo = hint.state
        issues.push({
          field: 'postcode',
          level: 'warning',
          message: hint.message,
          fix: { label: `Use ${hint.state}`, patch: { state: hint.state } },
        })
      }
    }
  }

  if (!table || !suburb) return issues

  if (!match) {
    const issue = await suburbIssue(table, suburb, {
      postcodeState: postcodeState ?? '',
      workState,
      movedTo,
    })
    if (issue) issues.push(issue)
    return issues
  }

  // The postcode is not the suburb's, within the one state.
  if (
    match.kind === 'exact' &&
    validPostcode &&
    postcodeState === state &&
    table.postcodes.has(postcode) &&
    !match.localities.some((l) => l.postcodes.includes(postcode))
  ) {
    const locality = match.localities[0]
    const postcodes = [...new Set(match.localities.flatMap((l) => l.postcodes))]
    issues.push({
      field: 'postcode',
      level: 'warning',
      message: `${possessive(locality.name)} postcode is usually ${usualPostcodes(postcodes)}.`,
      fix: {
        label: `Use ${postcodes[0]}`,
        patch: { postcode: postcodes[0] },
      },
    })
  }
  return issues
}

/** Why a suburb that is not in the chosen state's table may be wrong, and
 * the fix, or null to say nothing. */
async function suburbIssue(
  table: LocalityTable,
  suburb: string,
  opts: { postcodeState: string; workState: string; movedTo: string | null },
): Promise<AddressIssue | null> {
  const state = table.state
  const postcodeState = opts.postcodeState !== state ? opts.postcodeState : ''

  // The same name in the postcode's own state beats a near miss here:
  // "Fannie Bay WA 0820" is Fannie Bay NT with the state left on WA.
  const inPostcodeState = postcodeState
    ? await localityIn(postcodeState, suburb)
    : null
  const close = inPostcodeState ? null : closestSuburb(table, suburb)
  if (close) {
    return {
      field: 'suburb',
      level: 'warning',
      message: `Couldn't find ${suburb} in ${state}. Did you mean ${close.name}?`,
      fix: { label: `Use ${close.name}`, patch: { suburb: close.name } },
    }
  }

  const found = inPostcodeState
    ? { state: postcodeState, locality: inPostcodeState }
    : await elsewhere(suburb, [state, postcodeState], opts.workState)
  if (found) {
    // Already said by the postcode's warning, whose fix is the same.
    if (found.state === opts.movedTo) return null
    return {
      field: 'suburb',
      level: 'warning',
      message: `${found.locality.name} is in ${found.state}, not ${state}.`,
      fix: { label: `Use ${found.state}`, patch: { state: found.state } },
    }
  }

  // A near miss in the postcode's state: "Fannybay WA 0810".
  const there = postcodeState ? await loadLocalities(postcodeState) : null
  const closeThere = there ? closestSuburb(there, suburb) : null
  if (closeThere) {
    return {
      field: 'suburb',
      level: 'warning',
      message: `Couldn't find ${suburb} in ${state}. Did you mean ${closeThere.name}, ${postcodeState}?`,
      fix: {
        label: `Use ${closeThere.name} ${postcodeState}`,
        patch: { suburb: closeThere.name, state: postcodeState },
      },
    }
  }

  return {
    field: 'suburb',
    level: 'warning',
    message: `Couldn't find a suburb called ${suburb} in ${state}.`,
  }
}

// ---------------------------------------------------------------------------
// Street names

/** The long form of each street type, so "Walcott St" and "Walcott Street"
 * are one street. */
const STREET_TYPE_LONG: Readonly<Record<string, string>> = {
  av: 'avenue',
  ave: 'avenue',
  blvd: 'boulevard',
  bvd: 'boulevard',
  cct: 'circuit',
  cl: 'close',
  cr: 'crescent',
  cres: 'crescent',
  ct: 'court',
  dr: 'drive',
  esp: 'esplanade',
  gr: 'grove',
  hwy: 'highway',
  ln: 'lane',
  pde: 'parade',
  pl: 'place',
  rd: 'road',
  sq: 'square',
  st: 'street',
  tce: 'terrace',
  wy: 'way',
}

/**
 * A street's name read the same way whoever wrote it: the words that name it
 * with their short forms spelled out ("East Pt" → east point, "3rd" →
 * third, a leading "St" → saint), and its type in full ("Rd" → road, '' when
 * none was typed). Stops at the type, so "Walcott St Mt Lawley" typed all in
 * the one field is Walcott Street. `words` is how many of the words typed
 * that took, for sending only the street.
 */
export function readStreetName(street: string): {
  name: string
  type: string
  words: Array<string>
} {
  const typed = normaliseForSearch(street.replace(/['’]/g, ''))
    .split(/\s+/)
    .filter(Boolean)
  const name: Array<string> = []
  let type = ''
  let used = 0
  for (const word of typed) {
    used += 1
    if (name.length > 0 && word !== 'the' && STREET_TYPES.has(word)) {
      type = STREET_TYPE_LONG[word] ?? word
      break
    }
    // "The Esplanade" is Esplanade.
    if (name.length === 0 && word === 'the') continue
    if (name.length === 0 && word === 'st') name.push('saint')
    else name.push(SHORT_FORMS[word] ?? word)
  }
  return { name: name.join(' '), type, words: typed.slice(0, used) }
}

/**
 * What an address has to keep for a picked suggestion to still stand: the
 * street's name (no house, unit or lot number, and "St" the same as
 * "Street"), the suburb, the state and the postcode. Fixing the house number
 * after a pick keeps it; autofill changing the suburb or postcode does not.
 */
export function addressSignature(value: AddressValue): string {
  const { street } = splitHouseToken(value.addressLine)
  const { name, type } = readStreetName(street)
  return [
    `${name} ${type}`.trim(),
    suburbKey(value.suburb),
    value.state.trim().toUpperCase(),
    value.postcode.trim(),
  ].join('|')
}

/** Whether the address is still the suggestion picked for it, if any. */
export function stillAsPicked(
  picked: AddressValue | null | undefined,
  now: AddressValue,
): boolean {
  return !!picked && addressSignature(picked) === addressSignature(now)
}

// ---------------------------------------------------------------------------
// The street check

const PHOTON_STRUCTURED = 'https://photon.komoot.io/structured'

/** Short: it runs while Save waits. A slow answer is no answer. */
const STREET_CHECK_TIMEOUT_MS = 3000

/** Room for the other states' places of the same name, which come first
 * (Beaufort Street, Fannie Bay brings Rose Bay NSW before Fannie Bay). */
const STREET_CHECK_LIMIT = '15'

/**
 * The request for the street in the suburb, or null when there is too little
 * to ask about. Only the street's name and the suburb are sent: never the
 * house, unit or lot number.
 */
export function streetCheckUrl(value: AddressValue): string | null {
  const { street } = splitHouseToken(value.addressLine)
  const { name, words } = readStreetName(street)
  const suburb = value.suburb.replace(/\s+/g, ' ').trim()
  // A street part that still starts with a digit is a number not read as
  // one ("3, 12 …"); "3rd Avenue" is a street.
  if (/^\d/.test(street) && !/^\d+(?:st|nd|rd|th)\b/i.test(street)) return null
  if (name.replace(/[^\p{L}\p{N}]/gu, '').length < 3 || suburb === '') {
    return null
  }
  const params = new URLSearchParams({
    street: words.join(' '),
    city: suburb,
    countrycode: 'AU',
    layer: 'street',
    limit: STREET_CHECK_LIMIT,
  })
  return `${PHOTON_STRUCTURED}?${params}`
}

/**
 * Photon's structured reply read against what was typed. Pure, for the tests.
 *
 * Photon matches the suburb loosely and the state not at all, and when it
 * cannot find the street it sends other streets instead: the nearest spelling
 * ("Walcot Street" brings Walcott Street), other streets in the suburb, or
 * streets in a town of that name in another state. So:
 * - found: a street of the same name (type too, when both have one) in the
 *   state, in a place of the typed suburb's name.
 * - not-found: no such street, and at least one street back from the typed
 *   suburb in the state — the map knows the suburb, and not the street.
 * - unchecked otherwise: the map does not know the suburb (a new estate), or
 *   has the street only in a neighbouring suburb (a street on a boundary is
 *   filed under one side).
 */
export function readStreetCheck(
  json: unknown,
  value: AddressValue,
  workState?: string,
): StreetCheck {
  const { token, street: typedStreet } = splitHouseToken(value.addressLine)
  const typed = readStreetName(typedStreet)
  const state =
    stateCode(value.state) ||
    stateOfPostcode(value.postcode) ||
    stateCode(workState ?? '')
  const suburb = suburbKey(value.suburb)
  if (!typed.name || !suburb || !state) return { status: 'unchecked' }

  const sameStreet = (theirs: { name: string; type: string }) =>
    theirs.name === typed.name &&
    (!typed.type || !theirs.type || theirs.type === typed.type)

  const inSuburb: Array<{ street: string; name: string; type: string }> = []
  let elsewhereInState = false
  for (const feature of photonFeaturesOf(json)) {
    const place = readPhotonStreet(feature)
    if (!place || place.state !== state) continue
    const theirs = readStreetName(place.street)
    const here = place.places.some((p) => suburbKey(p) === suburb)
    if (sameStreet(theirs)) {
      if (here) return { status: 'found' }
      elsewhereInState = true
    }
    // The suburb itself, not the city around it: a street back from
    // "Perth" as the city of a Mount Lawley street says nothing about the
    // suburb Perth.
    if (suburbKey(place.suburb) === suburb) {
      inSuburb.push({ street: place.street, ...theirs })
    }
  }
  if (elsewhereInState || inSuburb.length === 0) return { status: 'unchecked' }

  const shown = typedStreet.replace(/\s+/g, ' ').trim()
  const where = value.suburb.replace(/\s+/g, ' ').trim()
  const close = closestStreet(typed, inSuburb)
  const line = close ? (token ? `${token} ${close}` : close) : null
  return {
    status: 'not-found',
    issue: {
      field: 'addressLine',
      level: 'warning',
      message: close
        ? `Couldn't find ${shown} in ${where} on the map. Did you mean ${close}?`
        : `Couldn't find ${shown} in ${where} on the map.`,
      ...(line
        ? { fix: { label: `Use ${close}`, patch: { addressLine: line } } }
        : {}),
    },
  }
}

/** The street back from the suburb most likely meant: the same name with
 * another type ("Walcott Road" for Walcott Street), or a slip of a letter or
 * two in the name. */
function closestStreet(
  typed: { name: string; type: string },
  found: Array<{ street: string; name: string; type: string }>,
): string | null {
  const key = typed.name.replace(/\s/g, '')
  const allowed = key.length <= 5 ? 1 : 2
  let best: string | null = null
  let bestDistance = Infinity
  for (const street of found) {
    const distance = editDistance(key, street.name.replace(/\s/g, ''))
    if (distance <= allowed && distance < bestDistance) {
      best = street.street
      bestDistance = distance
    }
  }
  return best
}

/**
 * Whether the map has the typed street in the typed suburb. Never throws, and
 * never says more than it knows: offline, blocked, slower than 3 seconds, a
 * test runner driving the browser (`networkLookupsAllowed`), or too little
 * typed are all 'unchecked', with no issue.
 */
export async function checkStreetOnline(
  value: AddressValue,
  opts: { signal?: AbortSignal; workState?: string },
): Promise<StreetCheck> {
  const url = streetCheckUrl(value)
  if (!url || !networkLookupsAllowed() || isOffline()) {
    return { status: 'unchecked' }
  }
  const reply = await getJsonWithin(url, {
    signal: opts.signal,
    timeoutMs: STREET_CHECK_TIMEOUT_MS,
  })
  if (!reply.ok) return { status: 'unchecked' }
  return readStreetCheck(reply.json, value, opts.workState)
}

/**
 * Every warning for an address at save: the offline checks always, and the
 * street check when the address is not (or is no longer) a picked
 * suggestion. `picked` is the value `AddressLookupInput`'s `onPick` last
 * gave, or null. Never throws; `addressErrors` is separate, and synchronous.
 */
export async function checkAddressAtSave(
  value: AddressValue,
  opts: {
    workState?: string
    picked?: AddressValue | null
    signal?: AbortSignal
  },
): Promise<Array<AddressIssue>> {
  const [offline, street] = await Promise.all([
    checkAddressOffline(value, opts).catch(() => []),
    stillAsPicked(opts.picked, value)
      ? Promise.resolve<StreetCheck>({ status: 'unchecked' })
      : checkStreetOnline(value, opts).catch((): StreetCheck => ({
          status: 'unchecked',
        })),
  ])
  return street.issue ? [street.issue, ...offline] : offline
}
