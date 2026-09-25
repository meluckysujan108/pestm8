/**
 * What a page does when Convex refuses it as "Unauthenticated": it holds on
 * the page placeholder, asks Better Auth, and tries again, rather than ending
 * on "Something went wrong!" (components/auth/SignInSettling).
 *
 * The refusal is never the person's answer on its own. It comes when the
 * session has really ended, or when the socket is between two tokens. When
 * the session has ended, SessionWatch (__root.tsx) hears it from Better Auth
 * and sends them to sign in. When the socket is between tokens, the next
 * token settles it within a round trip or two. In neither case is the error
 * screen the right thing to show, and in the first case it used to flash
 * before the sign-in screen replaced it.
 *
 * Kept free of React, like lib/twoStep.ts: the router imports it for its
 * default error component, and that is in the entry chunk.
 */

export const UNAUTHENTICATED = 'Unauthenticated'

/**
 * `requireAuthUser` (convex/lib/access.ts) and Better Auth's `getAuthUser`
 * both throw `ConvexError('Unauthenticated')`, which arrives with the word as
 * its `data`. Matched on the message too, as lib/twoStep.ts matches its own
 * code, for an error that has lost its `data` on the way.
 */
export function isUnauthenticatedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { data?: unknown }).data === UNAUTHENTICATED) return true
  const message = (error as { message?: unknown }).message
  return (
    typeof message === 'string' &&
    new RegExp(`\\bConvexError: ${UNAUTHENTICATED}\\b`).test(message)
  )
}

/**
 * How long to wait after Better Auth has answered, for each retry in a row.
 * The first retry goes at once, because asking Better Auth has already taken
 * a round trip, and that is usually all the socket needed. Three in a row
 * cover a slow token refresh. A page refused a fourth time is being refused
 * for a reason, so it gets the real error screen.
 */
export const RETRY_DELAYS_MS = [0, 1_000, 3_000] as const

/**
 * The budget is three retries a minute, however slowly each refusal comes
 * back, so a server that takes its time over every refusal still ends on the
 * error screen instead of retrying forever.
 */
export const RETRY_WINDOW_MS = 60_000

/**
 * The retries left, counted across mounts: each retry that fails the same way
 * mounts a new error component, so the count can't live in one.
 */
export function createRetryBudget() {
  let spent: Array<number> = []
  return {
    /** How long to wait before retrying, or null once the budget is spent. */
    next(now: number): number | null {
      spent = spent.filter((at) => now - at < RETRY_WINDOW_MS)
      return RETRY_DELAYS_MS[spent.length] ?? null
    },
    spend(now: number): void {
      spent.push(now)
    },
  }
}

/** The browser's one budget. Never touched on the server, where module state
 *  is shared by every request. */
export const signInRetries = createRetryBudget()

/**
 * How long a held page waits for Better Auth before retrying anyway. The
 * answer only decides whether SessionWatch gets there first. A session check
 * that hangs, on a phone with one bar, must not hold the page on its
 * placeholder for good.
 */
export const SESSION_CHECK_TIMEOUT_MS = 5_000

/**
 * Before a retry: drops the cached queries that were refused before they
 * ever had data, so the retried page asks for them again. They can't recover
 * on their own. @convex-dev/react-query drops a pushed answer for an entry
 * that has no data yet. And with no QueryErrorResetBoundary, react-query
 * won't refetch an errored suspense query when it mounts again, so the page
 * would throw the same refusal straight back. Only entries nothing is
 * watching are dropped, as `warm` in lib/routeQueries.ts does.
 */
export function forgetRefusedQueries(queryClient: {
  removeQueries: (filters: {
    predicate: (query: {
      state: { status: string; data: unknown; error: unknown }
      getObserversCount: () => number
    }) => boolean
  }) => void
}): void {
  queryClient.removeQueries({
    predicate: (query) =>
      query.state.status === 'error' &&
      query.state.data === undefined &&
      query.getObserversCount() === 0 &&
      isUnauthenticatedError(query.state.error),
  })
}
