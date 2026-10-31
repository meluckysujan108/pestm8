/**
 * The outbox's constants: the switch, the item's version and the timings.
 *
 * The outbox keeps a booking made in New Job on the phone, in its own
 * IndexedDB database (outboxStore.ts), and sends it while PestM8 is open with
 * signal. Nothing writes an item yet: the store, its clears and its rules
 * come first, so a phone is cleared properly before it can ever hold one.
 *
 * Imports nothing, so rootState.ts can reach outboxStore.ts, and through it
 * this, without bringing anything else into the root route.
 */

/**
 * The switch for keeping new bookings: off, New Job sends straight to the
 * server as it always has. Items already on a phone are still shown and sent
 * with it off, since each carries its own request id; stopping sends is the
 * server's `OUTBOX_PAUSED=on` (convex/lib/outboxGuards.ts).
 *
 * Off everywhere until the outbox is switched on for good, which then reads
 * `!== 'off'`: on only in a build made with `VITE_PESTM8_OUTBOX=on`.
 */
export const OUTBOX_ENABLED = import.meta.env.VITE_PESTM8_OUTBOX === 'on'

/**
 * The version of the whole item: its kinds, its fields and its booking.
 * Bumped in two releases, reader first, so a release rolled back by one
 * still reads and sends everything a phone holds. A build reads an item in
 * full only when `v <= OUTBOX_V` and it knows the item's `kind`; any other
 * item is a newer build's, shown from its envelope and never sent or changed.
 * outboxShape.test.ts holds the shape this number stands for.
 */
export const OUTBOX_V = 1

/** The kinds of item this build reads in full. */
export const OUTBOX_KINDS = ['job', 'series'] as const

export type OutboxKind = (typeof OUTBOX_KINDS)[number]

const KINDS: ReadonlySet<string> = new Set(OUTBOX_KINDS)

/**
 * Whether this build reads an item in full, from its envelope alone (the
 * fields every build names the same). Any other item is a newer build's:
 * shown as one, discarded if the person asks, never sent or changed.
 */
export function isReadable(item: { v: number; kind: string }): boolean {
  return item.v <= OUTBOX_V && KINDS.has(item.kind)
}

/**
 * How long one store operation may take before it counts as failed
 * (`'error'`). WebKit's IndexedDB can leave a request unanswered for good.
 * A transaction given up on may still land later, which every guarded change
 * makes harmless.
 */
export const STORE_OP_MS = 3_000

/** How long the page load's read of the outbox may take. */
export const PEEK_TIMEOUT_MS = 3_000

/**
 * After a read that failed, when it is tried again: then only when the page
 * wakes (comes back on screen, or the line comes up). A failure is never
 * kept as the answer.
 */
export const PEEK_RETRY_MS = [1_000, 5_000, 15_000] as const

/** At Book, how long storing the booking may take before New Job sends it
 * straight to the server instead. */
export const KEEP_WAIT_MS = 1_500

/** At Book on a live line, how long the sheet waits for the server's answer
 * before it closes with the booking kept. */
export const ANSWER_WAIT_MS = 4_000

/**
 * How long after an attempt an unanswered item may be settled, by asking the
 * server whether it made something: a page just closed may still have the
 * call on its way.
 */
export const SETTLE_MIN_AGE_MS = 30_000

/** How long the server is given to say whether an attempt made something. */
export const FIND_WAIT_MS = 10_000

/** How long an Edit holds an item against other tabs, renewed each minute. */
export const EDIT_LEASE_MS = 10 * 60_000
export const EDIT_RENEW_MS = 60_000

/**
 * An item the phone could not send for this long (it never got online) is
 * never sent by itself: it needs a look, with Send and Discard. The owner,
 * 27 Oct 2026: bookings go as soon as there is signal, and only one stuck
 * for a few days waits to be asked about.
 */
export const STALE_AFTER_MS = 3 * 86_400_000

