/// <reference lib="webworker" />
import {
  CacheExpiration,
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  Serwist,
  StaleWhileRevalidate,
} from 'serwist'
import { version as pdfjsVersion } from 'pdfjs-dist/package.json'
import type { PrecacheEntry, SerwistGlobalConfig, SerwistPlugin } from 'serwist'
import { APP_VERSION } from './lib/appVersion'
import {
  HOME_MARKER,
  PAGES_CACHE,
  homeFromMarker,
  opensAsPage,
} from './lib/offline/pagesCache'
import { answerVersionRequest } from './lib/workerVersion'

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
 * The precache manifest without anything under pdfjs/ or splash/.
 *
 * scripts/build-sw.ts precaches every `.js` in the client output, and
 * pdf.js ships one JavaScript file among its runtime assets —
 * wasm/openjpeg_nowasm_fallback.js, ~450 KB, loaded only by a browser with
 * WebAssembly switched off (iOS Lockdown Mode). Precached, every install
 * would download it on a phone plan for the rare phone that needs it. Left
 * out here, it is fetched on demand like its neighbours and cached by the
 * rule below.
 *
 * splash/ is the iOS launch screens (scripts/build-icons.mjs): every `.png`
 * is precached too, and those are 1.4 MB for every install, of which an
 * iPhone uses two, fetched by iOS itself when the app is added to the Home
 * Screen.
 *
 * build-sw.ts's `globIgnores` keeps both out of the manifest in the first
 * place; this filter holds even if those entries are ever lost.
 */
function withoutFetchedOnDemand(
  entries: Array<PrecacheEntry | string> | undefined,
): Array<PrecacheEntry | string> {
  return (entries ?? []).filter((entry) => {
    const url = typeof entry === 'string' ? entry : entry.url
    return !/^(\.?\/)?(pdfjs|splash)\//.test(url)
  })
}

/**
 * Scripts, styles, workers and fonts fetched outside the precache, and the
 * scripts and styles of builds since replaced (`keepReplacedFiles` below).
 *
 * Each is kept 14 days from when it was last fetched or moved here: long
 * enough for an older page's chunks to outlast several deploys. At most 400
 * files, oldest out first, so a run of deploys can't fill the phone.
 */
const ASSETS_CACHE = 'assets'
const ASSETS_EXPIRY = { maxAgeSeconds: 14 * 86_400, maxEntries: 400 }

/**
 * Where a page opened with no signal goes when this phone has no copy of
 * it: the start page the page side last kept (lib/offline/keptPages.ts,
 * HOME_MARKER), if there is a copy of that, as a page and not a redirect
 * (`opensAsPage`), and it isn't what was asked for.
 *
 * Reached only once NetworkFirst has neither an answer nor a copy, so it
 * changes nothing that works today. Mostly it is for opening the app at `/`.
 * A switch of business drops the other business's pages, but `/`'s kept
 * redirect may still point at one of them (a redirect's Location can't be
 * read, so it can't be checked when it is kept): the page it leads to then
 * has no copy, and this sends it on to the start page. Otherwise undefined,
 * which fails as before.
 */
