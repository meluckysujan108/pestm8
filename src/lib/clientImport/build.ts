import { STREET_TYPES } from '#/lib/addressLookup'
import { abnDigits, formatAbn, isValidAbn } from '../../../convex/lib/abn'
import {
  AU_STATE_CODES,
  nameKey,
  phoneProblem,
  siteKey,
} from '../../../convex/lib/clientImport'
import { emailProblem, emailTypoFix } from '../../../convex/lib/email'
import { checkPhone } from '../../../convex/lib/phone'
import { stateOfPostcode } from '../../../convex/lib/postcodes'
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
    // A code (WA, NSW) is always the state. A whole name might be the end
    // of a place's: taken as the state only when nothing says otherwise.
    const spelt =
      words
        .slice(-n)
        .join('')
        .replace(/[^a-z]/gi, '').length > 3
    if (spelt) {
      const before = rest.split(' ').pop()?.toLowerCase() ?? ''
      if (BEFORE_A_PLACE_NAME.has(before)) return null
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

/** An "Is a company?" or customer-type cell that says so, either way. */
const YES =
  /^(?:y|yes|true|1|x|company|business|commercial|organisation|organization|corporate)$/i
const NO = /^(?:n|no|false|0|individual|person|residential|private|domestic)$/i

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
  kind: 'person' | 'business'
  name: string
  contactPerson?: string
  phone?: string
  email?: string
  abn?: string
  site?: ReviewSite
  siteNotes: Array<SiteNote>
  notes: Array<ReviewIssue>
}

/** A phone as the file had it, with a lost leading 0 put back and Excel's
 * exponent written out when no digit was lost to it. */
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
  // The file's own word beats every guess; then a real ABN, which a
  // household doesn't give its pest controller (Xero has no company
  // column, only a tax number); then the name.
  const flag = tidy(v.isCompany)
  const business =
    company !== '' ||
    YES.test(flag) ||
    myobCompany ||
    (!NO.test(flag) &&
      ((abnValue !== undefined && isValidAbn(abnValue)) ||
        (!splitAsPerson && looksLikeBusiness(nameColumn || person))))
  const kind = business ? 'business' : 'person'
  const name = business ? company || nameColumn || person : nameColumn || person

  let contactPerson: string | undefined
  if (business) {
    const candidates = [
      tidy(v.contactPerson),
      person,
      company ? nameColumn : '',
    ]
    contactPerson = candidates.find(
      (c) => c !== '' && nameKey(c) !== nameKey(name),
    )
  }

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
          message: `Couldn't tell the street from the suburb in “${line}” — edit it.`,
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
    if (business) {
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
              (c) => c.sites[i]?.siteContactPhone === value,
            ),
          )
        }
      }
    }
  }

  return {
    rowNumber,
    kind,
    name,
    ...(contactPerson ? { contactPerson } : {}),
    ...(phoneValue ? { phone: phoneValue } : {}),
    ...(email ? { email } : {}),
    ...(abn ? { abn } : {}),
    ...(site ? { site } : {}),
    siteNotes,
    notes,
  }
}

// ---------------------------------------------------------------- grouping

/** What says two rows of one name are one client: the same email or phone,
 * or neither having any. */
function contactIds(draft: Draft): Array<string> {
  const ids: Array<string> = []
  if (draft.email) ids.push(draft.email.toLowerCase())
  if (draft.phone) {
    const digits = draft.phone.replace(/\D/g, '')
    if (digits) ids.push(digits)
  }
  return ids
}

function sameClient(a: Draft, b: Draft): boolean {
  const ours = contactIds(a)
  const theirs = contactIds(b)
  if (ours.length === 0 && theirs.length === 0) return true
  return ours.some((id) => theirs.includes(id))
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
  const keys: Array<string> = []
  for (const draft of drafts) {
    if (!draft.site) continue
    const key = siteKey(draft.site)
    const at = keys.indexOf(key)
    if (at === -1) {
      const index = sites.length
      sites.push(draft.site)
      keys.push(key)
      notes.push(...draft.siteNotes.map((note) => note(index)))
      continue
    }
    const kept = sites[at]
    const note =
      draft.site.note && draft.site.note !== kept.note
        ? [kept.note, draft.site.note].filter(Boolean).join('\n\n')
        : kept.note
    sites[at] = {
      ...kept,
      ...(note ? { note } : {}),
      ...(!kept.siteContactName && draft.site.siteContactName
        ? { siteContactName: draft.site.siteContactName }
        : {}),
      ...(!kept.siteContactPhone && draft.site.siteContactPhone
        ? { siteContactPhone: draft.site.siteContactPhone }
        : {}),
    }
  }

  const kind = drafts.some((d) => d.kind === 'business') ? 'business' : 'person'
  const contactPerson = pick('contactPerson')
  const phone = pick('phone')
  const email = pick('email')
  const abn = kind === 'business' ? pick('abn') : undefined
  const client: ReviewClient = {
    key: `c${head.rowNumber}`,
    rowNumbers: drafts.map((d) => d.rowNumber),
    kind,
    name: head.name,
    ...(kind === 'business' && contactPerson ? { contactPerson } : {}),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(abn ? { abn } : {}),
    sites,
    issues: notes,
    included: true,
  }
  return recheckClient(client, opts)
}

/**
 * Every row of the sheet as clients to review. Rows with the same name and
 * the same email or phone (or neither) are one client with a site each —
 * Jobber's one row per property. Each client is checked, tidied and matched
 * against what PestM8 already holds; nothing is sent.
 */
export function buildReview(
  sheet: ImportSheet,
  mapping: ColumnMapping,
  opts: { businessState: string; existing: ExistingIndex },
): Array<ReviewClient> {
  const groups: Array<Array<Draft>> = []
  const byName = new Map<string, Array<Array<Draft>>>()
  sheet.rows.forEach((row, i) => {
    const draft = draftOf(row, i + 1, sheet, mapping, opts)
    const key = nameKey(draft.name)
    // No name, nothing to group by: each is its own client, and an error.
    const candidates = key ? (byName.get(key) ?? []) : []
    const group = candidates.find((g) => sameClient(g[0], draft))
    if (group) {
      group.push(draft)
      return
    }
    const fresh = [draft]
    groups.push(fresh)
    if (key) byName.set(key, [...candidates, fresh])
  })
  return groups.map((drafts) => merge(drafts, opts))
}

// ---------------------------------------------------------------- judging

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

/**
 * The client judged again after an edit or a fix: its issues worked out
 * afresh from its fields, the notes of what was fixed on the way in kept
 * while they still hold, and whether it — and each site — is already in
 * PestM8. The address tables' warnings are checks.ts's; run
 * `checkClientOffline` after this.
 */
export function recheckClient(
  client: ReviewClient,
  opts: { businessState: string; existing: ExistingIndex },
): ReviewClient {
  const sites = client.sites.map((site): ReviewSite => {
    const duplicate = opts.existing.siteKeys.has(siteKey(site))
    if (duplicate) return { ...site, duplicate: true }
    const { duplicate: _gone, ...rest } = site
    return rest
  })
  const key = nameKey(client.name)
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