/**
 * A session end marked on an item (`sessionEndedAt`) that the person hasn't
 * answered since. A Send counts only for what was known when it was given:
 * a session that ends after it needs another.
 */
export function sessionEndUnanswered(item: {
  sessionEndedAt: number | null
  confirmedAt: number | null
}): boolean {
  return (
    item.sessionEndedAt !== null &&
    !(item.confirmedAt !== null && item.confirmedAt > item.sessionEndedAt)
  )
}

/**
 * Whether an item has waited too long to go by itself: three days unsent
 * (the phone never got online), or its session ended on the server. It then
 * needs a look, with Send and Discard. The person's Send answers for both as
 * they stood then: three more days unsent, or a session that ends after it,
 * and it needs a look again. Here rather than in outboxRules.ts, which
 * re-exports it, so outboxStore.ts can hold to it too.
 */
export function isStale(
  item: {
    createdAt: number
    sessionEndedAt: number | null
    confirmedAt: number | null
  },
  now: number,
): boolean {
  return (
    sessionEndUnanswered(item) ||
    Math.max(item.createdAt, item.confirmedAt ?? 0) < now - STALE_AFTER_MS
  )
}

/**
 * A Recurring Job's first visit was meant to be booked when the series was
 * saved no more than this long after its start (`firstVisitMeant`)…
 */
export const FIRST_VISIT_MEANT_MS = 24 * 3_600_000
/**
 * …and has gone by once its start is this far back: an hour inside the
 * server's own day (convex/lib/recurrence.ts `isBackfill`), so the phone says
 * so before the server would refuse it.
 */
export const FIRST_VISIT_GONE_MS = 23 * 3_600_000

/** After a server error that isn't a refusal: 1, 5 and 15 minutes, then the
 * item needs a look. */
export const SERVER_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

/** After `Unauthenticated`, for each in a row this page load; the last
 * repeats. */
export const SIGNED_OUT_HOLD_MS = [
  5_000,
  30_000,
  2 * 60_000,
  5 * 60_000,
] as const

/** After a refusal for being in someone else's account; the last repeats. */
export const SWITCHED_HOLD_MS = [30_000, 2 * 60_000, 5 * 60_000] as const

/** After the server's kill switch (`OUTBOX_PAUSED`). */
export const PAUSED_HOLD_MS = 15 * 60_000

/** After NO_ACCESS while it can't yet be told whether the person was removed. */
export const ACCESS_HOLD_MS = 30_000

/** A sent item is deleted this long after it went, if nothing deleted it
 * sooner. */
export const SENT_KEEP_MS = 10 * 60_000

/** How often the sender looks again while anything is waiting. */
export const OUTBOX_TICK_MS = 30_000

/**
 * After this many `Unauthenticated` answers in a row on a live line, the
 * sender asks whether the person is signed in at all (`signedOutAfterAll`):
 * a session revoked on the server answers nothing else, ever.
 */
export const SIGNED_OUT_CHECK_AFTER = 3

/**
 * An account switch starting waits at most this long for a send another
 * tab already has out to finish (switchGate.ts). Past it the switch goes
 * ahead, and a send that then lands is refused by the server
 * (`NOT_OWN_ACCOUNT`), so nothing is booked as someone else either way.
 */
export const SWITCH_WAIT_MS = 5_000

/**
 * A booking the phone kept this long before the person was last removed
 * from the business is from their earlier stint there (`access.me`'s
 * `lastRemovedAt`), and goes as the removal would have taken it, had the
 * phone heard of it. A rejoin makes the same membership active again, so
 * nothing else on the phone tells the two stints apart. The time is the
 * server's and `createdAt` the phone's: the margin is for a phone clock
 * running a little slow, and errs towards keeping a booking, which can be
 * cancelled, over discarding one nobody can type in again.
 */
export const EARLIER_STINT_MARGIN_MS = 5 * 60_000
