import {
  getJsonWithin,
  isOffline,
  networkLookupsAllowed,
} from '#/lib/addressLookup'
import {
  addressErrors,
  addressSignature,
  readStreetCheck,
  streetCheckUrl,
} from '#/lib/addressVerify'
import type { AddressIssue, AddressValue } from '#/lib/addressVerify'

/**
 * The rules behind VerifiedAddressFields that need no React, kept apart so
 * they can be tested, and so a form can use them too (`addressCheckToSend`).
 */

/**
 * How the address being saved came to be, for the server
 * (`properties.*`'s `addressCheck`): 'picked' while the four fields still
 * hold the suggestion picked for them, 'typed' otherwise — typed by hand, or
 * picked and since rewritten by autofill.
 */
export type AddressCheck = 'picked' | 'typed'

const FIELDS = ['addressLine', 'suburb', 'state', 'postcode'] as const

/**
 * 'picked' when the address still has the picked suggestion's signature
 * (street name, suburb, state, postcode — a corrected house number keeps it),
 * else 'typed'. `pickedSignature` is `addressSignature` of what was picked,
 * or null when nothing was.
 */
export function addressCheckFor(
  value: AddressValue,
  pickedSignature: string | null,
): AddressCheck {
  return pickedSignature !== null && addressSignature(value) === pickedSignature
    ? 'picked'
    : 'typed'
}

/** The field as it would be saved: trimmed, and the state's code in capitals. */
function saved(field: keyof AddressValue, value: AddressValue): string {
  const text = value[field].trim()
  return field === 'state' ? text.toUpperCase() : text
}

/**
 * Whether anything in the address differs from what the record has saved.
 * With no `initial` (a new record) it always has.
 */
export function addressChanged(
  value: AddressValue,
  initial?: AddressValue,
): boolean {
  if (!initial) return true
  return FIELDS.some((f) => saved(f, value) !== saved(f, initial))
}

/** Nothing typed: no street, suburb or postcode. The state is left out, since
 * it starts on the business's own. */
export function addressBlank(value: AddressValue): boolean {
  return (
    value.addressLine.trim() === '' &&
    value.suburb.trim() === '' &&
    value.postcode.trim() === ''
  )
}

/**
 * The `addressCheck` to send with a save: left out when there is no address,
 * or an edit left it as saved — the server's stamp is about the address it
 * was given, and an untouched one was not given again.
 */
export function addressCheckToSend(
  check: AddressCheck,
  value: AddressValue,
  initial?: AddressValue,
): AddressCheck | undefined {
  if (addressBlank(value) || !addressChanged(value, initial)) return undefined
  return check
}

/**
 * The postcode's hard error, and whether it blocks. A postcode typed now that
 * is not four digits blocks the save. One already saved that way, and left
 * alone, does not: nothing here makes an old record unsaveable. It is still
 * said, as a warning.
 */
export function postcodeProblem(
  value: AddressValue,
  initial?: AddressValue,
): { issue: AddressIssue; blocks: boolean } | null {
  const issue = addressErrors(value).at(0)
  if (!issue) return null
  const changed =
    !initial || saved('postcode', value) !== saved('postcode', initial)
  return { issue, blocks: changed }
}

/**
 * The issues a form without a State field can act on. With the state fixed
 * to the business's own, one about the state (outside the work area) cannot
 * be, and a fix that would change the state is left off its issue.
 */
export function issuesWithoutState(
  issues: ReadonlyArray<AddressIssue>,
): Array<AddressIssue> {
  return issues
    .filter((issue) => issue.field !== 'state')
    .map((issue) =>
      issue.fix && 'state' in issue.fix.patch
        ? { field: issue.field, level: issue.level, message: issue.message }
        : issue,
    )
}

/**
 * The street check at save, with why it said nothing when it did not, for the
 * line under the address:
 * - 'found': the map has the street in that suburb.
 * - 'not-found': the map knows the suburb, not the street (with `issue`).
 * - 'unknown': an answer came, but not a clear one (the map does not know
 *   the suburb either). Nothing is said.
 * - 'no-signal': offline, or no answer within the time allowed.
 * - 'skipped': not asked — a test runner drives the browser, or too little
 *   is typed to ask about.
 *
 * Asks what `checkStreetOnline` (src/lib/addressVerify.ts) asks, and reads the
 * reply the same way; that one cannot tell no signal from no clear answer.
 * Never throws. Only the street's name and the suburb are sent.
 */
export type StreetCheckOutcome =
  | { status: 'found' | 'unknown' | 'no-signal' | 'skipped' }
  | { status: 'not-found'; issue: AddressIssue }

/** As long as Save will wait: the form gives each check 3 seconds. */
export const STREET_CHECK_TIMEOUT_MS = 3000

export async function checkStreetAtSave(
  value: AddressValue,
  opts: { signal?: AbortSignal; workState?: string },
): Promise<StreetCheckOutcome> {
  const url = streetCheckUrl(value)
  if (!url || !networkLookupsAllowed()) return { status: 'skipped' }
  if (isOffline()) return { status: 'no-signal' }
  const reply = await getJsonWithin(url, {
    signal: opts.signal,
    timeoutMs: STREET_CHECK_TIMEOUT_MS,
  })
  if (!reply.ok) return { status: 'no-signal' }
  try {
    const read = readStreetCheck(reply.json, value, opts.workState)
    if (read.status === 'found') return { status: 'found' }
    if (read.status === 'not-found' && read.issue) {
      return { status: 'not-found', issue: read.issue }
    }
    return { status: 'unknown' }
  } catch {
    return { status: 'unknown' }
  }
}
