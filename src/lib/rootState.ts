import { getInitialState } from '#/lib/initialState'
import { readThemePref } from '#/lib/theme'
import type { ThemePref } from '#/lib/theme'

export type RootState = { token: string | undefined; theme: ThemePref }

/**
 * The browser's copy of the root route's "who is signed in" answer.
 *
 * Router-core re-runs every match's `beforeLoad`, from the root down, on every
 * client navigation, preload and search-param change, and loads nothing until
 * they have all resolved. The root's answered with the `getInitialState`
 * server function, so every tap — a tab, a day on the week strip, a job, each
 * search term — first waited for an HTTP round trip to a Vercel function in
 * iad1, which itself fetched a token from Convex. Measured from a long way
 * from US-East: ~380 ms on a desktop and ~750 ms on a phone, whose touchstart
 * preload, click and emulated mouseenter each sent the same GET for the
 * browser to queue behind one another. Answering instantly took a warm tab
 * switch from 740–795 ms to 23–36 ms.
 *
 * None of that answer needs to be fresh in the browser. `token` is read once
 * per page load (ConvexBetterAuthProvider's `initialToken`), the Convex client
 * fetches its own tokens after that, `serverHttpClient` exists only on the
 * server, and `theme` is read live from <html> below. What the client uses is
 * `isAuthenticated`, for the guards' redirects. So once signed in, the browser
 * answers from here, and what keeps that honest is:
 *
 * - A signed-out answer is never kept. Signing in on the join page
 *   invalidates the router, and the next `beforeLoad` has to see it (login.tsx
 *   reloads the document, which starts everything over).
 * - Seeded once per page load from the context SSR dehydrated, which
 *   hydration restores without running `beforeLoad` at all.
 * - Forgotten when the session ends. `SessionWatch` (__root.tsx) follows
 *   Better Auth's session — a sign-out in this tab or another, and a session
 *   revoked or expired on the server, which it re-checks at most once a
 *   minute while the person is navigating — and invalidates the router, whose
 *   guards then send them to /login as they did before. And a guard refused
 *   what a signed-in person should get asks again first (`signedOutAfterAll`),
 *   which catches an offboarding at the very next tap.
 *
 * Never consulted on the server, where module state would be shared between
 * every request the process serves.
 */
let token: string | undefined
let seeded = false
// The answer being fetched right now, shared so a preload and the click it
// precedes ask once between them.
let asking: Promise<RootState> | undefined
// When the server last answered, so a guard doubting the cache a moment later
// does not ask all over again.
let askedAt = 0
// Bumped by every forget, so an answer already in flight when the session
// ended cannot put the old sign-in back.
let generation = 0

/** Once per page load, from the root context SSR handed over. */
export function seedRootState(state: RootState): void {
  if (seeded || typeof window === 'undefined') return
  seeded = true
  if (state.token) token = state.token
  checkKeptFiles()
}

/** The root `beforeLoad`'s answer on the client: cached once signed in. */
export async function resolveRootState(): Promise<RootState> {
  if (token) return { token, theme: readThemePref() }

  const asked = generation
  asking ??= getInitialState()
  try {
    const fresh = await asking
    if (asked === generation) {
      token = fresh.token
      askedAt = Date.now()
      // Signing in on the join page lands here, with no page load between
      // the last person and this one.
      checkKeptFiles()
    }
    return fresh
  } finally {
    asking = undefined
  }
}

/**
 * For a guard that has just been refused something a signed-in person should
 * have: is this person still signed in at all? Forgets the cached answer and
 * asks the server. Offboarding deletes someone's sessions, and the queries
 * the guards read resolve through the session, so the first sign of it is a
 * business the layout can no longer find — which, taken at its word, is a
 * "Not found" dead end instead of the sign-in screen. False wherever nothing
 * is cached to doubt, including the server.
 */
export async function signedOutAfterAll(): Promise<boolean> {
  if (typeof window === 'undefined' || !token) return false
  // The server answered a moment ago — on the preload this same tap fired, or
  // on the navigation before it. Asking again would put two more round trips
  // in front of a screen that is already waiting.
  if (Date.now() - askedAt < 3_000) return false

  const stale = token
  const asked = generation
  forgetRootState()
  try {
    return !(await resolveRootState()).token
  } catch {
    // Offline, or the function failed. That says nothing about the session,
    // and dropping the cached sign-in over it would make every navigation
    // after this one ask the server again — so put it back and let the guard
    // treat this as the missing business it looks like.
    restoreRootState(stale, asked)
    return false
  }
}

