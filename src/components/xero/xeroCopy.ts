import type { ErrorCopy } from '#/components/forms/describeError'

/**
 * Every word Settings → Xero and My Xero say about something going wrong,
 * in one place (design system §7: error copy lives in maps, not components).
 *
 * The server never sends words. The callback (convex/xeroCallback.ts) sends
 * the browser back with `?xero=<code>`, the functions refuse with a bare
 * `ConvexError('<CODE>')`, and a connection's row carries `problem.code` —
 * each turned into a sentence here that says what happened and what to do.
 * Raw Xero text only ever goes to the server's log.
 */

export type XeroKind = 'business' | 'member'

/**
 * Why Xero sent the browser back without a connection (`?xero=`). The
 * callback's refusal reasons (`storeCallback`) plus its own outcomes:
 * cancelled at Xero, a failed exchange, no organisation chosen, no telling
 * which one was, and a sign-in that took longer than the state's 10 minutes.
 *
 * "Nothing changed in Xero" where it is true and worth saying: a refusal
 * deletes the connection Xero had just made (unless another row still uses
 * it), so the organisation is left as it was.
 */
export const XERO_RETURN_COPY: Readonly<Record<string, string>> = {
  cancelled: 'The sign-in to Xero was cancelled, so nothing changed.',
  // Xero lets an organisation connect two apps that it hasn't certified, and
  // PestM8 is one. A third is refused on Xero's side, and it comes back here
  // as a failure — the one case worth naming, since nothing on PestM8's side
  // will fix it.
  failed:
    'Could not connect Xero. Try again — if it fails again, open Xero → Settings → Connected apps: Xero lets an organisation connect only two apps like PestM8.',
  no_org:
    'Could not connect Xero: no organisation was chosen. Connect again, and choose your organisation when Xero asks.',
  // Xero didn't say which of the organisations this login has it chose, and
  // guessing could copy every client into the wrong books.
  ambiguous_org:
    'Could not connect: Xero didn’t say which organisation you chose, so nothing was connected. Connect again, and choose just the one organisation.',
  business_org:
    'Could not connect: that’s the business’s Xero, which the owner has already connected. Connect your own organisation instead. Nothing changed in Xero.',
  member_org:
    'Could not connect: a team member has connected that organisation as their own Xero. Choose the business’s organisation. Nothing changed in Xero.',
  taken:
    'Could not connect: that Xero organisation is already connected here. Choose another one. Nothing changed in Xero.',
  different_org:
    'Could not reconnect: a different organisation was chosen in Xero. Reconnect to the same one, or disconnect first to change organisation.',
  org_cap:
    'Could not connect: PestM8 can’t take on another Xero organisation yet. Nothing changed in Xero — try again later.',
  demo: 'Could not connect: the demo business can’t be connected to Xero.',
  expired:
    'Could not connect: the sign-in to Xero took too long. Connect again.',
}

/** The words for `?xero=<code>`; an unknown code reads as a failure. */
export function xeroReturnCopy(code: string): string {
  return XERO_RETURN_COPY[code] ?? XERO_RETURN_COPY.failed
}

/**
 * Connect Xero (`xero.startConnect`). Fails fast with no signal: a start
 * held until the signal came back would send the phone off to Xero long after
 * the tap seemed to do nothing.
 */
export function startErrorCopy(kind: XeroKind): ErrorCopy {
  return {
    XERO_NOT_CONFIGURED:
      'Could not open Xero: this copy of PestM8 isn’t set up for Xero.',
    XERO_DEMO: XERO_RETURN_COPY.demo,
    XERO_TWO_STEP_REQUIRED:
      'Could not open Xero: turn on two-step sign-in first, in Settings → Two-step sign-in.',
    SWITCHED:
      'Could not open Xero: switch back to your own account first, then connect.',
    NO_ACCESS:
      kind === 'business'
        ? 'Could not open Xero: only the business owner can connect the business’s Xero.'
        : 'Could not open Xero: the owner connects the business’s Xero in Settings → Xero.',
    offline:
      'Could not open Xero: this device is offline. Try again when you have signal.',
    default: 'Could not open Xero. Check your signal and try again.',
  }
}

