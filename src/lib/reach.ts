import { useLayoutEffect, useSyncExternalStore } from 'react'

/**
 * Whether the app can reach PestM8 — the rule components/shell/
 * ConnectionNotice.tsx follows, kept here without React so its timings can be
 * tested.
 *
 * Every wait on the server is silent otherwise. A placeholder, "Loading the
 * team…", a save button left on "Saving…": each looks like PestM8 is slow,
 * and none of them ever gives up (16 Oct 2026, a technician whose phone could
 * not reach the server for minutes: "Just keeps saying loading and can't do
 * anything"). So once the app has waited too long on any one of these, it
 * says so:
 *
 * - The socket is down: closed, still connecting, or stopped while it fetches
 *   a fresh sign-in token. Convex reconnects by itself; this is how long that
 *   is given before anyone is told.
 * - A save has been sent and not answered. The Convex client holds it until
 *   the socket is back, with no limit.
 * - Something on screen asked for data and has had nothing. That covers a
 *   socket that looks open but isn't answering: held for its token, or a
 *   connection a VPN dropped without either end hearing. Longer than the
 *   others, because a big list on one bar can take a while and still come.
 *   An answer from the copy kept on the phone counts as nothing yet, until
 *   the server has confirmed it on this line (`waitingOnScreen`).
 *
 * Clocks only run while the page is on screen, and start again when it comes
 * back: a phone waking from sleep has a dead socket for a moment, which is
 * not news. A gap in the samples counts as coming back too, since a phone can
 * freeze the page without saying it was hidden.
 */

/** The socket may be down this long before the notice shows. */
export const SOCKET_DOWN_MS = 8_000
/** A save may wait this long for its answer. */
export const REQUEST_WAIT_MS = 10_000
/** Something on screen may wait this long for its first data. */
export const QUERY_WAIT_MS = 12_000
/** Samples further apart than this mean the page was frozen in between. */
export const GAP_MS = 5_000

/** What ConnectionNotice reads, about once a second. Times are epoch ms. */
export type ReachSample = {
  now: number
  visible: boolean
  socketConnected: boolean
  /** When the oldest save still waiting for its answer was sent. */
  oldestRequestAt: number | null
  /** When the longest-waiting query on screen with no data was first seen. */
  oldestPendingQueryAt: number | null
}

export type ReachState = {
  /** When this spell of the page being on screen began. */
  visibleSince: number | null
  /** When the socket was first seen down, this spell. */
  socketDownSince: number | null
  /** When the last sample was taken. */
  lastAt: number | null
}

export const REACH_START: ReachState = {
  visibleSince: null,
  socketDownSince: null,
  lastAt: null,
}

/** Which wait went on too long, first match: the socket, a save, or a query. */
export type ReachWhy = 'socket' | 'save' | 'query'

/**
 * Folds one sample in: the state to keep, whether PestM8 is out of reach,
 * and which wait says so (for the phone's connection notes,
 * lib/connectionLog.ts).
 */
export function sampleReach(
  previous: ReachState,
  sample: ReachSample,
): { state: ReachState; stuck: boolean; why: ReachWhy | null } {
  if (!sample.visible) return { state: REACH_START, stuck: false, why: null }
  const state =
    previous.lastAt !== null && sample.now - previous.lastAt > GAP_MS
      ? REACH_START
      : previous
  const visibleSince = state.visibleSince ?? sample.now
  const socketDownSince = sample.socketConnected
    ? null
    : (state.socketDownSince ?? sample.now)
  const waited = (since: number | null, ms: number) =>
    since !== null && sample.now - Math.max(since, visibleSince) >= ms
  const why: ReachWhy | null = waited(socketDownSince, SOCKET_DOWN_MS)
    ? 'socket'
    : waited(sample.oldestRequestAt, REQUEST_WAIT_MS)
      ? 'save'
      : waited(sample.oldestPendingQueryAt, QUERY_WAIT_MS)
        ? 'query'
        : null
  return {
    state: { visibleSince, socketDownSince, lastAt: sample.now },
    stuck: why !== null,
    why,
  }
}

/**
 * When the longest-waiting of `pending` (queries on screen with no data, by
 * hash) was first seen, keeping `firstSeen` up to date: new ones from `now`,
 * and ones no longer pending forgotten.
 */
export function oldestPending(
  firstSeen: Map<string, number>,
  pending: Iterable<string>,
  now: number,
): number | null {
  const still = new Set(pending)
  for (const hash of firstSeen.keys()) {
    if (!still.has(hash)) firstSeen.delete(hash)
  }
  let oldest: number | null = null
  for (const hash of still) {
    const since = firstSeen.get(hash) ?? now
    firstSeen.set(hash, since)
    if (oldest === null || since < oldest) oldest = since
  }
  return oldest
}

/**
 * Everything on screen still waiting on the server, by hash, for
 * `oldestPending`: queries asked for that have had no answer, and answers
 * from the copy kept on the phone the server hasn't confirmed on this line
 * (`keeper.keptWaiting`, lib/offline/keeper.ts). Without the second, a page
 * drawn from the phone's copy over a socket that looks open but never
 * answers would never be noticed. A query the copy answered while it waited
 * is the same hash in both, so its wait goes on from when it began.
 */
export function waitingOnScreen(
  pending: Iterable<string>,
  keptWaiting: Iterable<string>,
): Array<string> {
  return [...new Set([...pending, ...keptWaiting])]
}

