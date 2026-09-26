import { addressErrors, checkAddressOffline } from '#/lib/addressVerify'
import { holdWhile } from './build'
import type { AddressIssue, AddressValue } from '#/lib/addressVerify'
import type { ReviewClient, ReviewIssue, ReviewSite } from './types'

/**
 * The address checks of the review: each site's suburb, state and postcode
 * against G-NAF's suburb tables, bundled with the app — the same warnings
 * a site form gives at Save ("Bayswater's postcode is usually 6053").
 *
 * Offline only, and on purpose. The street check a form does against
 * Photon is a free service with a fair-use policy, and 2,000 lookups in a
 * burst is not fair use; the tables answer everything but "is the street
 * there", in no time.
 *
 * Run again after every edit: the warnings from the last run are taken off
 * first, so they never pile up.
 */

const OFFLINE = Symbol('offline address check')

type Offline = ReviewIssue & { [OFFLINE]?: true }

const isOffline = (issue: ReviewIssue) => (issue as Offline)[OFFLINE] === true

function addressOf(site: ReviewSite): AddressValue {
  return {
    addressLine: site.addressLine,
    suburb: site.suburb,
    state: site.state,
    postcode: site.postcode,
  }
}

function sameAddress(site: ReviewSite | undefined, value: AddressValue) {
  return (
    site !== undefined &&
    site.addressLine === value.addressLine &&
    site.suburb === value.suburb &&
    site.state === value.state &&
    site.postcode === value.postcode
  )
}

/**
 * A table's issue as the review's. Its fix puts the patch on that one site,
 * and takes this site's table warnings away with it, as they were about
 * the address before the fix; the next run says what still applies.
 */
function fromTable(
  found: AddressIssue,
  level: 'warning' | 'error',
  siteIndex: number,
  value: AddressValue,
): ReviewIssue {
  const issue: Offline = {
    level,
    field: found.field,
    siteIndex,
    message: found.message,
    [OFFLINE]: true,
  }
  const fix = found.fix
  if (fix) {
    const patch = fix.patch
    issue.fix = {
      label: fix.label,
      apply: (client) => ({
        ...client,
        sites: client.sites.map((site, i) =>
          i === siteIndex ? { ...site, ...patch } : site,
        ),
        issues: client.issues.filter(
          (i) => !(isOffline(i) && i.siteIndex === siteIndex),
        ),
      }),
    }
  }
  // Kept through `recheckClient` only while the site's address is the one
  // that was checked.
  return holdWhile(issue, (client) =>
    sameAddress(client.sites[siteIndex], value),
  )
}

/** One run's answers, by suburb, state and postcode — all a table check
 * looks at. A file of one town's clients asks the same few dozen times. */
type Answers = Map<string, Promise<Array<AddressIssue>>>

async function check(
  client: ReviewClient,
  businessState: string,
  answers: Answers,
): Promise<ReviewClient> {
  const kept = client.issues.filter((issue) => !isOffline(issue))
  const added: Array<ReviewIssue> = []

  for (const [i, site] of client.sites.entries()) {
    // Already in PestM8: not sent, so not checked.
    if (site.duplicate) continue
    const value = addressOf(site)

    // The review already says so when the postcode isn't four digits, most
    // often with the same fix; this only adds one it doesn't have.
    for (const error of addressErrors(value)) {
      const said = kept.some(
        (k) =>
          k.level === 'error' && k.field === error.field && k.siteIndex === i,
      )
      if (!said) added.push(fromTable(error, 'error', i, value))
    }

    // As typed, case and all: the warning quotes the suburb back.
    const key = [value.suburb, value.state, value.postcode]
      .map((part) => part.trim())
      .join('|')
    let answer = answers.get(key)
    if (!answer) {
      answer = checkAddressOffline(value, { workState: businessState })
      answers.set(key, answer)
    }
    for (const warning of await answer) {
      added.push(fromTable(warning, 'warning', i, value))
    }
  }

  if (added.length === 0 && kept.length === client.issues.length) {
    return client
  }
  return { ...client, issues: byLevel([...kept, ...added]) }
}

const LEVEL_ORDER = { error: 0, warning: 1, fixed: 2 } as const

/** Errors first, as the review lists them; within a level, by site. */
function byLevel(issues: Array<ReviewIssue>): Array<ReviewIssue> {
  return issues.sort(
    (a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      (a.siteIndex ?? -1) - (b.siteIndex ?? -1),
  )
}

/** One client's address checks, after an edit or a fix. */
export async function checkClientOffline(
  client: ReviewClient,
  opts: { businessState: string },
): Promise<ReviewClient> {
  return check(client, opts.businessState, new Map())
}

/** How long the checks run before a breath, in milliseconds: under a frame,
 * so the page can paint "Checking addresses…" and its count, and a tap on
 * Back is answered. */
const SLICE_MS = 12

/**
 * Every client's address checks. The tables load once per state; after
 * that most checks are quick, but 2,000 of them in one go would still hold
 * the page still. So they run one client at a time, with a breath whenever
 * 12 ms have gone by: by the clock, not by a count, as a suburb the tables
 * don't have takes far longer to check than one they do (it is compared
 * with every name of about its length for "Did you mean").
 */
export async function runOfflineChecks(
  clients: Array<ReviewClient>,
  opts: {
    businessState: string
    /** Called at each breath and at the end, for a count on the page. */
    onProgress?: (done: number, total: number) => void
    /** True once the result is no longer wanted (the person went back, or
     * started again): the run stops at its next breath. */
    stopped?: () => boolean
  },
): Promise<Array<ReviewClient>> {
  const answers: Answers = new Map()
  const out: Array<ReviewClient> = []
  let since = performance.now()
  for (const client of clients) {
    out.push(await check(client, opts.businessState, answers))
    if (out.length < clients.length && performance.now() - since >= SLICE_MS) {
      opts.onProgress?.(out.length, clients.length)
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (opts.stopped?.()) return out
      since = performance.now()
    }
  }
  if (clients.length > 0) opts.onProgress?.(out.length, clients.length)
  return out
}