/**
 * Finishing the connection on the way back from Xero (`xero.finishConnect`).
 * The finish token is single use, so every failure ends with "connect
 * again": there is nothing left to retry with.
 */
export const FINISH_ERROR_COPY: ErrorCopy = {
  FINISH_EXPIRED:
    'Could not finish connecting: that sign-in to Xero is too old, or was already used. Connect again.',
  NO_ACCESS:
    'Could not finish connecting: Xero was opened from another PestM8 sign-in. Connect again from this one.',
  TAKEN:
    'Could not finish connecting: that Xero organisation is already connected here. Choose another one.',
  SWITCHED:
    'Could not finish connecting: switch back to your own account, then connect again.',
  XERO_TWO_STEP_REQUIRED:
    'Could not finish connecting: two-step sign-in is off. Turn it on in Settings → Two-step sign-in, then connect again.',
  XERO_DEMO: XERO_RETURN_COPY.demo,
  XERO_NOT_CONFIGURED:
    'Could not finish connecting: this copy of PestM8 isn’t set up for Xero.',
  offline:
    'Could not finish connecting: this device is offline. Connect again when you have signal.',
  default:
    'Could not finish connecting to Xero. Check your signal, then connect again.',
}

/**
 * Disconnect (`xero.disconnect`). Fails fast with no signal: it releases the
 * connection at Xero, which nobody should find happening hours later.
 */
export const DISCONNECT_ERROR_COPY: ErrorCopy = {
  NO_ACCESS:
    'Could not disconnect: only whoever connected this Xero can disconnect it.',
  SWITCHED:
    'Could not disconnect: switch back to your own account first, then try again.',
  NOT_FOUND:
    'Could not disconnect: it has already been disconnected. Close this and look again.',
  offline:
    'Could not disconnect: this device is offline. Xero is still connected — try again when you have signal.',
  default:
    'Could not disconnect. Xero is still connected — check your signal and try again.',
}

/**
 * Why a connection needs attention (`problem.code` on its row), for the line
 * under the organisation's name.
 *
 * - `reconnect`: Xero stopped accepting PestM8's sign-in (an expired or
 *   revoked refresh token, or a 403) — the row is `needs_reconnect`.
 * - `xero_side`: a disconnect PestM8 could not finish at Xero, because the
 *   sign-in had already died. The connection stays listed under Xero's
 *   Connected apps, and only the person can remove it there.
 * - `org_gone`: the organisation is no longer reachable with this sign-in.
 */
export function problemCopy(code: string, tenantName: string): string {
  switch (code) {
    case 'xero_side':
      return `PestM8 could not remove itself from ${tenantName} in Xero. To finish, open Xero → Settings → Connected apps and remove PestM8.`
    case 'org_gone':
      return `${tenantName} is no longer connected in Xero. Reconnect to carry on.`
    default:
      return 'Xero stopped accepting PestM8’s sign-in. Reconnect to carry on.'
  }
}

/**
 * What connecting means, said before the button is pressed: the whole client
 * book goes, every change follows, and nothing is ever deleted there. The
 * audit row records that this was shown (`disclosure: 'whole_book_v1'`), so a
 * change to these words that changes their meaning is a new version there
 * too.
 */
export function disclosureCopy(
  kind: XeroKind,
  business: string,
  owner: string,
): string {
  return kind === 'business'
    ? `Every client in ${business} is copied into the Xero organisation you choose, with every change after that. Leads wait until their first job is booked. PestM8 never deletes anything in Xero.`
    : `Every client in ${business} is copied into your Xero organisation, with every change after that, so you can invoice any of them. They stay in your Xero if you leave ${business}. ${owner} can see which organisation you connected.`
}

