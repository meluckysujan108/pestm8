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
