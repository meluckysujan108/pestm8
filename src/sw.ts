/// <reference lib="webworker" />
import {
  CacheFirst,
  NetworkFirst,
  Serwist,
  StaleWhileRevalidate,
} from 'serwist'
import { version as pdfjsVersion } from 'pdfjs-dist/package.json'
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist'

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: Array<PrecacheEntry | string> | undefined
  }
}

declare const self: ServiceWorkerGlobalScope & WorkerGlobalScope

/**
 * The files pdf.js fetches as a PDF needs them — character maps, standard
 * fonts, WebAssembly decoders — which scripts/copy-pdfjs-assets.mjs puts
 * under /pdfjs/.
 *
 * Cache-first, filled on first use: they never change for a given pdf.js,
 * and a product PDF kept on the phone for a site with no signal
 * (src/lib/keptProducts.ts) still needs whichever of them it used last time.
 * "First use" is not left to chance for those: once something is kept, the
 * page fetches the decoders and fonts a page of it could need (the list in
 * /pdfjs/version.json) so that this rule stores them before the phone goes
 * anywhere without signal. That list itself is left to the network, so a new
 * build's list is never answered from an old cache.
 *
 * They are not content-hashed, so the cache is named for the pdf.js version
 * instead. The WebAssembly decoders must match the worker's own glue code
 * exactly; after an upgrade, a cache-first answer from the old version would
 * fail to decode images quietly. A new version starts a new cache, and the
 * old one is deleted when this worker activates (below).
 */
const PDFJS_CACHE_PREFIX = 'pdfjs-assets-'
const PDFJS_CACHE = `${PDFJS_CACHE_PREFIX}${pdfjsVersion}`
const PDFJS_LIST = '/pdfjs/version.json'

/**
 * The precache manifest without anything under pdfjs/.
 *
 * scripts/build-sw.mjs precaches every `.js` in the client output, and
 * pdf.js ships one JavaScript file among its runtime assets —
 * wasm/openjpeg_nowasm_fallback.js, ~450 KB, loaded only by a browser with
 * WebAssembly switched off (iOS Lockdown Mode). Precached, every install
 * would download it on a phone plan for the rare phone that needs it. Left
 * out here, it is fetched on demand like its neighbours and cached by the
 * rule below. (A `globIgnores` entry in build-sw.mjs would keep it out of the
 * manifest altogether; this holds either way.)
 */
function withoutPdfjs(
  entries: Array<PrecacheEntry | string> | undefined,
): Array<PrecacheEntry | string> {
  return (entries ?? []).filter((entry) => {
    const url = typeof entry === 'string' ? entry : entry.url
    return !/^(\.?\/)?pdfjs\//.test(url)
  })
}

/**
 * Offline behaviour per §5.5. Convex already caches its last query results
 * client-side, so precaching the shell is what makes today's schedule render
 * in someone's backyard with no signal.
 *
 * Mutations still require connectivity — there is no offline queue in v1, and
 * this must not be marketed as fully offline-capable.
 */
const serwist = new Serwist({
  precacheEntries: withoutPdfjs(self.__SW_MANIFEST),
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
      // Before the script/font rule: the pdf.js worker asks for these with
      // `fetch()` (an empty destination), but its fallback decoder is an
      // `import()`, which would otherwise land in 'assets' and be revalidated
      // on every use.
      matcher: ({ url, sameOrigin }) =>
        sameOrigin &&
        url.pathname.startsWith('/pdfjs/') &&
        url.pathname !== PDFJS_LIST,
      handler: new CacheFirst({ cacheName: PDFJS_CACHE }),
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

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith(PDFJS_CACHE_PREFIX) && name !== PDFJS_CACHE,
          )
          .map((name) => caches.delete(name)),
      )
    })().catch(() => {
      // Only space is lost; the current version's cache is its own.
    }),
  )
})
