import type { AuthTokenFetcher } from 'convex/browser'

/**
 * A Convex token refresh that fails, rather than being refused, is retried
 * until it gets through, instead of signing the socket out.
 *
 * The Convex client refreshes its token about ten seconds before the old one
 * expires (15 minutes, the better-auth convex plugin's default). It also
 * refreshes right after the server accepts the token a page loaded with, and
 * whenever the server rejects one. A phone that wakes fires the scheduled
 * refresh at once, usually before its network is back. @convex-dev/better-auth's
 * token getter answers `null` both when /api/auth/convex/token says 401 and
 * when the request never got an answer (no signal, a 5xx), because better-fetch
 * lets a failed `fetch` reject and the getter's `.catch` returns null. The
 * Convex client takes every null as signed out: it tells the server "nobody",
 * reports the socket signed out, and nothing signs it back in until Better
 * Auth's session id changes, which it never does for someone still signed in.
 * From then on every query answers "Unauthenticated". The Reports and Notes
 * lists end on the error screen, and every other page stops updating.
 *
 * So a forced refresh that comes back empty asks Better Auth whether anyone
 * is signed in, with the same rule SessionWatch (__root.tsx) uses. Signed out
 * means the server said so: no session, or a 401. Only then does the null go
 * through to the Convex client, which signs the socket out as before. Any
 * other answer (a session, no signal, a failed request) waits and fetches
 * again, for as long as it takes. Meanwhile the socket keeps the token it has.
 * If that token expires first, the server rejects it and the Convex client
 * stops the socket and asks for a new one, which waits on this same retry.
 * Either way the page keeps what it last showed and picks up again once the
 * token lands. It never shows an error.
 */

/** Better Auth's answer to "is anyone signed in?", or none. */
export type SessionAnswer = 'signedIn' | 'signedOut' | 'unknown'

export type RefreshRetry = {
  askSession: () => Promise<SessionAnswer>
  /** Waits before the next attempt (numbered from 0). */
  pause: (attempt: number) => Promise<void>
}

/**
 * What Better Auth's `getSession()` resolved to, read as SessionWatch reads
 * the session store: a session, or signed out only when the server said so.
 */
export function readSessionAnswer(result: {
  data: unknown
  error: { status?: number } | null
}): SessionAnswer {
  if (result.error) return result.error.status === 401 ? 'signedOut' : 'unknown'
  return result.data == null ? 'signedOut' : 'signedIn'
}

/**
 * Wraps the token getter the Convex client is handed, so that a forced
 * refresh coming back empty is retried unless the session has really ended.
 * `isCurrent` turns false once the client has moved on to another sign-in, or
 * signed out. A retry still waiting then stops, and hands back null. For a
 * sign-in that was replaced, the Convex client ignores that null. For a
 * sign-out, it matches what the socket already has.
 *
 * Forced refreshes that arrive while a retry is under way wait for that same
 * retry. That happens when the old token expires while the scheduled refresh
 * is still waiting and the server rejects it. One retry is enough, and its
 * token is fresh either way.
 */
export function withRefreshRetry(
  fetchToken: AuthTokenFetcher,
  retry: RefreshRetry,
  isCurrent: () => boolean,
): AuthTokenFetcher {
  let retrying: Promise<string | null> | undefined

  async function untilSettled(): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      const answer = await retry
        .askSession()
        .catch((): SessionAnswer => 'unknown')
      if (answer === 'signedOut' || !isCurrent()) return null
      await retry.pause(attempt)
      if (!isCurrent()) return null
      const token = await fetchToken({ forceRefreshToken: true })
      if (!isCurrent()) return null
      if (token) return token
    }
  }

  return async (args) => {
    if (args.forceRefreshToken && retrying) return retrying
    const token = await fetchToken(args)
    if (token || !args.forceRefreshToken || !isCurrent()) return token
    retrying ??= untilSettled().finally(() => {
      retrying = undefined
    })
    return retrying
  }
}

/** 1 s, doubling, then every 30 s for as long as the refresh keeps failing. */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt)
}

/**
 * The browser's retry. With no network at all it doesn't ask Better Auth,
 * whose request would only fail. It tries again early when the network comes
 * back, or when the page is looked at again. That is usually the phone waking,
 * and whoever woke it is waiting for the page.
 */
export function browserRefreshRetry(
  getSession: () => Promise<{
    data: unknown
    error: { status?: number } | null
  }>,
): RefreshRetry {
  return {
    askSession: async () =>
      navigator.onLine ? readSessionAnswer(await getSession()) : 'unknown',
    pause: (attempt) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          window.removeEventListener('online', done)
          document.removeEventListener('visibilitychange', onVisible)
          resolve()
        }
        const onVisible = () => {
          if (document.visibilityState === 'visible') done()
        }
        const timer = setTimeout(done, retryDelayMs(attempt))
        window.addEventListener('online', done)
        document.addEventListener('visibilitychange', onVisible)
      }),
  }
}
