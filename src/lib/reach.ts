import { useSyncExternalStore } from 'react'

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
 *
 * Clocks only run while the page is on screen, and start again when it comes
 * back: a phone waking from sleep has a dead socket for a moment, which is
 * not news.
 */

/** The socket may be down this long before the notice shows. */
export const SOCKET_DOWN_MS = 8_000
/** A save may wait this long for its answer. */
export const REQUEST_WAIT_MS = 10_000
/** Something on screen may wait this long for its first data. */
export const QUERY_WAIT_MS = 12_000

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
}

export const REACH_START: ReachState = {
  visibleSince: null,
  socketDownSince: null,
}

/** Folds one sample in: the state to keep, and whether PestM8 is out of reach. */
export function sampleReach(
  state: ReachState,
  sample: ReachSample,
): { state: ReachState; stuck: boolean } {
  if (!sample.visible) return { state: REACH_START, stuck: false }
  const visibleSince = state.visibleSince ?? sample.now
  const socketDownSince = sample.socketConnected
    ? null
    : (state.socketDownSince ?? sample.now)
  const waited = (since: number | null, ms: number) =>
    since !== null && sample.now - Math.max(since, visibleSince) >= ms
  return {
    state: { visibleSince, socketDownSince },
    stuck:
      waited(socketDownSince, SOCKET_DOWN_MS) ||
      waited(sample.oldestRequestAt, REQUEST_WAIT_MS) ||
      waited(sample.oldestPendingQueryAt, QUERY_WAIT_MS),
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

// Whether the notice is up, for the new-version banner (ServiceWorker.tsx),
// which sits in the same place and gives way while it is.
let showing = false
const listeners = new Set<() => void>()

export function setReachNoticeShowing(next: boolean): void {
  if (next === showing) return
  showing = next
  for (const listener of listeners) listener()
}

export function useReachNoticeShowing(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => showing,
    () => false,
  )
}
