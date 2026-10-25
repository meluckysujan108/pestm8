import { useSyncExternalStore } from 'react'
import type { ConvexReactClient } from 'convex/react'
import { isOffline } from '#/lib/online'
import { GAP_MS, SOCKET_DOWN_MS } from '#/lib/reach'

/**
 * Whether the line to PestM8 is down, for the caption above a save that
 * waits for signal rather than failing: Book job, Save client, Add property.
 * Convex holds such a save until its socket is back (ARCHITECTURE.md §5.5),
 * and the caption says so, so a "Booking…" that sits there isn't taken for
 * a hang. The business switcher reads it too.
 *
 * Down is either of:
 * - `no-signal`: the phone says it has no network (`isOffline()`);
 * - `unreachable`: the phone says it has one, but the Convex socket has not
 *   been connected for SOCKET_DOWN_MS (8 s) while the page was on screen —
 *   the same wait ConnectionNotice gives it (lib/reach.ts). Off screen a
 *   phone drops its socket as a matter of course, so the clock starts again
 *   when the page comes back, and again after the page was frozen (a timer
 *   that fires more than GAP_MS late).
 *
 * The socket is watched from the start of the page load (`watchLineDown`,
 * from root-provider.tsx), so a socket that died before New Job opened has
 * had its time counted. Unwatched (the UI harness, tests), only the first
 * half counts.
 *
 * The keeper of the kept copy (lib/offline/keeper.ts, still to come) takes
 * this over with its own `lineDown()`, which also knows a socket paused for
 * a sign-in token; what this answers, and who reads it, stay as they are.
 */
export type LineDown = 'no-signal' | 'unreachable'

/**
 * When the socket's spell down began, as far as it counts: null while it is
 * connected or the page is hidden, and otherwise from the first moment it
 * was seen down on screen.
 */
export function nextDownSince(
  downSince: number | null,
  at: { now: number; visible: boolean; connected: boolean },
): number | null {
  if (at.connected || !at.visible) return null
  return downSince ?? at.now
}

/** The line as it stands at `now`, from what `nextDownSince` kept. */
export function lineDownAt(
  offline: boolean,
  downSince: number | null,
  now: number,
): LineDown | null {
  if (offline) return 'no-signal'
  return downSince !== null && now - downSince >= SOCKET_DOWN_MS
    ? 'unreachable'
    : null
}

let downSince: number | null = null
let unreachable = false
let stopWatching: (() => void) | undefined
const listeners = new Set<() => void>()

/**
 * Watches `client`'s socket until the function returned is called. A second
 * call stops the first: one page load has one client.
 */
export function watchLineDown(client: ConvexReactClient): () => void {
  stopWatching?.()
  let connected = client.connectionState().isWebSocketConnected
  let timer: ReturnType<typeof setTimeout> | undefined

  const update = (frozen: boolean) => {
    clearTimeout(timer)
    timer = undefined
    const now = Date.now()
    downSince = nextDownSince(frozen ? null : downSince, {
      now,
      visible: document.visibilityState === 'visible',
      connected,
    })
    const down = lineDownAt(false, downSince, now) === 'unreachable'
    if (downSince !== null && !down) {
      // The moment it would count, unless something changes first.
      const due = downSince + SOCKET_DOWN_MS
      timer = setTimeout(() => update(Date.now() - due > GAP_MS), due - now)
    }
    if (down !== unreachable) {
      unreachable = down
      for (const listener of listeners) listener()
    }
  }

  const unsubscribe = client.subscribeToConnectionState((state) => {
    if (state.isWebSocketConnected === connected) return
    connected = state.isWebSocketConnected
    update(false)
  })
  const onVisibility = () => update(false)
  document.addEventListener('visibilitychange', onVisibility)
  update(false)

  const stop = () => {
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisibility)
    clearTimeout(timer)
    if (stopWatching === stop) {
      stopWatching = undefined
      downSince = null
      if (unreachable) {
        unreachable = false
        for (const listener of listeners) listener()
      }
    }
  }
  stopWatching = stop
  return stop
}

/** The line now, outside React: null while it is up. */
export function lineDown(): LineDown | null {
  return isOffline() ? 'no-signal' : unreachable ? 'unreachable' : null
}

/** Calls `onChange` whenever `lineDown()` may have changed. */
export function subscribeLineDown(onChange: () => void): () => void {
  listeners.add(onChange)
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/**
 * `lineDown()`, kept current. Null on the server and while hydrating, so
 * nothing renders as down before the browser has said so.
 */
export function useLineDown(): LineDown | null {
  return useSyncExternalStore(subscribeLineDown, lineDown, () => null)
}
