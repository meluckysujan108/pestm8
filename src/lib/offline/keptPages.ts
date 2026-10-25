import { logConnection } from '#/lib/connectionLog'
import { isOffline } from '#/lib/online'
import { signedInUserId } from '#/lib/rootState'
import {
  HOME_MARKER,
  PAGES_CACHE,
  homeFromMarker,
  opensAsPage,
} from './pagesCache'

/**
 * The pages the service worker keeps for opening with no signal (the
 * 'pages' cache, src/sw.ts), looked after from the page.
 *
 * The worker keeps each page as it fetches it. What it can't do from there:
 * - After a deploy, the pages it holds are the old build's HTML, naming
 *   files the new worker no longer precaches. A new worker taking over is
 *   the moment to fetch them again (`refreshKeptPages`).
 * - After a switch of business, the other business's pages must go
 *   (`purgeOtherBusinessPages`), and this one's start page must be here
 *   (`keepStartPage`), with HOME_MARKER saying where the worker sends `/`
 *   when its own copy points at a page that's gone.
 *
 * Every put, HOME_MARKER's too, follows this order (`openForKeeping`, then
 * `keepPage`), because a sign-out can land at any point in it:
 * 1. nothing with no signal;
 * 2. note who is signed in, and stop if nobody is;
 * 3. open the cache, BEFORE the fetch;
 * 4. fetch, following no redirect;
 * 5. check the same person is still signed in;
 * 6. put into the cache opened at 3, never one opened again.
 *
 * `forgetCachedPages` (rootState.ts) deletes 'pages' whenever the person
 * changes. A cache deleted after step 3 can't be opened by name again, so a
 * put into it reaches nobody. Opening it again after the fetch would make a
 * new 'pages' instead, with the last person's page in it.
 *
 * `refreshKeptPages` is called from ServiceWorker.tsx; the others from the
 * keeper (keeper.ts) as it claims the copy with signal: the purge and
 * `keepStartPageIfMissing` before IndexedDB is asked, the first time a page
 * load claims for a business, and `keepStartPage` once a claim finds the
 * copy was another business's, nobody's or another view's. Until one has
 * run there is no HOME_MARKER, so a refresh fetches only `/`; the worker's
 * 14 days of older files cover the rest.
 *
 * Everything here is best-effort and never throws: without it, pages are
 * still kept the way they always were.
 */

/** At most this many pages are fetched again after a deploy. */
const MAX_REFRESHED = 12

type Outcome = 'kept' | 'refused' | 'stopped'

/** `/` only ever redirects, so it is kept only as a redirect. */
const isRedirect = (res: Response) => res.type === 'opaqueredirect'

/** A business's start page, which HOME_MARKER names. */
function startPageOf(slug: string): string {
  return `/${encodeURIComponent(slug)}/schedule`
}

/** The business a start page is for, or null. */
function slugOfHome(home: string | null): string | null {
  const slug =
    home === null ? undefined : /^\/([^/?#]+)\/schedule$/.exec(home)?.[1]
  if (slug === undefined) return null
  try {
    return decodeURIComponent(slug)
  } catch {
    return null
  }
}

/** A URL's path, and its path with the query, or null if it can't be read. */
function partsOf(url: string): { pathname: string; path: string } | null {
  try {
    // Any base will do: only the path is read.
    const { pathname, search } = new URL(url, 'https://pestm8.invalid')
    return { pathname, path: pathname + search }
  } catch {
    return null
  }
}

/** Whether a path is one of this business's pages. */
function inBusiness(pathname: string, slug: string): boolean {
  const root = `/${encodeURIComponent(slug)}`
  return (
    pathname !== HOME_MARKER &&
    (pathname === root || pathname.startsWith(`${root}/`))
  )
}

/**
 * Which kept pages to fetch again after a deploy: `/`, and this business's
 * own pages, `/` first, then the start page, then the rest as the cache
 * lists them, at most MAX_REFRESHED. With no business known (no
 * HOME_MARKER yet), only `/`. Never another business's pages, and never one
 * outside a business (sign-in, invitations), which nobody opens with no
 * signal.
 */
export function pagesToRefresh(
  urls: ReadonlyArray<string>,
  slug: string | null,
): Array<string> {
  const start = slug === null ? null : startPageOf(slug)
  const seen = new Set<string>()
  const due: Array<{ url: string; rank: number }> = []
  for (const url of urls) {
    const at = partsOf(url)
    if (at === null || seen.has(at.path)) continue
    seen.add(at.path)
    if (at.path === '/') due.push({ url, rank: 0 })
    else if (slug !== null && inBusiness(at.pathname, slug)) {
      due.push({ url, rank: at.path === start ? 1 : 2 })
    }
  }
  return due
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_REFRESHED)
    .map(({ url }) => url)
}

/**
 * Which kept pages go when this phone keeps pages for `slug`: every page but
 * `/`, HOME_MARKER and this business's own. Another business's pages carry
 * its clients and jobs, and the person may no longer be in it.
 */
export function pagesToPurge(
  urls: ReadonlyArray<string>,
  slug: string,
): Array<string> {
  return urls.filter((url) => {
    const at = partsOf(url)
    return (
      at !== null &&
      at.pathname !== '/' &&
      at.pathname !== HOME_MARKER &&
      !inBusiness(at.pathname, slug)
    )
  })
}

/**
 * How a page is fetched to be kept: never from the HTTP cache, and with any
 * redirect left as the answer, so a redirect to sign in is never kept as the
 * page itself.
 */
const FETCH_TO_KEEP: RequestInit = {
  credentials: 'include',
  cache: 'no-store',
  redirect: 'manual',
}

/** 'pages', opened for whoever was signed in when it was (steps 1 to 3). */
type Keeping = { cache: Cache; samePerson: () => boolean }

/** Steps 1 to 3 of the header's order, or null when nothing may be kept. */
async function openForKeeping(): Promise<Keeping | null> {
  if (isOffline() || typeof caches === 'undefined') return null
  const who = signedInUserId()
  if (who === null) return null
  const cache = await caches.open(PAGES_CACHE)
  return { cache, samePerson: () => signedInUserId() === who }
}

/**
 * Steps 4 to 6: fetches `url`, and puts it into the cache `keeping` opened
 * if `take` says so. 'stopped' when there is no signal, the fetch fails or
 * the put does: the next page would fare no better.
 */
async function keepPage(
  keeping: Keeping,
  url: string,
  take: (res: Response) => boolean,
): Promise<Outcome> {
  if (isOffline()) return 'stopped'
  try {
    const res = await fetch(url, FETCH_TO_KEEP)
    if (!take(res) || !keeping.samePerson()) return 'refused'
    await keeping.cache.put(url, res)
    return 'kept'
  } catch {
    return 'stopped'
  }
}

/** The start page HOME_MARKER names in `cache`, or null. */
async function markedHome(cache: Cache): Promise<string | null> {
  const marker = await cache.match(HOME_MARKER)
  return homeFromMarker(marker ? await marker.text() : null)
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === location.origin
  } catch {
    return false
  }
}