/** Puts back a sign-in this module forgot, unless something else has moved on. */
function restoreRootState(previous: string, asked: number): void {
  if (generation === asked + 1 && token === undefined) token = previous
}

export function forgetRootState(): void {
  token = undefined
  generation++
}

/**
 * Before a full load that changes who is signed in.
 *
 * `src/sw.ts` serves navigations NetworkFirst with a 4-second timeout, and
 * Serwist caches the opaque redirect that `/` answers with. So a slow sign-in
 * could be handed the last visit's redirect — back to /login, or into the
 * previous person's business, whose cached document also carries their token.
 * The cache is keyed by URL and knows nothing about who asked, so the only
 * safe move is to drop it when the person changes.
 *
 * Product PDFs kept on this phone for sites with no signal are NOT dropped
 * here, though this runs at every sign-in as well as every sign-out. They are
 * labelled with who kept them, and go when someone else signs in
 * (`checkKeptFiles` below) — so the same technician signing back in after a
 * week-old session lapsed still has them in the roof void.
 *
 * The person's own licences (src/lib/keptLicence.ts) ARE dropped here: they
 * are their personal information rather than the business's shelf, and they
 * come back on their own the next time the list of them answers with signal.
 */
export async function forgetCachedPages(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') {
      await Promise.all([
        caches.delete('pages'),
        ...KEPT_LICENCE_CACHES.map((name) => caches.delete(name)),
      ])
    }
  } catch {
    // A browser that refuses the cache has nothing stale to serve from it.
  }
}

/**
 * The caches src/lib/keptLicence.ts keeps the person's licences in — the
 * wallet's, and the single Phase 8.1 document's before it, which a phone
 * may still hold — named here rather than imported for the reason
 * `KEPT_CACHE` below is. Its test holds the names together.
 */
const KEPT_LICENCE_CACHES = [
  'pestm8-kept-licence-v2',
  'pestm8-kept-licence-v1',
] as const

/**
 * Who is signed in, by user id: the `sub` claim of the cached token, which
 * Better Auth's JWT plugin sets to the user's id. Null when nobody is (as far
 * as this page load knows), on the server, or when the token cannot be read.
 *
 * Read without checking the signature, and that is fine for what it is used
 * for: deciding whose files kept on this phone to show, never what anyone may
 * do — the server checks the token properly on every request.
 */
export function signedInUserId(): string | null {
  return userIdOfToken(token)
}

/** The `sub` claim of a JWT, or null. Exported for its test. */
export function userIdOfToken(jwt: string | undefined): string | null {
  const payload = jwt?.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const sub = (JSON.parse(atob(padded)) as { sub?: unknown } | null)?.sub
    return typeof sub === 'string' && sub !== '' ? sub : null
  } catch {
    return null
  }
}

/**
 * The cache src/lib/keptProducts.ts keeps product PDFs in, named here rather
 * than imported so this module does not pull that one in (see below). Its
 * test holds the two names together.
 */
const KEPT_CACHE = 'pestm8-kept-products-v1'

// Who the kept files were last checked against, this page load.
let keptCheckedFor: string | null = null

/**
 * Drops the product PDFs kept on this phone if someone else kept them — run
 * as soon as a page load knows who is signed in, however they signed in (the
 * sign-in page reloads into here; the join page signs in without a reload).
 * src/lib/keptProducts.ts makes the same check before every read, which is
 * what actually keeps them off screen; this is so a phone that changes hands
 * is cleared even if the next person never opens a product.
 *
 * This module is in the root route's import graph, which every page waits
 * on, and keptProducts.ts brings React hooks and the PDF helpers with it. So
 * it is loaded only when there are kept files to check, which one
 * `caches.has` answers. If it cannot load (a deploy since this page opened
 * replaced its chunk), nothing here can show the files either, and the check
 * runs again at the next page load.
 */
function checkKeptFiles(): void {
  const userId = signedInUserId()
  if (!userId || userId === keptCheckedFor) return
  keptCheckedFor = userId
  void (async () => {
    try {
      if (typeof caches === 'undefined') return
      if (!(await caches.has(KEPT_CACHE))) return
      const { claimKept } = await import('#/lib/keptProducts')
      await claimKept(userId)
    } catch {
      // See above: checked again before anything is read.
    }
  })()
}

export function hasRootState(): boolean {
  return token !== undefined
}
