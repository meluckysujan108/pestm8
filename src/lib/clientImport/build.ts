import { STREET_TYPES } from '#/lib/addressLookup'
import { abnDigits, formatAbn, isValidAbn } from '../../../convex/lib/abn'
import {
  AU_STATE_CODES,
  MAX_IMPORT_NOTE,
  nameKey,
  phoneProblem,
  siteKey,
} from '../../../convex/lib/clientImport'
import { emailProblem, emailTypoFix } from '../../../convex/lib/email'
import { checkPhone } from '../../../convex/lib/phone'
import { stateOfPostcode } from '../../../convex/lib/postcodes'
import { importable } from './convert'
import type {
  ColumnMapping,
  ExistingIndex,
  ImportField,
  ImportSheet,
  ReviewClient,
  ReviewIssue,
  ReviewSite,
} from './types'

/**
 * The review: every row of the file read as a client, grouped, tidied and
 * judged, before anything is sent. Synchronous and offline, so a 2,000-row
 * file is reviewed the moment Continue is pressed; the address tables are
 * checks.ts's, afterwards.
 *
 * Two kinds of issue, kept apart because they are re-judged differently
 * after an edit:
 * - What the client is now — a phone that can't be dialled, an email with
 *   no domain, a blank suburb — is worked out again from its fields every
 *   time (`currentIssues`).
 * - What was done to the file's values on the way in — "Postcode 810 →
 *   0810" — can't be seen in the result, so each carries a test of whether
 *   it still holds (`holdWhile`), and goes once the field is edited.
 */

type Opts = { businessState: string; existing: ExistingIndex }

// ---------------------------------------------------------------- issues

const STILL = Symbol('still holds')

type Held = ReviewIssue & { [STILL]?: (client: ReviewClient) => boolean }

/**
 * Marks an issue as one that can't be worked out again from the client's
 * fields, with the test of whether it still holds; `recheckClient` keeps it
 * while the test passes. Used for what was fixed on the way in, and by
 * checks.ts for the address warnings. Returns the same issue, so a fix that
 * takes its own issue away can find it.
 */
export function holdWhile<T extends ReviewIssue>(
  issue: T,
  still: (client: ReviewClient) => boolean,
): T {
  ;(issue as Held)[STILL] = still
  return issue
}

/** An issue whose fix changes the client and takes the issue away. The page
 * runs `recheckClient` and `checkClientOffline` after a fix, as after an
 * edit, which settles everything else. */
function withFix(
  issue: Omit<ReviewIssue, 'fix'>,
  label: string,
  change: (client: ReviewClient) => ReviewClient,
): ReviewIssue {
  const made: ReviewIssue = {
    ...issue,
    fix: {
      label,
      apply: (client) => {
        const next = change(client)
        return { ...next, issues: next.issues.filter((i) => i !== made) }
      },
    },
  }
  return made
}

function patchSite(
  client: ReviewClient,
  index: number,
  patch: Partial<ReviewSite>,
): ReviewClient {
  return {
    ...client,
    sites: client.sites.map((site, i) =>
      i === index ? { ...site, ...patch } : site,
    ),
  }
}

/**
 * The client without one of its sites, and what was said about it. What
 * was said about a later site moves down one with it; a held issue's test,
 * and a fix, were made for the sites as they were numbered, so each is
 * shown the client with the site put back where it was.
 */
export function withoutSite(client: ReviewClient, index: number): ReviewClient {
  const gone = client.sites[index]
  const putBack = (c: ReviewClient): ReviewClient => ({
    ...c,
    sites: [...c.sites.slice(0, index), gone, ...c.sites.slice(index)],
  })
  const takeOut = (c: ReviewClient): ReviewClient => ({
    ...c,
    sites: c.sites.filter((_, i) => i !== index),
  })
  const issues: Array<ReviewIssue> = []
  for (const issue of client.issues) {
    const at = issue.siteIndex
    if (at === index) continue
    if (at === undefined || at < index) {
      issues.push(issue)
      continue
    }
    // A spread keeps the tags checks.ts and checkAcrossClients go by.
    const moved: ReviewIssue = { ...issue, siteIndex: at - 1 }
    const fix = issue.fix
    if (fix) {
      moved.fix = {
        label: fix.label,
        apply: (c) => {
          const next = takeOut(fix.apply(putBack(c)))
          return { ...next, issues: next.issues.filter((i) => i !== moved) }
        },
      }
    }
    const still = (issue as Held)[STILL]
    issues.push(still ? holdWhile(moved, (c) => still(putBack(c))) : moved)
  }
  return { ...takeOut(client), issues }
}

const LEVEL_ORDER = { error: 0, warning: 1, fixed: 2 } as const

function sortIssues(issues: Array<ReviewIssue>): Array<ReviewIssue> {
  return [...issues].sort(
    (a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      (a.siteIndex ?? -1) - (b.siteIndex ?? -1),
  )
}

// ---------------------------------------------------------------- Excel's numbers

/**
 * A number Excel wrote in exponent form ("4.12346E+08", "5.1824753556E+10"),
 * as its digits when every one survived, or `lost` when Excel rounded some
 * away — a column too narrow for the number when the CSV was saved. Those
 * digits are gone for good; only the person can type them back.
 */
function excelNumber(text: string): { digits: string } | 'lost' | null {
  const m = /^(\d+)(?:\.(\d+))?e\+?(\d+)$/i.exec(text.trim())
  if (!m) return null
  const whole = m[1]
  // An optional group is undefined when it didn't take part, whatever
  // TypeScript's regex types say.
  const fraction = (m[2] as string | undefined) ?? ''
  const exponent = Number(m[3])
  if (fraction.length > exponent) return null
  if (fraction.length < exponent) return 'lost'
  return { digits: `${whole}${fraction}` }
}

const lostMessage = (what: string, text: string) =>
  `Excel shortened this ${what} to ${text} when the file was saved, so its last digits are gone — type it in again.`

// ---------------------------------------------------------------- states

const STATE_NAMES: Record<string, string> = {
  act: 'ACT',
  australiancapitalterritory: 'ACT',
  nsw: 'NSW',
  newsouthwales: 'NSW',
  nt: 'NT',
  northernterritory: 'NT',
  qld: 'QLD',
  queensland: 'QLD',
  sa: 'SA',
  southaustralia: 'SA',
  tas: 'TAS',
  tasmania: 'TAS',
  vic: 'VIC',
  victoria: 'VIC',
  wa: 'WA',
  westernaustralia: 'WA',
}

/** A state as written ("Western Australia", "W.A.", "Qld", "Vic.",
 * "N.S.W") as its code, or null when it isn't one. */
function stateCodeOf(text: string): string | null {
  return STATE_NAMES[text.toLowerCase().replace(/[^a-z]/g, '')] ?? null
}

const isStateCode = (code: string) =>
  (AU_STATE_CODES as ReadonlyArray<string>).includes(code)

// ---------------------------------------------------------------- addresses

type ParsedAddress = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
  /** One run of words with nothing to say where the street stops. */
  unsplit: boolean
}

