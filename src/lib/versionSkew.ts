import { useEffect } from 'react'

/**
 * Recovering a client that a deploy landed underneath.
 *
 * A running document is pinned to the build it was served from: it asks for
 * that build's hashed chunks, and it calls server functions by ids that
 * `@tanstack/start` derives from the function's own name
 * (`sha256("<path>--<fnName>_createServerFn_handler")`). Rename one and its
 * endpoint is renamed with it, so a client from before the rename gets a 500 —
 * `Server function info not found for <id>` — from a server that is otherwise
 * perfectly healthy. Renaming `getAuth` to `getInitialState` in __root.tsx did
 * exactly that, and because the call sits in the root `beforeLoad`, every
 * navigation failed and nobody could finish signing in.
 *
 * The service worker is what made it permanent rather than momentary (see
 * src/sw.ts), but the skew itself needs no service worker at all: a tab left
 * open across a deploy is in the same position. So this is the client's own
 * recovery, independent of that fix.
 */

/**
 * One attempt per tab. A reload that lands on the same broken build must not
 * reload again — the failure this reacts to is indistinguishable, from here,
 * from a backend that is simply down, and an unguarded loop against an outage
 * would be far worse than the bug.
 */
const ATTEMPTED = 'pm8_skew_recovery'

function claimTheSingleAttempt(): boolean {
  try {
    if (sessionStorage.getItem(ATTEMPTED)) return false
    sessionStorage.setItem(ATTEMPTED, '1')
    return true
  } catch {
    // Storage can be unavailable: private mode, blocked site data. Declining is
    // the safe read — it costs a stale client the manual reload it needs today,
    // where guessing the other way risks reloading forever.
    return false
  }
}

/**
 * Drops everything holding this build in place and reloads onto the current
 * one. Call only when the skew is established; the probe below is what
 * establishes it.
 *
 * Unregistering is deliberately heavier than asking the worker to update: it
 * guarantees the reload reaches the network, and `ServiceWorker.tsx` registers
 * again on the next load, which rebuilds the precache from the new manifest.
 * The offline cache is therefore gone for one page load, which is the right
 * trade when the alternative is an app that cannot be used at all.
 */
async function reloadOntoCurrentBuild(): Promise<void> {
  if (!claimTheSingleAttempt()) return

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((it) => it.unregister()))
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }
  } catch {
    // Reload anyway. Whatever could not be cleared is a reason to get onto a
    // fresh document sooner, not a reason to stay on this one.
  }

  window.location.reload()

  // Never settles. The document is being torn down, and resolving would let the
  // caller carry on and render an error into a page that is about to be gone.
  await new Promise<never>(() => {})
}

/**
 * Is the bundle we are running still on the server?
 *
 * `import.meta.url` is this module's own hashed chunk. If it 404s, the build
 * that produced it has been replaced and the skew is confirmed. That is worth
 * a round trip, because it separates the two things a failed server function
 * cannot otherwise tell apart: a renamed endpoint, where reloading is the whole
 * cure, and a backend outage, where wiping every client's offline cache would
 * turn a transient problem into a lasting one.
 *
 * The cache-busting parameter is not about the HTTP cache — `no-store` handles
 * that — but about the service worker, which would otherwise answer from
 * `assets` with the very copy whose existence is in question. A URL it has
 * never seen misses both that cache and the precache, so the probe reaches the
 * network.
 */
export async function buildIsGone(moduleUrl: string): Promise<boolean> {
  const probe = new URL(moduleUrl)
  probe.searchParams.set('skew', Date.now().toString(36))

  try {
    const response = await fetch(probe, { method: 'HEAD', cache: 'no-store' })
    return response.status === 404
  } catch {
    // Offline, or the request never landed. Says nothing about the build.
    return false
  }
}

/**
 * Call when a server function fails. Reloads only if this build is genuinely no
 * longer being served; any other failure is left for the caller to surface.
 */
export async function recoverIfVersionSkewed(): Promise<void> {
  if (typeof window === 'undefined') return
  if (import.meta.env.DEV) return
  if (!(await buildIsGone(import.meta.url))) return

  await reloadOntoCurrentBuild()
}

/**
 * The same skew, arriving as a missing chunk instead of a failed call: Vite
 * fires `vite:preloadError` when a route's lazy chunk cannot be fetched, which
 * after a deploy means the server no longer has the file this document is
 * asking for. No probe needed — the 404 already happened.
 *
 * Mounted once, at the root. `preventDefault` stops Vite rethrowing into an
 * unhandled rejection while the reload is being arranged.
 */
export function useVersionSkewRecovery(): void {
  useEffect(() => {
    const onPreloadError = (event: Event) => {
      event.preventDefault()
      void reloadOntoCurrentBuild()
    }

    window.addEventListener('vite:preloadError', onPreloadError)
    return () => window.removeEventListener('vite:preloadError', onPreloadError)
  }, [])
}
