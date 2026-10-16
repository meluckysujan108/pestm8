import { useSyncExternalStore } from 'react'

/**
 * Whether the phone says it has no connection — the one answer from
 * `navigator.onLine` worth trusting. A phone with one bar in a roof void still
 * says it is online, so `false` here means "unknown", never "has signal".
 *
 * The single place the app asks: every "No signal" message, and every
 * fail-fast before a file upload, reads this rather than `navigator` itself.
 */
export function isOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  } catch {
    return false
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/**
 * `!isOffline()`, kept current as the connection comes and goes. True on the
 * server, so nothing renders as offline before the browser has said so.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !isOffline(),
    () => true,
  )
}

/**
 * Asks everything that waits for the network to go now: the Convex client's
 * reconnect skips its backoff, the sign-in token's retry (lib/tokenRefresh.ts)
 * abandons a request that is hanging and sends another, and Better Auth and
 * react-query refetch. They all listen for the browser's `online` event, so
 * this is that event. Only while the phone says it has a network: with none,
 * there is nothing to try.
 */
export function retryNow(): void {
  if (!isOffline()) window.dispatchEvent(new Event('online'))
}