/** Places whose name ends in a state's: "Mount Victoria" is in the Blue
 * Mountains, and must keep its Victoria. */
const BEFORE_A_PLACE_NAME = new Set(['mount', 'mt', 'port', 'lake', 'point'])

/** The state named at the end of `text`, and what is left before it. */
function stateAtEnd(
  text: string,
  postcode: string,
): { rest: string; code: string } | null {
  const words = text.split(' ')
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const tail = words.slice(-n).join(' ')
    // Letters and dots only: "6053 WA" is a postcode and a state.
    const code = /^[a-z. ]+$/i.test(tail) ? stateCodeOf(tail) : null
    if (!code) continue
    const rest = words.slice(0, -n).join(' ')
    // A code (WA, NSW) is always the state. A one-word name might be the
    // end of a place's (Mount Victoria): taken as the state only when
    // nothing says otherwise. No place ends in "Western Australia", so
    // South Lake Western Australia is South Lake, WA.
    const spelt =
      words
        .slice(-n)
        .join('')
        .replace(/[^a-z]/gi, '').length > 3
    if (spelt) {
      const before = rest.split(' ').pop()?.toLowerCase() ?? ''
      if (n === 1 && BEFORE_A_PLACE_NAME.has(before)) return null
      const padded = postcode.length === 3 ? `0${postcode}` : postcode
      const its = stateOfPostcode(padded)
      if (its && its !== code) return null
    }
    return { rest, code }
  }
  return null
}

/**
 * A whole address in one cell, as the apps and people write it: "12 Wattle
 * St, Bayswater WA 6053", on two lines, or "12 Wattle St, Bayswater, WA,
 * 6053". The postcode and state come off the end; then the last part left is
 * the suburb. With no comma or line break before the suburb there is no
 * telling where the street stops, and the whole line is left for the person.
 */
