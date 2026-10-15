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