const homeWhenNoCopy: SerwistPlugin = {
  async handlerDidError({ request }) {
    try {
      const marker = await caches.match(HOME_MARKER, {
        cacheName: PAGES_CACHE,
      })
      const home = homeFromMarker(marker ? await marker.text() : null)
      if (!home) return undefined
      const asked = new URL(request.url)
      if (asked.pathname + asked.search === home) return undefined
      const kept = await caches.match(home, {
        cacheName: PAGES_CACHE,
        ignoreVary: true,
      })
      if (!kept || !opensAsPage(kept)) return undefined
      return Response.redirect(new URL(home, self.location.origin).href, 302)
    } catch {
      return undefined
    }
  },
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
  precacheEntries: withoutFetchedOnDemand(self.__SW_MANIFEST),
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Fresh when there is signal, last-known when there is not.
      matcher: ({ request }) => request.mode === 'navigate',
      handler: new NetworkFirst({
        cacheName: PAGES_CACHE,
        networkTimeoutSeconds: 4,
        // A copy the page kept for itself (lib/offline/keptPages.ts) was
        // fetched with different request headers than a navigation sends,
        // so a response that varies on any of them would never match one.
        // Each copy is one person's, by URL, and dropped when the person
        // changes (`forgetCachedPages`), so nothing else needs telling apart.
        matchOptions: { ignoreVary: true },
        plugins: [homeWhenNoCopy],
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
      handler: new StaleWhileRevalidate({
        cacheName: ASSETS_CACHE,
        plugins: [new ExpirationPlugin(ASSETS_EXPIRY)],
      }),
    },
    {
      matcher: ({ request }) => request.destination === 'image',
      handler: new StaleWhileRevalidate({ cacheName: 'images' }),
    },
  ],
})

/**
 * The scripts and styles of the build being replaced, kept in 'assets'.
 *
 * A page kept in 'pages' is the HTML of whichever build served it, and it
 * names that build's chunks by their hashed file names. When a new worker
 * activates, Serwist deletes every precached file its own manifest doesn't
 * list. So after a deploy, an older page opened with no signal asks for
 * scripts this phone no longer has, and never boots: it shows, but nothing
 * on it works, and no JavaScript is left to say why. The page fetches its
 * kept pages afresh when a new worker takes over (lib/offline/keptPages.ts,
 * from ServiceWorker.tsx), but only with signal at that moment, and a phone
 * can sit through several deploys between visits, so the files of more than
 * the last build are needed.
 *
 * So while this worker installs, before activation's clean-up, every
 * precached script and stylesheet the new manifest no longer lists is copied
 * into 'assets'. The rule above answers it there by its plain URL, since the
 * new precache no longer knows it. Each copy is dated now, not when it was
 * first fetched: the expiry checks a response's Date, and the 14 days should
 * count from the deploy that replaced the file. Fonts and images are left
 * out: a missing one doesn't stop a page booting.
 *
 * Precache keys carry the revision as `?__WB_REVISION__=…` (Serwist's
 * createCacheKey); the manifest's own URLs don't. Best-effort: a failure
 * here must never stop the new build installing.
 */
const REVISION_PARAM = '__WB_REVISION__'

async function keepReplacedFiles(): Promise<void> {
  const listed = new Set(serwist.getUrlsToPrecacheKeys().keys())
  const precache = await caches.open(serwist.precacheStrategy.cacheName)
  const assets = await caches.open(ASSETS_CACHE)
  const expiry = new CacheExpiration(ASSETS_CACHE, ASSETS_EXPIRY)
  for (const key of await precache.keys()) {
    const url = new URL(key.url)
    url.searchParams.delete(REVISION_PARAM)
    if (listed.has(url.href) || !/\.(m?js|css)$/.test(url.pathname)) continue
    const old = await precache.match(key)
    if (!old?.ok) continue
    const headers = new Headers(old.headers)
    headers.set('date', new Date().toUTCString())
    // Its key below has no headers to compare a Vary with, and a hashed
    // file is the same for every request anyway.
    headers.delete('vary')
    await assets.put(
      url.href,
      new Response(await old.blob(), {
        status: old.status,
        statusText: old.statusText,
        headers,
      }),
    )
    await expiry.updateTimestamp(url.href)
  }
  await expiry.expireEntries()
}

// Before Serwist's own listeners, as its docs ask; its precaching runs
// alongside and only adds the new build's files.
self.addEventListener('install', (event) => {
  event.waitUntil(keepReplacedFiles().catch(() => {}))
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

// Which build this worker is, for a page deciding whether it is out of date
// (src/lib/workerVersion.ts). scripts/build-sw.ts writes in the same commit
// the app is built with, so a page and a worker from one deploy agree.
self.addEventListener('message', (event) => {
  answerVersionRequest(event.data, event.ports, APP_VERSION)
})
