/// <reference lib="webworker" />
import { Serwist, NetworkFirst, StaleWhileRevalidate } from 'serwist'
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist'

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: Array<PrecacheEntry | string> | undefined
  }
}

declare const self: ServiceWorkerGlobalScope & WorkerGlobalScope

/**
 * Offline behaviour per §5.5. Convex already caches its last query results
 * client-side, so precaching the shell is what makes today's schedule render
 * in someone's backyard with no signal.
 *
 * Mutations still require connectivity — there is no offline queue in v1, and
 * this must not be marketed as fully offline-capable.
 */
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Fresh when there is signal, last-known when there is not.
      matcher: ({ request }) => request.mode === 'navigate',
      handler: new NetworkFirst({
        cacheName: 'pages',
        networkTimeoutSeconds: 4,
      }),
    },
    {
      matcher: ({ request }) =>
        ['style', 'script', 'worker', 'font'].includes(request.destination),
      handler: new StaleWhileRevalidate({ cacheName: 'assets' }),
    },
    {
      matcher: ({ request }) => request.destination === 'image',
      handler: new StaleWhileRevalidate({ cacheName: 'images' }),
    },
  ],
})

serwist.addEventListeners()