function parseAddress(text: string): ParsedAddress {
  const parts = text
    .split(/[\r\n,]+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const last = () => parts[parts.length - 1]
  const setLast = (value: string) => {
    if (value) parts[parts.length - 1] = value
    else parts.pop()
  }

  if (parts.length > 0 && /^(?:australia|aus|au)$/i.test(last())) parts.pop()
  // "… WA 6053 Australia", but never the Australia of "South Australia".
  if (parts.length > 0) {
    setLast(
      last().replace(
        /(\d|\b(?:nsw|vic|qld|wa|sa|tas|nt|act)\.?)\s+australia$/i,
        '$1',
      ),
    )
  }

  let postcode = ''
  let state = ''
  // Twice, for either order: "Bayswater WA 6053" and "Bayswater 6053 WA".
  for (let pass = 0; pass < 2 && parts.length > 0; pass++) {
    if (!postcode) {
      // Five digits too, to be said to be wrong rather than taken as part
      // of the suburb.
      const m = /^(.*?)\s*\b(\d{3,5})$/.exec(last())
      if (m && (m[1] !== '' || parts.length > 1)) {
        postcode = m[2]
        setLast(m[1])
        continue
      }
    }
    if (!state && parts.length > 0) {
      const m = stateAtEnd(last(), postcode)
      if (m && (m.rest !== '' || parts.length > 1)) {
        state = m.code
        setLast(m.rest)
      }
    }
  }

  if (parts.length >= 2) {
    const suburb = parts.pop() ?? ''
    return {
      addressLine: parts.join(', '),
      suburb,
      state,
      postcode,
      unsplit: false,
    }
  }
  return {
    addressLine: parts[0] ?? '',
    suburb: '',
    state,
    postcode,
    unsplit: parts.length === 1,
  }
}

/**
 * Where "12 Wattle St Bayswater" most likely splits: after the one street
 * type ("St", "Road", "Esplanade") with a name before it and words after.
 * Offered as a fix, never done unasked, and only when there is exactly one
 * such place — "5 St Kilda Rd St Kilda" has three.
 */
function guessSplit(
  line: string,
): { addressLine: string; suburb: string } | null {
  const words = line.split(' ')
  const at: Array<number> = []
  for (let i = 1; i < words.length - 1; i++) {
    const word = words[i].toLowerCase().replace(/\.$/, '')
    if (word === 'the' || !STREET_TYPES.has(word)) continue
    const named = words.slice(0, i).some((w) => /[a-z]/i.test(w))
    if (named && !/^\d/.test(words[i + 1])) at.push(i)
  }
  if (at.length !== 1) return null
  return {
    addressLine: words.slice(0, at[0] + 1).join(' '),
    suburb: words.slice(at[0] + 1).join(' '),
  }
}

// ---------------------------------------------------------------- names

/**
 * Words a business's name has and a person's doesn't. A guess, shown as a
 * Business/Person badge the person can flip.
 */
const BUSINESS_WORDS =
  /(?:^|[^\p{L}\p{N}])(?:pty|p\s*\/\s*l|ltd|limited|inc|incorporated|trust|trustee|council|school|strata|body corporate|owners corp(?:oration)?|real estate|holdings|group|services|church|club|company|corporation|corp|association|shire)(?=$|[^\p{L}\p{N}])/iu

const AND_CO = /&\s*co(?=$|[^\p{L}])/iu

function looksLikeBusiness(name: string): boolean {
  return BUSINESS_WORDS.test(name) || AND_CO.test(name)
}

/** Whether two names have a word in common, as `nameKey` splits them:
 * "John & Mary Smith" and "John Smith" do; "Bayview Motel" and "Bob Jones"
 * don't. */
function sharesWord(a: string, b: string): boolean {
  const words = new Set(nameKey(a).split(' '))
  return nameKey(b)
    .split(' ')
    .some((word) => word !== '' && words.has(word))
}

/** An "Is a company?" or customer-type cell that says so, either way. */
const YES =
  /^(?:y|yes|true|1|x|company|business|commercial|organisation|organization|corporate)$/i
const NO = /^(?:n|no|false|0|individual|person|residential|private|domestic)$/i

/** A contact-type cell for someone who isn't a client: an accounts
 * package's suppliers, listed beside its customers. */
const NOT_A_CLIENT =
  /\b(?:supplier|vendor|creditor|sub-?contractor|contractor|employee|staff|payee)s?\b/i

const tidy = (text: string | undefined) =>
  (text ?? '').replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------- a row

type RowValues = Partial<Record<ImportField, string>>

/** What a spreadsheet puts in a cell to say there's nothing: taken as
 * blank, so "N/A" isn't an email that can never be delivered to. */
const PLACEHOLDER = /^(?:-+|–|—|\.|\?+|#?n\/?a|nil|none|null|tba|tbc|unknown)$/i

function rowValues(row: Array<string>, mapping: ColumnMapping): RowValues {
  const values: RowValues = {}
  mapping.forEach((field, i) => {
    const cell = (row[i] ?? '').trim()
    const value = PLACEHOLDER.test(cell) ? '' : cell
    // A field chosen for two columns (Match stops that) takes the first
    // that has something.
    if (field && value && !values[field]) values[field] = value
  })
  return values
}

/** An issue about a site, made once the site's place in its client is
 * known — two rows for one house become one site. */
type SiteNote = (siteIndex: number) => ReviewIssue

type Draft = {
  rowNumber: number
  /** The row as the person's spreadsheet numbers it. */
  sheetRow: number
  kind: 'person' | 'business'
  name: string
  contactPerson?: string
  phone?: string
  email?: string
  abn?: string
  site?: ReviewSite
  siteNotes: Array<SiteNote>
  notes: Array<ReviewIssue>
  /** The file's contact type, when it says this isn't a client
   * ("Supplier"): left out unless the person includes it. */
  notAClient?: string
}

/** A phone as the file had it, with a lost leading 0 put back, +61 written
 * as the number is dialled here, and Excel's exponent written out when no
 * digit was lost to it. */
function repairPhone(raw: string): string {
  const excel = excelNumber(raw)
  const text = excel && excel !== 'lost' ? excel.digits : raw.trim()
  const compact = text.replace(/[\s\-().]/g, '')
  // Excel reads a number typed without its quote mark as a number, and a
  // number has no leading 0: 0412 345 678 is saved as 412345678.
  if (/^[42378]\d{8}$/.test(compact)) {
    const restored = `0${compact}`
    return checkPhone(restored).tidy ?? restored
  }
  // Excel reads +61 412 345 678 as a sum, and saves 61412345678 — which a
  // phone here can't dial. Written with its 0, as every other number is;
  // "+61 (0)8 …" too, whose 0 isn't dialled after the 61.
  if (/^(?:\+|00)?61/.test(compact) || text.includes('(0)')) {
    const check = checkPhone(text)
    if (check.level === 'ok' && check.tidy?.startsWith('0')) return check.tidy
  }
  return text
}

/**
 * A phone cell as one number, and what was done to it on the way. Several
 * numbers in one cell (Jobber's "Main Phone #s") give the first.
 */
function readPhone(raw: string | undefined): {
  value?: string
  changes: Array<string>
} {
  const all = (raw ?? '')
    .split(/[,;|\n]|\s\/\s|\s+or\s+/i)
    .map((p) => p.trim())
    .filter(Boolean)
  if (all.length === 0) return { changes: [] }
  const value = repairPhone(all[0])
  const changes: Array<string> = []
  if (all.length > 1) {
    changes.push(`${all.length} numbers in the file — kept the first.`)
  }
  if (value !== all[0]) changes.push(`Phone ${all[0]} → ${value}`)
  return { value, changes }
}

const isLost = (value: string) => excelNumber(value) === 'lost'

/** `emailTypoFix`'s answer for each domain, as a file of 2,000 clients has
 * a few dozen domains and the check compares each with every common one. */
const typoByDomain = new Map<string, string | null>()

function typoFix(email: string): string | null {
  const at = email.lastIndexOf('@')
  const domain = email.slice(at + 1).toLowerCase()
  let fixed = typoByDomain.get(domain)
  if (fixed === undefined) {
    fixed = emailTypoFix(`x@${domain}`)?.slice(2) ?? null
    typoByDomain.set(domain, fixed)
  }
  return fixed === null ? null : `${email.slice(0, at)}@${fixed}`
}

function draftOf(
  row: Array<string>,
  rowNumber: number,
  sheetRow: number,
  sheet: ImportSheet,
  mapping: ColumnMapping,
  opts: Opts,
): Draft {
  const v = rowValues(row, mapping)
  const notes: Array<ReviewIssue> = []
  const siteNotes: Array<SiteNote> = []

  // ---- the ABN, read first: having one says a business
  let abnValue: string | undefined
  let abnFromExcel: string | undefined
  if (v.abn) {
    const bare = v.abn.replace(/^a\.?b\.?n\.?\s*:?\s*/i, '').trim()
    const excel = excelNumber(bare)
    const text = excel && excel !== 'lost' ? excel.digits : bare
    abnValue = (abnDigits(text) ?? text) || undefined
    if (excel && excel !== 'lost') abnFromExcel = bare
  }

  // ---- name and kind
  const company = tidy(v.company)
  const nameColumn = tidy(v.name)
  const first = tidy(v.firstName)
  const last = tidy(v.lastName)
  const person = [first, last].filter(Boolean).join(' ')
  const lastColumn = mapping.indexOf('lastName')
  // MYOB's "Co./Last Name" holds a company's name, or a person's surname
  // beside their first name.
  const myobCompany =
    lastColumn !== -1 &&
    sheet.headers[lastColumn].toLowerCase().replace(/[^a-z]/g, '') ===
      'colastname' &&
    last !== '' &&
    first === ''
  // A name the file itself splits into a first and a last is a person's,
  // whatever it sounds like: Jane Church is not a church.
  const splitAsPerson =
    first !== '' &&
    last !== '' &&
    (nameColumn === '' || nameKey(nameColumn) === nameKey(person))
  // A name column beside a first and a last — or a contact person — it
  // shares no word with: a place named for itself and the person to ask
  // for — Xero's "Bayview Motel" with Bob Jones, ServiceM8's name beside
  // its Contact First/Last, a "Little Sprouts Early Learning" billing name
  // beside its primary contact. "John & Mary Smith" beside John Smith is
  // still the Smiths.
  const asked = person || tidy(v.contactPerson)
  const namedApart =
    nameColumn !== '' && asked !== '' && !sharesWord(nameColumn, asked)
  // The file's own word beats every guess — Jobber's "Is Company?" false
  // beside a Company Name is a person who works there. Then a company
  // column; then a real ABN, which a household doesn't give its pest
  // controller (Xero has no company column, only a tax number); then the
  // name.
  const flag = tidy(v.isCompany)
  const business =
    YES.test(flag) ||
    (!NO.test(flag) &&
      (company !== '' ||
        myobCompany ||
        namedApart ||
        (abnValue !== undefined && isValidAbn(abnValue)) ||
        (!splitAsPerson && looksLikeBusiness(nameColumn || person))))
  const kind = business ? 'business' : 'person'
  // A person is named for themselves; the company only when the row has
  // nothing else to call them.
  const name = business
    ? company || nameColumn || person
    : nameColumn || person || company

  // Worked out for a person too, and kept: flipped to Business in the edit
  // sheet, the client still has its contact. What is sent for a person
  // leaves it out (convert.ts).
  const contactPerson = [
    tidy(v.contactPerson),
    person,
    company ? nameColumn : '',
  ].find((c) => c !== '' && nameKey(c) !== nameKey(name))

  // ---- phone: one per client, the mobile first — unless the mobile can't
  // be dialled and the other number can.
  const mobile = readPhone(v.mobile)
  const landline = readPhone(v.phone)
  const usable = (p: { value?: string }) =>
    p.value !== undefined && !isLost(p.value) && phoneProblem(p.value) === null
  const phone =
    !mobile.value || (!usable(mobile) && usable(landline)) ? landline : mobile
  const phoneValue = phone.value
  for (const message of phone.changes) {
    notes.push(
      holdWhile(
        { level: 'fixed', field: 'phone', message },
        (c) => c.phone === phoneValue,
      ),
    )
  }

  // ---- email: the first of several
  let email: string | undefined
  if (v.email) {
    const found = v.email.match(/[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+/g)
    const all = found ?? [v.email.trim()]
    email = all[0]
    if (all.length > 1) {
      const kept = email
      notes.push(
        holdWhile(
          {
            level: 'fixed',
            field: 'email',
            message: `${all.length} emails in the file — kept the first, ${kept}.`,
          },
          (c) => c.email === kept,
        ),
      )
    }
  }

  // ---- ABN: a business's only
  let abn: string | undefined
  if (abnValue !== undefined && business) {
    abn = abnValue
    const value = abnValue
    if (abnFromExcel !== undefined) {
      notes.push(
        holdWhile(
          {
            level: 'fixed',
            field: 'abn',
            message: `ABN ${abnFromExcel} → ${formatAbn(value)}`,
          },
          (c) => c.abn === value,
        ),
      )
    }
  } else if (abnValue !== undefined) {
    const value = abnValue
    notes.push(
      holdWhile(
        withFix(
          {
            level: 'fixed',
            field: 'abn',
            message: `Left out the ABN ${abnDigits(value) ? formatAbn(value) : value} — a person has none.`,
          },
          "It's a business — keep the ABN",
          (c) => ({ ...c, kind: 'business', abn: value }),
        ),
        (c) => c.kind === 'person' && !c.abn,
      ),
    )
  }

  // ---- the site
  const street = [tidy(v.street), tidy(v.street2)].filter(Boolean).join(', ')
  const suburbColumn = tidy(v.suburb)
  let parsed: ParsedAddress | null = null
  if (v.address && !street) parsed = parseAddress(v.address)
  else if (street && !suburbColumn && /[,\n]/.test(v.street ?? '')) {
    // A whole address in the street column, with no suburb column.
    parsed = parseAddress([v.street, v.street2].filter(Boolean).join('\n'))
  }

  let addressLine = street
  let suburb = suburbColumn
  let unsplit = false
  if (parsed) {
    if (!suburbColumn) {
      addressLine = parsed.addressLine
      suburb = parsed.suburb
      unsplit = parsed.unsplit
    } else if (
      parsed.suburb &&
      nameKey(parsed.suburb) === nameKey(suburbColumn)
    ) {
      addressLine = parsed.addressLine
    } else {
      // The suburb has its own column, and the address cell is only the
      // street — however many commas it has ("Unit 3, 12 Wattle St").
      addressLine = [parsed.addressLine, parsed.suburb]
        .filter(Boolean)
        .join(', ')
    }
  }
  const stateText = tidy(v.state) || parsed?.state || ''
  let postcode = (tidy(v.postcode) || parsed?.postcode || '')
    .replace(/\s/g, '')
    // "6053.0", from a tool that wrote every number as a decimal.
    .replace(/^(\d+)\.0+$/, '$1')

  let site: ReviewSite | undefined
  // A state on its own (a column filled down with "WA") is not an address.
  if (addressLine || suburb || postcode) {
    let state = stateText ? (stateCodeOf(stateText) ?? '') : ''

    // The NT's and the ACT's postcodes start with a 0, which Excel drops:
    // Nightcliff's 0810 arrives as 810.
    if (/^\d{3}$/.test(postcode)) {
      const padded = `0${postcode}`
      const its = stateOfPostcode(padded)
      if (
        state === 'NT' ||
        state === 'ACT' ||
        (!state && (its === 'NT' || its === 'ACT'))
      ) {
        const was = postcode
        postcode = padded
        siteNotes.push((i) =>
          holdWhile(
            {
              level: 'fixed',
              field: 'postcode',
              siteIndex: i,
              message: `Postcode ${was} → ${padded}`,
            },
            (c) => c.sites[i]?.postcode === padded,
          ),
        )
      }
    }

    if (!state) {
      const fromPostcode = stateOfPostcode(postcode)
      const used =
        fromPostcode ??
        (isStateCode(opts.businessState.toUpperCase())
          ? opts.businessState.toUpperCase()
          : '')
      if (used) {
        state = used
        const why = fromPostcode ? ', from the postcode' : ''
        siteNotes.push((i) =>
          holdWhile(
            stateText
              ? {
                  level: 'warning',
                  field: 'state',
                  siteIndex: i,
                  message: `“${stateText}” isn't a state — used ${used}${why}.`,
                }
              : {
                  level: 'fixed',
                  field: 'state',
                  siteIndex: i,
                  message: `No state in the file — used ${used}${why}.`,
                },
            (c) => c.sites[i]?.state === used,
          ),
        )
      }
    }

    site = { addressLine, suburb, state, postcode }

    if (unsplit) {
      const line = addressLine
      const split = guessSplit(line)
      siteNotes.push((i) => {
        const issue = {
          level: 'error' as const,
          field: 'suburb' as const,
          siteIndex: i,
          message: `Could not tell the street from the suburb in “${line}” — edit it.`,
        }
        return holdWhile(
          split
            ? withFix(issue, `Use ${split.addressLine}, ${split.suburb}`, (c) =>
                patchSite(c, i, split),
              )
            : issue,
          (c) => c.sites[i]?.addressLine === line && !c.sites[i].suburb.trim(),
        )
      })
    }

    const note = v.notes?.replace(/\r\n?/g, '\n').trim()
    if (note) site.note = note

    // A site contact is a business's: the caretaker, the store manager.
    // Kept on a person's site as well, unshown and unsent (convert.ts), so
    // a flip to Business in the edit sheet brings it back.
    const contactName = tidy(v.siteContactName)
    if (contactName) site.siteContactName = contactName
    const sitePhone = readPhone(v.siteContactPhone)
    const value = sitePhone.value
    if (value) {
      site.siteContactPhone = value
      for (const message of sitePhone.changes) {
        siteNotes.push((i) =>
          holdWhile(
            {
              level: 'fixed',
              field: 'siteContactPhone',
              siteIndex: i,
              message,
            },
            (c) =>
              c.kind === 'business' && c.sites[i]?.siteContactPhone === value,
          ),
        )
      }
    }
  }

  return {
    rowNumber,
    sheetRow,
    kind,
    name,
    ...(contactPerson ? { contactPerson } : {}),
    ...(phoneValue ? { phone: phoneValue } : {}),
    ...(email ? { email } : {}),
    ...(abn ? { abn } : {}),
    ...(site ? { site } : {}),
    siteNotes,
    notes,
    ...(NOT_A_CLIENT.test(tidy(v.contactType))
      ? { notAClient: tidy(v.contactType) }
      : {}),
  }
}

// ---------------------------------------------------------------- grouping

/** What says two rows of one name are one client: the same email or phone,
 * or neither having any. A phone is compared as it is dialled here, so
 * +61 412 345 678 is 0412 345 678 — but not with an area code only
 * guessed at, which might make it someone else's. */
function contactIds(draft: Draft): Array<string> {
  const ids: Array<string> = []
  if (draft.email) ids.push(draft.email.toLowerCase())
  if (draft.phone) {
    const check = checkPhone(draft.phone)
    const national =
      check.level === 'ok' && check.tidy ? check.tidy : draft.phone
    const digits = national.replace(/\D/g, '')
    if (digits) ids.push(digits)
  }
  return ids
}

/** Two of one client's sites at one address as one site: the first, its
 * note and the other's joined, and a site contact it lacks taken from the
 * other. */
function joinSites(kept: ReviewSite, other: ReviewSite): ReviewSite {
  const was = kept.note?.trim() ?? ''
  const more = other.note?.trim() ?? ''
  const note =
    more && more !== was ? [was, more].filter(Boolean).join('\n\n') : ''
  const name = other.siteContactName?.trim()
  const phone = other.siteContactPhone?.trim()
  return {
    ...kept,
    ...(note ? { note } : {}),
    ...(!kept.siteContactName?.trim() && name ? { siteContactName: name } : {}),
    ...(!kept.siteContactPhone?.trim() && phone
      ? { siteContactPhone: phone }
      : {}),
  }
}

function merge(drafts: Array<Draft>, opts: Opts): ReviewClient {
  const [head] = drafts
  const pick = (key: 'contactPerson' | 'phone' | 'email' | 'abn') =>
    drafts.find((d) => d[key])?.[key]

  const notes: Array<ReviewIssue> = []
  const seen = new Set<string>()
  for (const draft of drafts) {
    for (const note of draft.notes) {
      const id = `${note.field}|${note.message}`
      if (seen.has(id)) continue
      seen.add(id)
      notes.push(note)
    }
  }

  // One house on two rows (a Jobber row per visit type, say) is one site,
  // its notes joined.
  const sites: Array<ReviewSite> = []
  const keys = new Map<string, number>()
  for (const draft of drafts) {
    if (!draft.site) continue
    const key = siteKey(draft.site)
    const at = keys.get(key)
    if (at === undefined) {
      const index = sites.length
      sites.push(draft.site)
      keys.set(key, index)
      notes.push(...draft.siteNotes.map((note) => note(index)))
      continue
    }
    sites[at] = joinSites(sites[at], draft.site)
  }

  const kind = drafts.some((d) => d.kind === 'business') ? 'business' : 'person'
  const contactPerson = pick('contactPerson')
  const phone = pick('phone')
  const email = pick('email')
  const abn = kind === 'business' ? pick('abn') : undefined
  // Left out: every row saying it isn't a client (a supplier who is also on
  // a customer row is a client), or a name and nothing else — an accounts
  // package's payees, "Post office", "Apple subscription". Either can be
  // included, and then is judged like any other.
  const notAClient = drafts.every((d) => d.notAClient)
    ? head.notAClient
    : undefined
  const nameOnly = sites.length === 0 && !phone && !email
  const leftOut = notAClient
    ? `“${notAClient}” in the file, not a client — left out. Include it if you do work for them.`
    : nameOnly
      ? 'Only a name in the file — no address, phone or email — so left out. Include it to add an address.'
      : undefined
  if (leftOut) {
    notes.push(
      holdWhile(
        { level: 'fixed', field: 'name', message: leftOut },
        (c) => !c.included,
      ),
    )
  }
  const client: ReviewClient = {
    key: `c${head.rowNumber}`,
    rowNumbers: drafts.map((d) => d.rowNumber),
    sheetRows: drafts.map((d) => d.sheetRow),
    kind,
    name: head.name,
    // A person's too, unsent, for a flip to Business (see draftOf).
    ...(contactPerson ? { contactPerson } : {}),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(abn ? { abn } : {}),
    sites,
    issues: notes,
    included: !leftOut,
  }
  return recheckClient(client, opts)
}

/**
 * Every row of the sheet as clients to review. Rows with the same name and
 * the same email or phone (or neither) are one client with a site each —
 * Jobber's one row per property. Each client is checked, tidied and matched
 * against what PestM8 already holds, and the clients against each other;
 * nothing is sent.
 */
export function buildReview(
  sheet: ImportSheet,
  mapping: ColumnMapping,
  opts: { businessState: string; existing: ExistingIndex },
): Array<ReviewClient> {
  // Each group of rows, by the order its first row came in, and the group
  // it has joined: a row with the email of one and the phone of another
  // says they are one client, whichever order the rows are in, and the
  // later joins the earlier. Only a group's own entry names itself.
  const joined: Array<number> = []
  const whole = (group: number): number => {
    let at = group
    while (joined[at] !== at) at = joined[at]
    // Every group on the way points straight at it from now on.
    for (let step = group; joined[step] !== at;) {
      const next = joined[step]
      joined[step] = at
      step = next
    }
    return at
  }
  // "name|email-or-phone" → a group of that name with that email or phone
  // on one of its rows; "name|" → the first of that name whose first row
  // had neither. A look-up or two a row, however many share a name.
  const index = new Map<string, number>()
  const placed: Array<{ draft: Draft; group: number }> = []
  sheet.rows.forEach((row, i) => {
    const sheetRow = sheet.sourceRows?.[i] ?? i + 2
    const draft = draftOf(row, i + 1, sheetRow, sheet, mapping, opts)
    const key = nameKey(draft.name)
    const ids = contactIds(draft)
    // No name, nothing to group by: each is its own client, and an error.
    const hits = !key
      ? []
      : ids.length === 0
        ? [index.get(`${key}|`)]
        : ids.map((id) => index.get(`${key}|${id}`))
    const groups = hits.flatMap((hit) =>
      hit === undefined ? [] : [whole(hit)],
    )
    let at: number
    if (groups.length === 0) {
      at = joined.length
      joined.push(at)
      if (key && ids.length === 0) index.set(`${key}|`, at)
    } else {
      // The earliest of them is the client; the rest join it.
      at = Math.min(...groups)
      for (const group of groups) joined[group] = at
    }
    if (key) for (const id of ids) index.set(`${key}|${id}`, at)
    placed.push({ draft, group: at })
  })

  // Each client's rows in file order. A group's first row is earlier than
  // any row of a group that joins it, so the clients come in the order of
  // their first rows, as each key (`c${first row}`) says.
  const clients = new Map<number, Array<Draft>>()
  for (const { draft, group } of placed) {
    const at = whole(group)
    const drafts = clients.get(at)
    if (drafts) drafts.push(draft)
    else clients.set(at, [draft])
  }
  return checkAcrossClients(
    [...clients.values()].map((drafts) => merge(drafts, opts)),
  )
}

// ---------------------------------------------------------------- judging

/** An address for post only — "PO Box 12", "P.O. Box", "GPO Box",
 * "Locked Bag 5", "Private Bag 3" — which a technician can't visit. Most
 * often a billing address taken for want of a site one. */
const POSTAL_ONLY =
  /^(?:(?:p\.?\s*o\.?|g\.?\s*p\.?\s*o\.?|post\s+office)\s*box|(?:locked|private)\s+(?:mail\s+)?bag)\b/i

const count = (n: number) => n.toLocaleString('en-AU')

/** What is wrong with a phone as it is now, and the fix. */
function phoneIssues(
  value: string,
  field: 'phone' | 'siteContactPhone',
  siteIndex: number | undefined,
  opts: Opts,
  leaveOut: (client: ReviewClient) => ReviewClient,
): Array<ReviewIssue> {
  const at = siteIndex === undefined ? {} : { siteIndex }
  const label = field === 'phone' ? 'Leave the phone out' : 'Leave it out'
  const what = field === 'phone' ? 'Phone' : "Site contact's phone"
  if (isLost(value)) {
    return [
      withFix(
        { level: 'error', field, ...at, message: lostMessage('number', value) },
        label,
        leaveOut,
      ),
    ]
  }
  // The server's own test (`phoneProblem`), not `checkPhone` alone: an
  // extension on its own ("x21") passes that, and the server refuses it.
  const problem = phoneProblem(value)
  if (problem) {
    return [
      withFix(
        {
          level: 'error',
          field,
          ...at,
          message: `${what} “${value}”: ${problem}`,
        },
        label,
        leaveOut,
      ),
    ]
  }
  const check = checkPhone(value, { businessState: opts.businessState })
  if (check.level === 'warning') {
    const issue = {
      level: 'warning' as const,
      field,
      ...at,
      message: `${what} ${value}: ${check.message ?? 'check it.'}`,
    }
    const tidied = check.tidy
    if (!tidied) return [issue]
    return [
      withFix(issue, `Use ${tidied}`, (c) =>
        siteIndex === undefined
          ? { ...c, phone: tidied }
          : patchSite(c, siteIndex, { siteContactPhone: tidied }),
      ),
    ]
  }
  return []
}

/** Everything wrong with the client as it is now, worked out from its
 * fields alone. Sites already in PestM8 aren't judged: they aren't sent. */
function currentIssues(client: ReviewClient, opts: Opts): Array<ReviewIssue> {
  const issues: Array<ReviewIssue> = []
  const name = client.name.trim()
  if (!name) {
    issues.push({ level: 'error', field: 'name', message: 'No client name.' })
  } else if (name.length > 200) {
    issues.push({
      level: 'error',
      field: 'name',
      message: 'The name is longer than 200 letters.',
    })
  }

  if (client.sites.length === 0) {
    issues.push({
      level: 'error',
      field: 'addressLine',
      message: 'No address — a client needs at least one site.',
    })
  }
  client.sites.forEach((site, i) => {
    if (site.duplicate) return
    const at = { siteIndex: i }
    if (!site.addressLine.trim()) {
      issues.push({
        level: 'error',
        field: 'addressLine',
        ...at,
        message: 'No street address.',
      })
    }
    if (!site.suburb.trim()) {
      issues.push({
        level: 'error',
        field: 'suburb',
        ...at,
        message: 'No suburb.',
      })
    }
    if (!isStateCode(site.state.trim().toUpperCase())) {
      issues.push({
        level: 'error',
        field: 'state',
        ...at,
        message: 'No state.',
      })
    }
    const postcode = site.postcode.trim()
    if (!postcode) {
      issues.push({
        level: 'error',
        field: 'postcode',
        ...at,
        message: 'No postcode.',
      })
    } else if (!/^\d{4}$/.test(postcode)) {
      const padded = `0${postcode}`
      const issue = {
        level: 'error' as const,
        field: 'postcode' as const,
        ...at,
        message: `Postcode “${postcode}” isn't 4 digits.`,
      }
      issues.push(
        /^\d{3}$/.test(postcode) &&
          stateOfPostcode(padded) === site.state.trim().toUpperCase()
          ? withFix(issue, `Use ${padded}`, (c) =>
              patchSite(c, i, { postcode: padded }),
            )
          : issue,
      )
    }
    if (POSTAL_ONLY.test(site.addressLine.trim())) {
      const issue = {
        level: 'warning' as const,
        field: 'addressLine' as const,
        ...at,
        message:
          'A PO box isn’t a place to visit — use the property’s street address.',
      }
      // Left out, it has to leave the client another site.
      issues.push(
        client.sites.length > 1
          ? withFix(issue, 'Leave this site out', (c) => withoutSite(c, i))
          : issue,
      )
    }
    if (client.kind === 'business' && site.siteContactPhone?.trim()) {
      issues.push(
        ...phoneIssues(
          site.siteContactPhone.trim(),
          'siteContactPhone',
          i,
          opts,
          (c) => patchSite(c, i, { siteContactPhone: undefined }),
        ),
      )
    }
    // The server keeps the first MAX_IMPORT_NOTE; said here, from the note
    // as it is, so an edit that shortens it takes this away. Counted as the
    // server counts, in whole characters (an emoji is one); a note no longer
    // than that in UTF-16 units can't be longer in characters.
    const note = site.note?.trim() ?? ''
    const noteLength =
      note.length > MAX_IMPORT_NOTE ? Array.from(note).length : 0
    if (noteLength > MAX_IMPORT_NOTE) {
      issues.push({
        level: 'warning',
        field: 'note',
        ...at,
        message: `This note is ${count(noteLength)} characters — only the first ${count(MAX_IMPORT_NOTE)} come across.`,
      })
    }
  })

  const phone = client.phone?.trim()
  if (phone) {
    issues.push(
      ...phoneIssues(phone, 'phone', undefined, opts, (c) => ({
        ...c,
        phone: undefined,
      })),
    )
  }

  const email = client.email?.trim()
  if (email) {
    const problem = emailProblem(email)
    // Only for an address that can be delivered to: it has an @, a part
    // before it and no spaces, which is what typoFix counts on.
    const typo = problem ? null : typoFix(email)
    if (problem) {
      issues.push(
        withFix(
          {
            level: 'error',
            field: 'email',
            message: `Email “${email}”: ${problem}`,
          },
          'Leave the email out',
          (c) => ({ ...c, email: undefined }),
        ),
      )
    } else if (typo) {
      issues.push(
        withFix(
          {
            level: 'warning',
            field: 'email',
            message: `Email ${email}: did you mean ${typo}?`,
          },
          `Use ${typo}`,
          (c) => ({ ...c, email: typo }),
        ),
      )
    }
  }

  const abn = client.kind === 'business' ? client.abn?.trim() : undefined
  if (abn) {
    const lost = isLost(abn)
    if (lost || !isValidAbn(abn)) {
      issues.push(
        withFix(
          {
            level: 'error',
            field: 'abn',
            message: lost
              ? lostMessage('ABN', abn)
              : abnDigits(abn)
                ? `The ABN ${formatAbn(abn)} doesn't pass the ATO's check — a digit is wrong.`
                : `“${abn}” isn't an ABN — an ABN is 11 digits.`,
          },
          'Leave the ABN out',
          (c) => ({ ...c, abn: undefined }),
        ),
      )
    }
  }
  return issues
}

// ---------------------------------------------------------------- across clients

const ACROSS = Symbol('across clients')

type Across = ReviewIssue & { [ACROSS]?: true }

const isAcross = (issue: ReviewIssue) => (issue as Across)[ACROSS] === true

function across(issue: ReviewIssue): ReviewIssue {
  ;(issue as Across)[ACROSS] = true
  return issue
}

/** A client as another's issue names it: its name, and its first row as the
 * person's spreadsheet numbers it — the headings being row 1 when the sheet
 * doesn't say (a client made in a test, say). */
function whoIs(client: ReviewClient): string {
  const name = client.name.trim() || 'a client with no name'
  const first = client.rowNumbers[0] as number | undefined
  const row =
    client.sheetRows?.[0] ?? (first === undefined ? undefined : first + 1)
  return row === undefined ? name : `${name} (row ${row})`
}

/** The client with one of its sites folded into an earlier one at the same
 * address, as two rows for one house are when the review is built: the
 * notes joined, a site contact the earlier lacks taken from the later. */
function putTogether(
  client: ReviewClient,
  into: number,
  from: number,
): ReviewClient {
  const joinedSite = joinSites(client.sites[into], client.sites[from])
  return withoutSite(patchSite(client, into, joinedSite), from)
}

/** Whether the client would be sent as it stands, by what is said of it
 * alone — what `checkAcrossClients` says of it left out. */
const wouldSend = (client: ReviewClient) =>
  importable({
    ...client,
    issues: client.issues.filter((issue) => !isAcross(issue)),
  })

/** The same issues in the same order, as the review shows them. */
const sameIssues = (a: Array<ReviewIssue>, b: Array<ReviewIssue>) =>
  a.length === b.length &&
  a.every(
    (issue, i) =>
      issue.level === b[i].level &&
      issue.field === b[i].field &&
      issue.siteIndex === b[i].siteIndex &&
      issue.message === b[i].message,
  )

/**
 * The checks that need every client at once, run at the end of
 * `buildReview` and again over the whole list after any change to it — an
 * edit, a fix, a client left out or brought back:
 *
 * - An address two clients in the file both have. The server writes the
 *   clients it is sent in file order and keeps one client per address, so
 *   the later client's site is skipped: a warning on each such site, or,
 *   when every site it would send is taken, an error — the server would
 *   write nothing of it, so the review can't count it in. Only a client
 *   that will be sent claims an address: one left out, one that can't be
 *   imported yet and one with every site already in PestM8 claim nothing,
 *   so a later client at the address has it. Fixed or brought back, the
 *   earlier client claims it again on the next run, and the later is told.
 * - Two of one client's own sites at one address — made so by a fix or an
 *   edit, as the review joins them when it is built. The server keeps the
 *   first and skips the other, note and all: a warning on the later, with
 *   a fix that puts the two together.
 * - Two clients that would both be sent and both join one client already
 *   in PestM8 (it matches by name alone), said on each so the person can
 *   leave one out.
 *
 * Idempotent: it takes off what it said last time before saying it again,
 * and returns a client unchanged when nothing it says has changed.
 * `recheckClient` sees one client only, so it drops these issues; running
 * this over the list after it puts them back.
 */
export function checkAcrossClients(
  clients: Array<ReviewClient>,
): Array<ReviewClient> {
  // siteKey → the first client in the file to send that address.
  const claims = new Map<string, ReviewClient>()
  const found = new Map<ReviewClient, Array<ReviewIssue>>()
  // The clients the import would send as things stand.
  const sending = new Set<ReviewClient>()
  for (const client of clients) {
    if (!client.included) continue
    const issues: Array<ReviewIssue> = []
    const sent = client.sites.flatMap((site, i) =>
      site.duplicate ? [] : [{ site, i, key: siteKey(site) }],
    )
    const what = (site: ReviewSite) =>
      site.note?.trim() ? 'this site and its note' : 'this site'
    const taken = sent.flatMap((s) => {
      const by = claims.get(s.key)
      return by ? [{ ...s, by }] : []
    })
    const shutOut = taken.length > 0 && taken.length === sent.length
    if (shutOut) {
      const first = taken[0]
      issues.push(
        across({
          level: 'error',
          field: 'addressLine',
          siteIndex: first.i,
          message: `Same address as ${whoIs(first.by)} — an address can only belong to one client in PestM8.`,
        }),
      )
    } else {
      for (const { site, i, by } of taken) {
        issues.push(
          across({
            level: 'warning',
            field: 'addressLine',
            siteIndex: i,
            message: `Same address as ${whoIs(by)} — ${what(site)} will be skipped.`,
          }),
        )
      }
      // Its own sites, of the addresses no earlier client has: what an
      // earlier client has is said above, once a site.
      const firstAt = new Map<string, number>()
      for (const { site, i, key } of sent) {
        if (claims.has(key)) continue
        const at = firstAt.get(key)
        if (at === undefined) {
          firstAt.set(key, i)
          continue
        }
        issues.push(
          across(
            withFix(
              {
                level: 'warning',
                field: 'addressLine',
                siteIndex: i,
                message: `Same address as site ${at + 1} — ${what(site)} will be skipped.`,
              },
              'Put them together',
              (c) => putTogether(c, at, i),
            ),
          ),
        )
      }
      // A partly taken client claims the rest, once all its sites have been
      // looked at — but only if it will be sent: an address the server is
      // never sent is free for the next client in the file.
      if (wouldSend(client)) {
        sending.add(client)
        for (const { key } of sent) {
          if (!claims.has(key)) claims.set(key, client)
        }
      }
    }
    found.set(client, issues)
  }

  // existingClientId → the clients that would add sites to it.
  const joining = new Map<string, Array<ReviewClient>>()
  for (const client of clients) {
    const id = client.existingClientId
    if (!id || !sending.has(client)) continue
    const group = joining.get(id)
    if (group) group.push(client)
    else joining.set(id, [client])
  }
  for (const group of joining.values()) {
    if (group.length < 2) continue
    const all = group.length === 2 ? 'both' : `all ${count(group.length)}`
    const leave =
      group.length === 2
        ? 'Leave one out if they’re different people.'
        : 'Leave out any that are different people.'
    for (const client of group) {
      // Two by name at most: a name column mapped wrong can match hundreds.
      const named = group
        .slice(0, 3)
        .filter((c) => c !== client)
        .slice(0, 2)
        .map(whoIs)
        .join(', ')
      const others = group.length - 1
      const more = others > 2 ? ` and ${count(others - 2)} more` : ''
      found.get(client)?.push(
        across({
          level: 'warning',
          field: 'name',
          message: `Also matched: ${named}${more} — ${all} would be added to the same client in PestM8. ${leave}`,
        }),
      )
    }
  }

  return clients.map((client) => {
    const said = sortIssues(found.get(client) ?? [])
    const before = client.issues.filter(isAcross)
    if (sameIssues(before, said)) return client
    const kept = client.issues.filter((issue) => !isAcross(issue))
    return { ...client, issues: sortIssues([...kept, ...said]) }
  })
}

/** What the review says of a site already in PestM8, and whose it is when
 * that isn't the client's own. */
export function duplicateSiteMessage(site: ReviewSite): string {
  return site.heldBy
    ? `Already in PestM8, on ${site.heldBy} — this site is skipped`
    : 'Already in PestM8 — this site is skipped'
}

// ---------------------------------------------------------------- one client

/**
 * The client judged again after an edit or a fix: its issues worked out
 * afresh from its fields, the notes of what was fixed on the way in kept
 * while they still hold, and whether it — and each site — is already in
 * PestM8. The address tables' warnings are checks.ts's; run
 * `checkClientOffline` after this. What `checkAcrossClients` said is
 * dropped, as this sees one client only: run that over the list after.
 */
export function recheckClient(
  client: ReviewClient,
  opts: { businessState: string; existing: ExistingIndex },
): ReviewClient {
  const key = nameKey(client.name)
  const sites = client.sites.map((site): ReviewSite => {
    const { duplicate: _was, heldBy: _by, ...rest } = site
    const at = siteKey(site)
    if (!opts.existing.siteKeys.has(at)) return rest
    // Whose it is, when that is another client: "Already in PestM8" alone
    // would say this client is there, which it may not be.
    const holder = opts.existing.siteHolders?.get(at)
    return holder && nameKey(holder) !== key
      ? { ...rest, duplicate: true, heldBy: holder }
      : { ...rest, duplicate: true }
  })
  const existingClientId = key
    ? opts.existing.clientsByName.get(key)
    : undefined
  const { existingClientId: _old, ...base } = client
  const next: ReviewClient = {
    ...base,
    ...(existingClientId ? { existingClientId } : {}),
    sites,
  }

  const onSentSite = (issue: ReviewIssue) =>
    issue.siteIndex === undefined || !sites[issue.siteIndex]?.duplicate
  const held = client.issues.filter((issue) => {
    const still = (issue as Held)[STILL]
    return still !== undefined && onSentSite(issue) && still(next)
  })
  // A held issue says it better than the plain one for the same field:
  // "Couldn't tell the street from the suburb" over "No suburb".
  const current = currentIssues(next, opts).filter(
    (issue) =>
      !held.some(
        (h) =>
          h.level === issue.level &&
          h.field === issue.field &&
          h.siteIndex === issue.siteIndex,
      ),
  )
  return { ...next, issues: sortIssues([...held, ...current]) }
}