/** The line above the button, saying what connecting is for. */
/**
 * Why Connect Xero is not offered yet: connecting needs two-step sign-in on
 * (convex/xero.ts `requireTwoStep`), because Xero asks every app for strong
 * sign-in on whoever links an organisation.
 */
export const TWO_STEP_FIRST =
  'Xero asks for two-step sign-in on any account that connects it. Turn it on first, then come back here.'

export const EXPLAINER: Readonly<Record<XeroKind, string>> = {
  business:
    'Connect the business’s Xero, and PestM8 keeps its contacts in step with your clients — nobody types them in twice.',
  member:
    'Connect your own Xero organisation, so the clients you invoice are already in it.',
}

/**
 * A connection's state as one short value: the organisation's name once it
 * is connected (or needs reconnecting), else "Not connected". For the
 * Settings hub's rows and the Team page's line.
 */
export function connectionValue(
  view: { status: string; tenantName: string } | null | undefined,
): string {
  if (!view) return 'Not connected'
  return view.status === 'connected' || view.status === 'needs_reconnect'
    ? view.tenantName
    : 'Not connected'
}

// ──────────────────────────────────────────── matching (Release 2)

/**
 * A connection's match run, as `xero.status` gives it (`match` on its view):
 * null until PestM8 is first asked to read the organisation's contacts.
 */
type MatchSummary = {
  state: 'reading' | 'ready' | 'failed'
  review: number
}

/**
 * What the page makes of a connection's match, as `useMatchStage`
 * (XeroPage.tsx) works it out from `xero.status` and the clock:
 *
 * - `reading`: a run is reading Xero, or is about to;
 * - `ready`: the counts and the lists;
 * - `failed`: why not (`problem`, worded by `matchProblemCopy`), and what to
 *   offer (`matchRetry`). Besides the run's own codes, `stopped` is a read
 *   past believing — its run died without saying so — and `not_read` a
 *   connection made before matching existed, never read.
 */
export type MatchStage =
  | { stage: 'reading' }
  | { stage: 'ready' }
  | { stage: 'failed'; problem: string | null }

/**
 * What a failed match offers under its amber line: Check Xero again where
 * it can help; Reconnect Xero (a link to the Xero page, whose Reconnect it
 * is) where the server would refuse a check until then; or nothing where
 * trying again can't help — an organisation too big to match, or Xero
 * paused by PestM8 (until it is unpaused).
 */
export function matchRetry(
  problem: string | null,
  connection: { status: string },
  paused: boolean,
): 'rematch' | 'reconnect' | 'none' {
  if (connection.status === 'needs_reconnect') return 'reconnect'
  if (problem === 'too_many_contacts') return 'none'
  if (problem === 'paused' && paused) return 'none'
  return 'rematch'
}

/**
 * How many clients wait for the holder to say Same or Different, for the
 * Settings hub's "{n} to check" badge. Only on a working connection whose
 * match has finished: a disconnected one keeps its last counts, and a run
 * under way has zeroed them.
 */
export function matchToCheck(
  view: { status: string; match: MatchSummary | null } | null | undefined,
): number {
  if (!view || view.status !== 'connected') return 0
  return view.match?.state === 'ready' ? view.match.review : 0
}

/** "3 clients", "1 client": counts are digits with their noun (§7). */
export function clientCount(n: number): string {
  return `${n.toLocaleString('en-AU')} ${n === 1 ? 'client' : 'clients'}`
}

