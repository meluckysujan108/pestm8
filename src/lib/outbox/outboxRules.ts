import { ConvexError } from 'convex/values'
import { UNAUTHENTICATED } from '#/lib/signInSettling'
import { MFA_ENROLMENT_REQUIRED } from '#/lib/twoStep'
import {
  ACCESS_HOLD_MS,
  FIRST_VISIT_GONE_MS,
  FIRST_VISIT_MEANT_MS,
  PAUSED_HOLD_MS,
  SERVER_RETRY_MS,
  SIGNED_OUT_HOLD_MS,
  SWITCHED_HOLD_MS,
  isReadable,
  isStale,
} from './outboxSet'
import type { OutboxItem, OutboxState } from './outboxItem'

/**
 * The outbox's rules, pure, so the sender and the screens that show an item
 * make the same decisions, and their tests can say what each one is: what
 * a server's answer means for an item, which item goes next, when one that
 * waited too long or whose first visit has gone needs a look, how long a
 * refusal holds it, and what it is called on screen.
 */

// ── What an answer means ───────────────────────────────────────────────────

/**
 * What the phone knows of the person's access to the item's business when
 * an answer comes: `access:me` live and theirs; refused NO_ACCESS for the
 * socket's person, who is the item's (removed from the business); or
 * neither, not yet known.
 */
export type AccessNow = 'live' | 'removed' | 'unknown'

export type AnswerContext = {
  /** The answer came on the connection its call went on. */
  sameConnection: boolean
  access: AccessNow
}

/**
 * The kinds of answer. Holds: SIGNED_OUT (`Unauthenticated`), TWO_STEP
 * (two-step sign-in not set up), SWITCHED (in someone else's account),
 * PAUSED (the server's kill switch), ACCESS (NO_ACCESS while it can't be
 * told why). Needs a look: ASSIGNEE, SITE_GONE, FIELD. And NEW_ID (the
 * request id itself refused), REMOVED (out of the business), SERVER (not a
 * refusal at all), UNSETTLED (heard across a reconnect, so it may follow a
 * commit nobody heard).
 */
export type AnswerClass =
  | 'SIGNED_OUT'
  | 'TWO_STEP'
  | 'SWITCHED'
  | 'PAUSED'
  | 'ACCESS'
  | 'NEW_ID'
  | 'REMOVED'
  | 'ASSIGNEE'
  | 'SITE_GONE'
  | 'FIELD'
  | 'SERVER'
  | 'UNSETTLED'

/** What becomes of the item. */
export type AnswerThen =
  'hold' | 'newRequestId' | 'wipe' | 'needsLook' | 'backoff' | 'settle'

export type Classified = {
  cls: AnswerClass
  then: AnswerThen
  /** The server's code; null for an error that isn't a refusal. */
  code: string | null
  /** Convex's id for the request, for the note it leaves. */
  requestId?: string
}

/**
 * The refusal's code: a ConvexError's data. Nothing else is read. On prod,
 * every other error, an ArgumentValidationError included, reaches the phone
 * as a bare "Server Error", so no message is ever matched.
 */
export function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const data = (error as { data?: unknown }).data
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null) {
    const code = (data as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return error instanceof ConvexError ? 'CONVEX_ERROR' : null
}

/** The `[Request ID: …]` Convex puts in a failed call's message. */
export function requestIdOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return undefined
  return /\[Request ID: ([^\]\s]+)\]/.exec(message)?.[1]
}

const ASSIGNEE_CODES: ReadonlySet<string> = new Set([
  'INVALID_ASSIGNEE',
  'TOO_MANY_PEOPLE',
])
const SITE_GONE_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'MISSING_PROPERTY',
])

/**
 * What a refused or failed send means, by its code alone. An answer heard on
 * another connection than its call went on says nothing for sure: the Convex
 * client sends a call again on every new socket, so an error then may follow
 * a commit the phone never heard, and the item is settled by asking the
 * server (`clientRequests.find`) instead.
 */
