/// <reference lib="webworker" />
import { Serwist, NetworkFirst, StaleWhileRevalidate } from 'serwist'
import {
  manifestVersion,
  previousRuntimeCaches,
  runtimeCacheName,
} from './lib/swCaches'
import type { SerwistGlobalConfig, PrecacheEntry } from 'serwist'

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: Array<PrecacheEntry | string> | undefined
  }
}

declare const self: ServiceWorkerGlobalScope & WorkerGlobalScope

/**
 * Read exactly once, and deliberately into a binding used more than once.
 * `injectManifest` asserts the bundled worker contains a single textual
 * `self.__SW_MANIFEST` to substitute, so a second mention of it anywhere in
 * this file fails the build — which is how this comment came to be written.
 *
 * Relative import above rather than `#/lib/...` for the same kind of reason:
 * this file is bundled by its own bare `vite.build` in scripts/build-sw.mjs,
 * with `configFile: false` and none of the app's resolution set up.
 */
const MANIFEST = self.__SW_MANIFEST

/**
 * Offline behaviour per §5.5. Convex already caches its last query results
 * client-side, so precaching the shell is what makes today's schedule render
 * in someone's backyard with no signal.
 *
 * Mutations still require connectivity — there is no offline queue in v1, and
 * this must not be marketed as fully offline-capable.
 *
 * The runtime caches are versioned per build, because nothing else retires
 * them. Serwist cleans up its own precache on activate but `runtimeCaching`
 * entries are opaque to it, so whatever `pages` and `assets` hold outlives
 * every deploy. That is not theoretical: a client went on replaying a
 * pre-rename document out of `pages`, referencing hashed bundles that only
 * `assets` still had — the deployment had 404'd them long before — and that
 * stale bundle kept calling a server function whose id had changed underneath
 * it. Since the call sits in the root route's `beforeLoad`, every navigation
 * 500'd and signing in could never complete. `src/lib/versionSkew.ts` is the
 * client-side half of the fix.
 */
const VERSION = manifestVersion(MANIFEST)

const serwist = new Serwist({
  precacheEntries: MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Fresh when there is signal, last-known when there is not.
      matcher: ({ request }) => request.mode === 'navigate',
      handler: new NetworkFirst({
        cacheName: runtimeCacheName('pages', VERSION),
        networkTimeoutSeconds: 4,
      }),
    },
    {
      matcher: ({ request }) =>
        ['style', 'script', 'worker', 'font'].includes(request.destination),
      handler: new StaleWhileRevalidate({
        cacheName: runtimeCacheName('assets', VERSION),
      }),
    },
    {
      matcher: ({ request }) => request.destination === 'image',
      handler: new StaleWhileRevalidate({
        cacheName: runtimeCacheName('images', VERSION),
      }),
    },
  ],
})

/**
 * Registered before `addEventListeners` only for reading order; both listeners
 * run, each extending activation with its own `waitUntil`.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          previousRuntimeCaches(keys, VERSION).map((key) => caches.delete(key)),
        ),
      ),
  )
})

serwist.addEventListeners()