/**
 * Why PestM8 could not read an organisation's contacts (`match.problem`, a
 * code from `xeroMatch.run`, or the page's own — `MatchStage`), for the
 * amber line over whatever `matchRetry` offers. Nothing is ever written to
 * Xero while matching, so none of these has changed anything there.
 *
 * - `reconnect`: Xero stopped accepting PestM8's sign-in. The connection is
 *   marked for reconnecting too, and reconnecting reads the contacts again
 *   by itself.
 * - `busy`: another of PestM8's jobs held this organisation (one at a time,
 *   because Xero's limits are per organisation) for ten tries in a row.
 * - `too_many_contacts`: more than 50 pages of 1,000. No retry offered.
 * - `rate_limited`: Xero asked PestM8 to wait longer than a run waits — in
 *   practice the organisation's calls for the day are spent.
 * - `xero_unavailable`: Xero down or failing, through every retry.
 * - `paused`: `XERO_SYNC_PAUSED` is on. No retry offered while it is.
 * - `stopped`: the read died part-way without saying why (a deploy, the
 *   action time limit), and is past believing (`xeroMatch.matchStaleAfter`).
 * - `not_read`: connected before matching existed, and never read.
 * - anything else: a refusal or a fault, worth trying again.
 */
export function matchProblemCopy(
  code: string | null,
  tenantName: string,
): string {
  switch (code) {
    case 'reconnect':
      return `Could not read the contacts in ${tenantName}: Xero stopped accepting PestM8’s sign-in. Reconnect, and PestM8 reads them again.`
    case 'busy':
      return `Could not read the contacts in ${tenantName}: Xero was busy with another of PestM8’s jobs for that organisation. Check Xero again in a few minutes.`
    case 'too_many_contacts':
      return `Could not read the contacts in ${tenantName}: it holds more than 50,000, which is more than PestM8 can match yet. Nothing changed in Xero, and nothing is needed from you for now.`
    case 'rate_limited':
      return `Could not read the contacts in ${tenantName}: Xero has had as many calls from that organisation as it allows for now. Nothing changed there — check Xero again later today.`
    case 'xero_unavailable':
      return `Could not read the contacts in ${tenantName}: Xero isn’t answering properly just now. Nothing changed there — check Xero again in a few minutes.`
    case 'paused':
      return `PestM8 has paused its work with Xero for now, so the contacts in ${tenantName} weren’t read. Nothing is needed from you — check Xero again once it’s back.`
    case 'stopped':
      return `PestM8 stopped part-way through reading the contacts in ${tenantName}. Nothing changed in Xero — check Xero again.`
    case 'not_read':
      return `PestM8 hasn’t read the contacts in ${tenantName} yet. Check Xero again to match them to your clients.`
    default:
      return `Could not read the contacts in ${tenantName} from Xero. Nothing changed there — check Xero again in a few minutes.`
  }
}

/**
 * Check Xero again (`xeroMatch.rematch`). Fails fast with no signal: a check
 * held for the signal would start a read of Xero long after the tap seemed
 * to do nothing.
 */
export const REMATCH_ERROR_COPY: ErrorCopy = {
  XERO_MATCH_RUNNING:
    'Could not check Xero again: PestM8 is still reading it. Give it a few minutes.',
  XERO_RECONNECT:
    'Could not check Xero: it needs reconnecting first. Reconnect Xero, and PestM8 reads it again.',
  XERO_NOT_CONFIGURED:
    'Could not check Xero: this copy of PestM8 isn’t set up for Xero.',
  NOT_FOUND:
    'Could not check Xero: it has been disconnected. Reload this page to see where it stands.',
  NO_ACCESS:
    'Could not check Xero: only whoever connected this Xero can check it again.',
  SWITCHED:
    'Could not check Xero: switch back to your own account first, then try again.',
  offline:
    'Could not check Xero: this device is offline. Try again when you have signal.',
  default: 'Could not check Xero. Check your signal and try again.',
}

/** Why PestM8 isn't sure a client is that Xero contact (`candidate.reason`),
 * the one line on a To check card. `unlinked` is a client put back by Match
 * again after an Unlink. */
export const MATCH_REASON_COPY: Readonly<
  Record<
    | 'account_number_only'
    | 'email_only'
    | 'name_only'
    | 'name_shared'
    | 'contested'
    | 'unlinked',
    string
  >