let refreshing: Promise<void> | null = null

/**
 * Fetches the kept pages again, for when a new service worker has taken
 * over this page (ServiceWorker.tsx), so a page opened with no signal is the
 * new build's in the first place. The worker also keeps the files an older
 * page names for 14 days (src/sw.ts), for a phone with no signal at the
 * moment of the deploy.
 *
 * One page at a time, and it stops at the first that can't be fetched: on
 * one bar, the rest would only queue behind it.
 */
export function refreshKeptPages(): Promise<void> {
  refreshing ??= refresh().finally(() => {
    refreshing = null
  })
  return refreshing
}

async function refresh(): Promise<void> {
  try {
    // Never makes a 'pages' where there is none: nothing to refresh.
    if (typeof caches === 'undefined' || !(await caches.has(PAGES_CACHE))) {
      return
    }
    const keeping = await openForKeeping()
    if (keeping === null) return
    const urls = (await keeping.cache.keys())
      .map(({ url }) => url)
      .filter(sameOrigin)
    const due = pagesToRefresh(
      urls,
      slugOfHome(await markedHome(keeping.cache)),
    )
    if (due.length === 0) return
    let kept = 0
    for (const url of due) {
      // Any other page only as itself, never as a redirect to sign in.
      const take = partsOf(url)?.path === '/' ? isRedirect : opensAsPage
      const outcome = await keepPage(keeping, url, take)
      if (outcome === 'stopped') break
      if (outcome === 'kept') kept++
    }
    logConnection('pages-refresh', { n: due.length, ok: kept })
  } catch {
    // Best-effort, as above.
  }
}

/**
 * Keeps this business's start page, and HOME_MARKER naming it, both in the
 * one cache opened before the fetch: once a switch of business has been
 * confirmed with signal, or when the start page is missing. The marker is
 * written only when the start page is here as a page, not a redirect the
 * worker kept from an earlier visit, so `/` is never sent to a page that
 * can't open either.
 */
export async function keepStartPage(slug: string): Promise<void> {
  try {
    const keeping = await openForKeeping()
    if (keeping === null) return
    const start = startPageOf(slug)
    await keepPage(keeping, start, opensAsPage)
    const kept = await keeping.cache.match(start, { ignoreVary: true })
    if (!kept || !opensAsPage(kept)) return
    if (!keeping.samePerson()) return
    await keeping.cache.put(
      HOME_MARKER,
      new Response(start, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    )
  } catch {
    // Best-effort, as above.
  }
}

/**
 * `keepStartPage`, unless HOME_MARKER already names this business and its
 * start page is here as a page: for the keeper's first claim for a business,
 * made before IndexedDB answers, which may fail or never come. Resolves true
 * when it went on to keep it, so the caller needn't again.
 */
export async function keepStartPageIfMissing(slug: string): Promise<boolean> {
  try {
    if (typeof caches !== 'undefined' && (await caches.has(PAGES_CACHE))) {
      const cache = await caches.open(PAGES_CACHE)
      const kept = await cache.match(startPageOf(slug), { ignoreVary: true })
      if (
        slugOfHome(await markedHome(cache)) === slug &&
        kept &&
        opensAsPage(kept)
      ) {
        return false
      }
    }
  } catch {
    // Best-effort, as above: keeping it again does no harm.
  }
  await keepStartPage(slug)
  return true
}

/**
 * Drops every kept page but `/` and this business's own (`pagesToPurge`),
 * and HOME_MARKER too if it names another business. Only deletes, so it
 * needs no signal and no check of who is signed in.
 */
export async function purgeOtherBusinessPages(slug: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') return
    if (!(await caches.has(PAGES_CACHE))) return
    const cache = await caches.open(PAGES_CACHE)
    const gone = pagesToPurge(
      (await cache.keys()).map(({ url }) => url),
      slug,
    )
    if (slugOfHome(await markedHome(cache)) !== slug) gone.push(HOME_MARKER)
    await Promise.all(
      gone.map((url) => cache.delete(url, { ignoreVary: true })),
    )
  } catch {
    // Best-effort, as above.
  }
}
