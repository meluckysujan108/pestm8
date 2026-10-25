/**
 * What the service worker (src/sw.ts) and the page (keptPages.ts) agree on
 * about the pages kept for opening with no signal.
 *
 * Imported by the worker too, which is bundled on its own: nothing here may
 * import anything, or touch the DOM.
 */

/** The worker's cache of whole pages, answered NetworkFirst. */
export const PAGES_CACHE = 'pages'

/**
 * Where `/` should go when it can't be fetched and has no copy of its own:
 * an entry in PAGES_CACHE, never a real page, whose body is the start page
 * of the business this phone keeps pages for ('/{slug}/schedule').
 */
export const HOME_MARKER = '/__pestm8/home'

/**
 * The start page a marker's body names, or null if it isn't a path on this
 * site. The worker redirects to it, so a body like '//elsewhere.com' must
 * never get through.
 */
export function homeFromMarker(body: string | null | undefined): string | null {
  const home = body?.trim() ?? ''
  return /^\/[^/\\]/.test(home) && home !== HOME_MARKER ? home : null
}

/**
 * Whether a kept response is a page in itself: not a redirect, kept opaque
 * as a navigation's is (status 0), or followed. Only such a page may be
 * where the worker sends a page it has no copy of, and named by
 * HOME_MARKER. Sent to a redirect whose own target had no copy, the worker
 * would send that back to the start page again, and on until the browser
 * gave up.
 */
export function opensAsPage(res: Response): boolean {
  return res.ok && !res.redirected
}
