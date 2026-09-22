import type { PrecacheEntry } from 'serwist'

/**
 * Naming and retiring the service worker's runtime caches.
 *
 * Split out of `src/sw.ts` so it can be tested without standing up a
 * `ServiceWorkerGlobalScope`: the worker itself is wiring, but which caches a
 * new build deletes is a decision with edges, and getting it wrong is silent
 * in exactly the way the bug it exists to prevent was silent.
 */

/**
 * The caches `src/sw.ts` declares in `runtimeCaching`. Serwist cleans up its
 * own precache on activate but knows nothing about these, so they are ours to
 * retire.
 */
export const RUNTIME_CACHES = ['pages', 'assets', 'images'] as const

export type RuntimeCache = (typeof RUNTIME_CACHES)[number]

/**
 * A build id derived from the precache manifest, which lists every hashed asset
 * the build emitted. Derived rather than stamped so it changes when the assets
 * change and not merely when the build reran — a timestamp would throw away a
 * still-valid cache on every deploy, including ones that touched only the
 * backend.
 *
 * FNV-1a, not a real digest: `crypto.subtle` is async and this is needed while
 * the worker module evaluates. The only requirement is that two different
 * manifests are overwhelmingly unlikely to agree.
 */
export function manifestVersion(
  manifest: Array<PrecacheEntry | string> | undefined,
): string {
  let hash = 0x811c9dc5

  for (const entry of manifest ?? []) {
    const token =
      typeof entry === 'string' ? entry : `${entry.url}:${entry.revision ?? ''}`
    for (let index = 0; index < token.length; index++) {
      hash = Math.imul(hash ^ token.charCodeAt(index), 0x01000193)
    }
  }

  return (hash >>> 0).toString(36)
}

export function runtimeCacheName(base: RuntimeCache, version: string): string {
  return `${base}-${version}`
}

/**
 * Of the caches that exist, the ones belonging to an earlier build.
 *
 * Bare names count as earlier: workers shipped before this versioning used
 * `pages` and `assets` unsuffixed, and those are precisely the caches pinning
 * the stale documents this was written to clear. A client on such a build picks
 * up the new worker on its next load and the old caches die with it.
 *
 * Anything not named after one of our runtime caches is left alone — Serwist's
 * own precache lives in this same storage and is its to manage.
 */
export function previousRuntimeCaches(
  existing: Array<string>,
  version: string,
): Array<string> {
  const current = new Set<string>(
    RUNTIME_CACHES.map((base) => runtimeCacheName(base, version)),
  )

  return existing.filter(
    (key) =>
      !current.has(key) &&
      RUNTIME_CACHES.some((base) => key === base || key.startsWith(`${base}-`)),
  )
}