/**
 * Whether a change is waiting to save in this page's memory, which a reload
 * loses: the Convex client's mutations in flight, less those the outbox has
 * out (lib/outbox/sender.ts `inflight`). Those are bookings kept on the
 * phone's storage first, which survive a reload and are settled after it,
 * so "A change you made is waiting to save", and Reload's second tap, are
 * never for them. Each of the outbox's calls is counted by the Convex client
 * for exactly as long as its promise is out, so the two never disagree.
 */
export function savesWaiting(
  inflightMutations: number,
  outboxInflight: number,
): boolean {
  return inflightMutations - outboxInflight > 0
}

/**
 * When saves were first seen waiting (`savesWaiting`), as ConnectionNotice
 * times them while an action is out too: kept while they wait, from now as
 * they start, and null once none do.
 */
export function savesWaitingSince(
  since: number | null,
  waiting: boolean,
  now: number,
): number | null {
  return waiting ? (since ?? now) : null
}

/** What the notice says and offers, while it is up. */
export type ReachNoticeModel = {
  online: boolean
  waitingToSave: boolean
  /**
   * The person's bookings kept on the phone and not sent yet for the
   * business on screen, waiting or unanswered (lib/outbox/sender.ts
   * `notice`), and whether they wait on the person being back in their own
   * account. Null or absent with none.
   */
  outbox?: { count: number; held: 'switched' | null } | null
  /** When what is on screen was last known right ("9:42am"), when the
   * phone's copy says (`keeper.screenAsOf`); otherwise null, and the notice
   * says it may be out of date. */
  updated: string | null
  /** Try again, its "Trying…", Reload once trying hasn't helped, and the
   * second tap Reload asks for while a change is waiting to save. */
  action: 'try' | 'trying' | 'reload' | 'reload-confirm'
  onTry: () => void
  onReload: () => void
  onDismiss: () => void
}

/**
 * The notice as it shows where a line saying the screen is the copy kept on
 * the phone, because the line is down, may be showing too
 * (lib/offline/keptOnScreen.ts): left out while one is (`kept`), which says
 * the same thing just under it. Never while a change is waiting to save,
 * though: only the notice says that, and that a reload loses it. So it
 * gives way only when all it waits on is reads.
 */
export function noticeOverKept(
  notice: ReachNoticeModel | null,
  kept: boolean,
): ReachNoticeModel | null {
  return notice !== null && kept && !notice.waitingToSave ? null : notice
}

// The notice as ConnectionNotice last decided it, for the places that show
// it too or give way to it: an open sheet, which covers the notice, draws its
// own copy (primitives/Sheet.tsx), and the new-version banner, in the same
// place on screen, waits (ServiceWorker.tsx). It is published as decided,
// whether or not the page's note holds the banner back (`noticeOverKept`):
// a sheet has its own rule for that, and a reload still needs PestM8.
let current: ReachNoticeModel | null = null
const listeners = new Set<() => void>()

export function publishReachNotice(next: ReachNoticeModel | null): void {
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

export function useReachNotice(): ReachNoticeModel | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => current,
    () => null,
  )
}

/**
 * When the clock that turns Try again into Reload began (ConnectionNotice):
 * kept while it runs (`running`: the notice up with signal, and drawn
 * somewhere), now as it starts, and null otherwise. So a notice back from a
 * spell with no signal offers Try again first, and so does one a kept line
 * held back (lib/offline/keptOnScreen.ts) as it first shows: the wait before
 * Reload is for someone who has had Try again in front of them.
 */
export function reloadClockSince(
  since: number | null,
  running: boolean,
  now: number,
): number | null {
  if (!running) return null
  return since ?? now
}

// How many places draw the notice now: the page's banner, and an open
// sheet's line (`useDrawsNotice`). ConnectionNotice runs the clock above only
// while one does (`useNoticeDrawn`): while every one gives way to a kept line,
// nobody can see it.
let drawing = 0
const drawnListeners = new Set<() => void>()

function notifyDrawn(): void {
  for (const listener of [...drawnListeners]) listener()
}

/** Whether the notice is drawn anywhere now (`drawNotice`). */
export function noticeDrawn(): boolean {
  return drawing > 0
}

/** Calls `listener` whenever `noticeDrawn` may say otherwise. */
export function subscribeNoticeDrawn(listener: () => void): () => void {
  drawnListeners.add(listener)
  return () => {
    drawnListeners.delete(listener)
  }
}

/**
 * Says the notice is drawn in one more place, until the function it returns
 * is called (once counts, however often it is).
 */
export function drawNotice(): () => void {
  drawing++
  if (drawing === 1) notifyDrawn()
  let drawn = true
  return () => {
    if (!drawn) return
    drawn = false
    drawing--
    if (drawing === 0) notifyDrawn()
  }
}

/** Says the notice is drawn where this is, while `on`. */
export function useDrawsNotice(on: boolean): void {
  useLayoutEffect(() => (on ? drawNotice() : undefined), [on])
}

/**
 * Whether the notice is drawn anywhere (`noticeDrawn`): false on the server
 * and while hydrating, when nothing draws it.
 */
export function useNoticeDrawn(): boolean {
  return useSyncExternalStore(subscribeNoticeDrawn, noticeDrawn, () => false)
}
