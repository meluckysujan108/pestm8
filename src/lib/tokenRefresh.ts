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
 * token lands. It never shows an error; components/shell/ConnectionNotice.tsx
 * says when the wait has gone on.
 *
 * And no request is waited on for good. Nothing under it sets a time limit —
 * not better-auth, not better-fetch — and on a phone a request can hang with
 * no answer: one sent just before iOS put the Home Screen app to sleep, or
 * through a VPN tunnel that is being rebuilt. While the socket is stopped for
 * a fresh token, that one request was all that stood between the person and a
 * working app, so it held every screen on "Loading…" (16 Oct 2026, a
 * technician on 5G with a VPN: "Just keeps saying loading and can't do
 * anything"). So each attempt has `bound`'s time to answer, and the phone
 * waking or its network coming back abandons the one in flight and sends
 * another at once, which is when one has the best chance.
 */

/** Better Auth's answer to "is anyone signed in?", or none. */
export type SessionAnswer = 'signedIn' | 'signedOut' | 'unknown'

export type RefreshRetry = {
  askSession: () => Promise<SessionAnswer>
  /** Waits before the next attempt (numbered from 0). */
  pause: (attempt: number) => Promise<void>
  /**
   * Settles a request within the time attempt number `attempt` is given:
   * with its own answer, or with `fallback` once it has taken too long or the
   * phone has woken or got its network back. The request is abandoned, not
   * cancelled — better-auth's token call takes no signal. Without this,
   * requests are waited on for as long as they take.
   */
  bound?: <T>(request: Promise<T>, fallback: T, attempt: number) => Promise<T>
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
 * Forced refreshes that arrive while one is under way — its first request or
 * its retries — wait for that same one. That happens when the old token
 * expires while the scheduled refresh is still waiting and the server rejects
 * it, and when a sign-in handed over while the socket was stopped for a fresh
 * token asks for one too. One is enough, and its token is fresh either way.
 *
 * A token the page already holds (no forced refresh) is handed back as it is,
 * unless its request outlasts `bound`: then null, and the Convex client asks
 * again with a forced refresh, which retries.
 */
export function withRefreshRetry(
  fetchToken: AuthTokenFetcher,
  retry: RefreshRetry,
  isCurrent: () => boolean,
): AuthTokenFetcher {
  let refreshing: Promise<string | null> | undefined

  const within = <T>(request: Promise<T>, fallback: T, attempt: number) =>
    retry.bound ? retry.bound(request, fallback, attempt) : request

  const fetchWithin = async (attempt: number, forceRefreshToken: boolean) =>
    (await within(
      fetchToken({ forceRefreshToken }).catch(() => null),
      null,
      attempt,
    )) ?? null

  async function refresh(): Promise<string | null> {
    const token = await fetchWithin(0, true)
    if (token || !isCurrent()) return token
    for (let attempt = 0; ; attempt++) {
      const answer = await within(
        retry.askSession().catch((): SessionAnswer => 'unknown'),
        'unknown',
        attempt,
      )
      if (answer === 'signedOut' || !isCurrent()) return null
      await retry.pause(attempt)
      if (!isCurrent()) return null
      const next = await fetchWithin(attempt + 1, true)
      if (!isCurrent()) return null
      if (next) return next
    }
  }

  return async (args) => {
    if (!args.forceRefreshToken) return fetchWithin(0, false)
    refreshing ??= refresh().finally(() => {
      refreshing = undefined
    })
    return refreshing
  }
}

/** 1 s, doubling, then every 30 s for as long as the refresh keeps failing. */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt)
}

/**
 * How long attempt number `attempt` may take before it is given up: 10 s,
 * then 20 s, then 30 s from then on. Longer each time, so a link that is slow
 * but working — a token through a VPN on one bar — still gets one through,
 * rather than every attempt being abandoned just before it would have landed.
 */
export function attemptLimitMs(attempt: number): number {
  return Math.min(30_000, 10_000 * (attempt + 1))
}

/**
 * The browser's retry. With no network at all it doesn't ask Better Auth,
 * whose request would only fail. It tries again early when the network comes
 * back, or when the page is looked at again. That is usually the phone waking,
 * and whoever woke it is waiting for the page. Either one also gives up on a
 * request still in flight, and skips the pause after it, so the next attempt
 * goes at once.
 */
export function browserRefreshRetry(
  getSession: () => Promise<{
    data: unknown
    error: { status?: number } | null
  }>,
): RefreshRetry {
  let woken = false
  return {
    askSession: async () =>
      navigator.onLine ? readSessionAnswer(await getSession()) : 'unknown',
    pause: (attempt) => {
      if (woken) {
        woken = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        untilWokenOr(retryDelayMs(attempt), () => resolve())
      })
    },
    bound: <T>(request: Promise<T>, fallback: T, attempt: number) =>
      new Promise<T>((resolve) => {
        const stop = untilWokenOr(attemptLimitMs(attempt), (byWake) => {
          if (byWake) woken = true
          resolve(fallback)
        })
        request.then(
          (value) => {
            stop()
            resolve(value)
          },
          () => {
            stop()
            resolve(fallback)
          },
        )
      }),
  }
}

/**
 * Calls `onDone` after `ms`, or as soon as the network comes back or the page
 * is looked at again, saying which. The function it returns stops the wait
 * without calling `onDone`.
 */
function untilWokenOr(
  ms: number,
  onDone: (byWake: boolean) => void,
): () => void {
  const stop = () => {
    clearTimeout(timer)
    window.removeEventListener('online', onWake)
    document.removeEventListener('visibilitychange', onVisible)
  }
  const finish = (byWake: boolean) => {
    stop()
    onDone(byWake)
  }
  const onWake = () => finish(true)
  const onVisible = () => {
    if (document.visibilityState === 'visible') finish(true)
  }
  const timer = setTimeout(() => finish(false), ms)
  window.addEventListener('online', onWake)
  document.addEventListener('visibilitychange', onVisible)
  return stop
}