> = {
  account_number_only: 'Same account number, different name',
  email_only: 'Same email, different name',
  name_only: 'Same name',
  name_shared: 'Same name — Xero has more than one contact by this name',
  contested: 'More than one of your clients matches this contact',
  unlinked: 'You unlinked these before',
}

/**
 * Same client / Different client on a To check card (`xeroMatch.decide`).
 * Fails fast with no signal, like every save here that can't be put back
 * from the page it was made on.
 */
export const DECIDE_ERROR_COPY: ErrorCopy = {
  // Only a client on Matched can hold a contact: one in the Recycle bin
  // gives it up (`xeroMatch.decide`).
  CONTACT_TAKEN:
    'Could not match them: that Xero contact is already matched to another client. If that one is wrong, unlink it under Matched first; if not, check Xero again to look for another contact.',
  NOT_FOUND:
    'Could not save: this one has changed since the page opened. Reload this page and look again.',
  NO_ACCESS:
    'Could not save: only whoever connected this Xero can match its clients.',
  SWITCHED:
    'Could not save: switch back to your own account first, then try again.',
  offline:
    'Could not save: this device is offline. Nothing was changed — try again when you have signal.',
  default: 'Could not save. Check your signal and try again.',
}

/** Match again on a Different client (`xeroMatch.reopen`). Fails fast with
 * no signal, like the answers it takes back. */
export const REOPEN_ERROR_COPY: ErrorCopy = {
  NOT_FOUND:
    'Could not match them again: this one has changed since the page opened. Reload this page and look again.',
  NO_ACCESS:
    'Could not match them again: only whoever connected this Xero can change its matches.',
  SWITCHED:
    'Could not match them again: switch back to your own account first, then try again.',
  offline:
    'Could not match them again: this device is offline. Nothing was changed — try again when you have signal.',
  default:
    'Could not match them again. Nothing was changed — check your signal and try again.',
}

/** Unlink on a matched client (`xeroMatch.unlink`), in its confirm. */
export const UNLINK_ERROR_COPY: ErrorCopy = {
  NOT_FOUND:
    'Could not unlink: they’re no longer matched. Close this and look again.',
  NO_ACCESS:
    'Could not unlink: only whoever connected this Xero can change its matches.',
  SWITCHED:
    'Could not unlink: switch back to your own account first, then try again.',
  offline:
    'Could not unlink: this device is offline. They’re still matched — try again when you have signal.',
  default:
    'Could not unlink. They’re still matched — check your signal and try again.',
}

/** The match page's lists (`xeroMatch.reviewPage`'s `filter`). */
export type MatchFilter = 'review' | 'matched' | 'new' | 'separate'

/**
 * Each list as the match page names it: its chip, the line under the chips
 * saying what the list is, and what it says when there is nothing in it.
 */
export const MATCH_FILTER_COPY: Readonly<
  Record<
    MatchFilter,
    { label: string; lede: string; emptyTitle: string; emptyBody: string }
  >
> = {
  review: {
    label: 'To check',
    lede: 'PestM8 isn’t sure these are the same client. Say which they are.',
    emptyTitle: 'Nothing to check',
    emptyBody: 'Every client is matched, or new to Xero.',
  },
  matched: {
    label: 'Matched',
    lede: 'Already in Xero. PestM8 will keep each one in step with its contact there.',
    emptyTitle: 'Nothing matched yet',
    emptyBody:
      'Clients PestM8 finds in Xero, and the ones you match, are listed here.',
  },
  new: {
    label: 'New to Xero',
    lede: 'Not in Xero yet. PestM8 will add them as new contacts.',
    emptyTitle: 'Nothing new to Xero',
    emptyBody: 'Clients with nothing like them in Xero are listed here.',
  },
  separate: {
    label: 'Different',
    lede: 'You said these aren’t the contact PestM8 suggested, or unlinked them. PestM8 will add them as new contacts. Match again puts one back to check.',
    emptyTitle: 'Nothing marked different',
    emptyBody:
      'Clients you say aren’t the contact PestM8 suggested are listed here.',
  },
}