export function classify(error: unknown, ctx: AnswerContext): Classified {
  const code = codeOf(error)
  const requestId = requestIdOf(error)
  const answer = (cls: AnswerClass, then: AnswerThen): Classified => ({
    cls,
    then,
    code,
    ...(requestId !== undefined && { requestId }),
  })
  if (!ctx.sameConnection) return answer('UNSETTLED', 'settle')
  if (code === null) return answer('SERVER', 'backoff')
  if (code === UNAUTHENTICATED) return answer('SIGNED_OUT', 'hold')
  if (code === MFA_ENROLMENT_REQUIRED) return answer('TWO_STEP', 'hold')
  if (code === 'NOT_OWN_ACCOUNT' || code.startsWith('SWITCH_')) {
    return answer('SWITCHED', 'hold')
  }
  if (code === 'OUTBOX_PAUSED') return answer('PAUSED', 'hold')
  if (code === 'INVALID_REQUEST_ID') return answer('NEW_ID', 'newRequestId')
  if (code === 'NO_ACCESS') {
    if (ctx.access === 'live') return answer('ASSIGNEE', 'needsLook')
    if (ctx.access === 'removed') return answer('REMOVED', 'wipe')
    return answer('ACCESS', 'hold')
  }
  if (ASSIGNEE_CODES.has(code)) return answer('ASSIGNEE', 'needsLook')
  if (SITE_GONE_CODES.has(code)) return answer('SITE_GONE', 'needsLook')
  // INVALID_PHONE, INVALID_EMAIL, INVALID_ABN, INVALID_WORK_ORDER,
  // NOTES_TOO_LONG, INVALID_INTERVAL, TAG_*, FIRST_VISIT_PAST and anything
  // else the server refuses: the booking itself needs changing.
  return answer('FIELD', 'needsLook')
}

// ── Holds and backoff ──────────────────────────────────────────────────────

/** The answers that hold an item a while rather than change it. */
export type HoldClass = 'SIGNED_OUT' | 'SWITCHED' | 'PAUSED' | 'ACCESS'

/** The step for the `inARow`th (1-based) in a row; the last repeats. */
function stepOf(steps: ReadonlyArray<number>, inARow: number): number {
  return steps[Math.min(Math.max(inARow, 1), steps.length) - 1]
}

/**
 * Until when an answer holds the item. `inARow`: how many of that kind in a
 * row, this one included, this page load.
 */
export function holdUntil(cls: HoldClass, inARow: number, now: number): number {
  switch (cls) {
    case 'SIGNED_OUT':
      return now + stepOf(SIGNED_OUT_HOLD_MS, inARow)
    case 'SWITCHED':
      return now + stepOf(SWITCHED_HOLD_MS, inARow)
    case 'PAUSED':
      return now + PAUSED_HOLD_MS
    case 'ACCESS':
      return now + ACCESS_HOLD_MS
  }
}

/**
 * When an item goes again after a server error that wasn't a refusal, the
 * `serverFailures`th in a row: 1, 5 and 15 minutes after the attempt. Null
 * once those three tries have failed too: it needs a look, with Try again.
 */
export function retryAt(
  serverFailures: number,
  lastAttemptAt: number,
): number | null {
  const wait = SERVER_RETRY_MS[serverFailures - 1] as number | undefined
  return wait === undefined ? null : lastAttemptAt + wait
}

// ── Before a send ──────────────────────────────────────────────────────────

/**
 * Whether a Recurring Job's first visit was meant to be booked: it was saved
 * no more than a day after its start. One started further back than that is
 * booked as online books it, from its next visit on (recurrences.create).
 */
export function firstVisitMeant(
  item: Pick<OutboxItem, 'booking' | 'createdAt'>,
): boolean {
  return (
    item.booking.repeat !== null &&
    item.booking.scheduledAt >= item.createdAt - FIRST_VISIT_MEANT_MS
  )
}

/**
 * Whether a Recurring Job's first visit, meant to be booked, has gone by
 * while it waited: then it needs a look ("Change the date") rather than a
 * series booked without it. The server holds to the same with
 * `refuseBackfill`; this says so with no signal.
 */
export function firstVisitPast(
  item: Pick<OutboxItem, 'booking' | 'createdAt'>,
  now: number,
): boolean {
  return (
    firstVisitMeant(item) &&
    item.booking.scheduledAt < now - FIRST_VISIT_GONE_MS
  )
}

/** Waited too long (outboxSet.ts, where the store can reach it too). */
export { isStale }

/** What the phone itself says needs a look before a send, if anything. */
export function preSendProblem(
  item: OutboxItem,
  now: number,
): 'STALE' | 'FIRST_VISIT_PAST' | null {
  if (isStale(item, now)) return 'STALE'
  if (firstVisitPast(item, now)) return 'FIRST_VISIT_PAST'
  return null
}

// ── Which goes next ────────────────────────────────────────────────────────

export type SendContext = {
  now: number
  /** The Edits open in this tab, which it never sends whatever the lease. */
  editingHere: ReadonlySet<string>
}

/**
 * Why an item can't go now, by what it says itself: a newer build's; needs
 * a look or sent; being edited here or (lease not run out) in another tab;
 * backing off or held; or waiting on the item that makes its site. The gates
 * on who is signed in, the business and the line are the sender's.
 */
export type SkipReason =
  'foreign' | 'state' | 'editing' | 'retry' | 'hold' | 'parent'

export function skipReason(
  item: OutboxItem,
  all: ReadonlyArray<OutboxItem>,
  ctx: SendContext,
): SkipReason | null {
  if (!isReadable(item)) return 'foreign'
  if (item.state !== 'waiting' && item.state !== 'sending') return 'state'
  if (ctx.editingHere.has(item.localId)) return 'editing'
  if (item.editing !== null && item.editing.until > ctx.now) return 'editing'
  if (item.retryAt !== null && item.retryAt > ctx.now) return 'retry'
  if (item.holdUntil !== null && item.holdUntil > ctx.now) return 'hold'
  if (item.dependsOn !== undefined) {
    // Gone altogether, it is the send's to say so (its site can't be
    // found); here, it waits only on one still to go.
    const parent = all.find((other) => other.localId === item.dependsOn)
    if (parent && parent.state !== 'sent') return 'parent'
  }
  return null
}

/**
 * The items that may go now, oldest first. One that can't blocks only the
 * bookings made after it on it, never another.
 */
export function sendable(
  items: ReadonlyArray<OutboxItem>,
  ctx: SendContext,
): Array<OutboxItem> {
  return items
    .filter((item) => skipReason(item, items, ctx) === null)
    .sort(
      (a, b) => a.createdAt - b.createdAt || (a.localId < b.localId ? -1 : 1),
    )
}

/** The item that goes next, if any. */
export function nextSendable(
  items: ReadonlyArray<OutboxItem>,
  ctx: SendContext,
): OutboxItem | null {
  return sendable(items, ctx)[0] ?? null
}

// ── On screen ──────────────────────────────────────────────────────────────

/**
 * The chip a card wears in the job number's place. Every `sending` item is
 * "Sending…", whichever tab or page load sent it: one that may already be
 * booked must never read as not sent. Held or not, a waiting one is "Not
 * sent yet"; its sheet says why.
 */
export type OutboxChip = 'waiting' | 'sending' | 'needsLook' | 'sent'

export const CHIP_WORDS: Record<OutboxChip, string> = {
  waiting: 'Not sent yet',
  sending: 'Sending…',
  needsLook: 'Needs a look',
  sent: 'Sent',
}

export function chipFor(item: { state: OutboxState }): OutboxChip {
  return item.state === 'sending' ||
    item.state === 'needsLook' ||
    item.state === 'sent'
    ? item.state
    : 'waiting'
}

/** "1 job", "2 jobs". */
export function jobsWord(n: number): string {
  return n === 1 ? '1 job' : `${n} jobs`
}

/** What a day's group of items holds, for its heading. */
export type OutboxCounts = {
  /** Waiting or needing a look: what might be booked again by mistake. */
  unsent: number
  /** Sent with no answer yet: never counted as unsent. */
  sending: number
  /** Sent, still in their slots until the next redraw. */
  sent: number
}

export function countsOf(items: ReadonlyArray<{ state: OutboxState }>) {
  const counts: OutboxCounts = { unsent: 0, sending: 0, sent: 0 }
  for (const item of items) {
    if (item.state === 'sending') counts.sending++
    else if (item.state === 'sent') counts.sent++
    else counts.unsent++
  }
  return counts
}

/**
 * The group's heading: "2 jobs not sent yet", "2 jobs not sent yet, 1
 * sending", "1 job sending", or "Sent" once every slot still drawn has gone.
 * Null with nothing in it.
 */
export function outboxHeading(counts: OutboxCounts): string | null {
  if (counts.unsent > 0 && counts.sending > 0) {
    return `${jobsWord(counts.unsent)} not sent yet, ${counts.sending} sending`
  }
  if (counts.unsent > 0) return `${jobsWord(counts.unsent)} not sent yet`
  if (counts.sending > 0) return `${jobsWord(counts.sending)} sending`
  if (counts.sent > 0) return 'Sent'
  return null
}

/**
 * The sign-in screens' line, when the phone holds someone's jobs not sent
 * yet: whose they are, and that signing in as anyone else discards them.
 * `firstName` is the owner row's ('' when their sign-in didn't say).
 */
export function onPhoneWords(firstName: string, count: number): string {
  const name = firstName.trim()
  if (name === '') {
    return count === 1
      ? 'A job not sent yet is on this phone. It goes when the person who booked it signs in again. Signing in as anyone else discards it.'
      : 'Jobs not sent yet are on this phone. They go when the person who booked them signs in again. Signing in as anyone else discards them.'
  }
  return count === 1
    ? `${name} has 1 job on this phone not sent yet. It goes when ${name} signs in again. Signing in as anyone else discards it.`
    : `${name} has ${count} jobs on this phone not sent yet. They go when ${name} signs in again. Signing in as anyone else discards them.`
}
