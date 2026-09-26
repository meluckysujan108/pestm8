import { ConvexReactClient } from 'convex/react'
import type { ConvexReactClientOptions } from 'convex/react'
import type { AuthTokenFetcher } from 'convex/browser'
import { withRefreshRetry } from '#/lib/tokenRefresh'
import type { RefreshRetry } from '#/lib/tokenRefresh'

/**
 * The browser's Convex client, which never signs the socket out between one
 * sign-in and the next.
 *
 * convex/react's `ConvexProviderWithAuth` re-authenticates whenever its auth
 * hook hands it a new `fetchAccessToken`, and @convex-dev/better-auth builds a
 * new one each time Better Auth's session id changes — which includes the
 * first /api/auth/get-session answer on EVERY page load, when the id goes from
 * undefined to the session's. The provider does it in two effects: the old
 * one's cleanup calls `clearAuth()`, then the new one calls `setAuth()`.
 *
 * The clear is sent at once, as an `Authenticate` with no token, and the token
 * follows a few microtasks later. The server re-runs every live query as
 * nobody in between, and when it answers before the token arrives (a slow
 * deployment, or get-session answering after the socket is already up), every
 * query on screen is told "Unauthenticated". The react-query ones keep their
 * data, because an error pushed onto an entry that has data does not throw.
 * But convex/react's `usePaginatedQuery` throws any error it gets, so the
 * Reports and Notes lists fell through to the route's "Something went wrong!".
 * e2e/signInHandover.spec.ts reproduces this.
 *
 * So `clearAuth()` waits until the end of the current task, and a `setAuth()`
 * in that same task cancels it. React runs one commit's effect cleanups and
 * then the new effects, synchronously, so that pair means one sign-in handing
 * over to the next. The server keeps the old token until the new one lands. A
 * clear with nothing after it still goes through, one microtask late: the
 * provider unmounting, or the socket of a page loaded signed out when its
 * sign-in ends.
 *
 * Signing out is a hand-over too, as far as this can tell. Once a page load
 * had a token from the server render, @convex-dev/better-auth 0.12.5 keeps
 * that token in its hook for the page's lifetime, so it reports "signed in"
 * even after the session ends. A sign-out, an expiry or an offboarding
 * arrives here as a clear followed by a set with that same token. Its clear
 * is dropped like any other. The stock client sent "nobody" and then that
 * token anyway, so it ends up where it did before:
 * - the server refuses what the token asks for, because the session behind
 *   it is gone;
 * - the next token refetch comes back empty, and the Convex client clears
 *   the socket itself.
 * The Convex client's own clears don't pass through here and happen at once:
 * that empty refetch, or a token the server rejects for good. Given
 * `refreshRetry`, a refetch comes back empty only when the session has really
 * ended: the token getter this is handed retries one that failed for want of
 * signal, or on a server hiccup (lib/tokenRefresh.ts). Sending the person to
 * sign in is SessionWatch's job (__root.tsx), which follows Better Auth, not
 * the socket.
 */
export class HandoverConvexClient extends ConvexReactClient {
  private clearPending = false
  // Moves on with every sign-in handed over and every clear that goes
  // through, so a refresh still retrying for an earlier one stops.
  private authGeneration = 0
  private readonly refreshRetry: RefreshRetry | undefined
  // While the page load's first sign-in is not yet known: what hands it over
  // (see `holdForSignIn`).
  private firstSignIn: ((signIn: SignIn) => void) | undefined

  constructor(
    address: string,
    { refreshRetry, holdForSignIn, ...options }: HandoverOptions = {},
  ) {
    super(address, options)
    this.refreshRetry = refreshRetry
    if (holdForSignIn) this.holdForSignIn()
  }

  /**
   * Keeps the socket from saying anything until this page load's first
   * sign-in is known: `setAuth` from ConvexBetterAuthProvider, or
   * `openSignedOut` for a page loaded signed out.
   *
   * Unheld, the socket spoke first. It opens as the server-rendered page
   * hydrates and asks for every query the server render handed over, and on
   * a slow phone it was open before the provider had mounted to send the
   * token. The server answered those queries as nobody, and the answers
   * replaced the server render's in the cache — `businesses.getBySlug`
   * became null, which `$businessSlug`'s guard reads as "Not found"
   * (e2e/socketSignIn.spec.ts).
   *
   * Held by a sign-in started here, before the socket has opened, whose
   * token waits for the first real one. The Convex client pauses the socket
   * while it waits for a token, and when it lands the socket opens as usual:
   * Connect, the token, then the queries. The first real sign-in completes
   * this one rather than starting another, which would pause the socket
   * again — after it had opened, that loses the Connect (convex's own
   * `expectAuth` does exactly that; see the test that says so) — and would
   * send the token twice.
   */
  private holdForSignIn(): void {
    let signIn: SignIn | undefined
    const known = new Promise<SignIn>((resolve) => {
      this.firstSignIn = resolve
    })
    super.setAuth(
      async (args) => (signIn ??= await known).fetchToken(args),
      (isAuthenticated) => signIn?.onChange?.(isAuthenticated),
      (isRefreshing) => signIn?.onRefreshChange?.(isRefreshing),
    )
  }

  override clearAuth(): void {
    if (this.clearPending) return
    this.clearPending = true
    queueMicrotask(() => {
      if (!this.clearPending) return
      this.clearPending = false
      this.authGeneration++
      super.clearAuth()
    })
  }

  override setAuth(
    ...[fetchToken, onChange, onRefreshChange]: Parameters<
      ConvexReactClient['setAuth']
    >
  ): void {
    this.clearPending = false
    const generation = ++this.authGeneration
    const signIn: SignIn = {
      fetchToken: this.refreshRetry
        ? withRefreshRetry(
            fetchToken,
            this.refreshRetry,
            () => generation === this.authGeneration,
          )
        : fetchToken,
      onChange,
      onRefreshChange,
    }
    const first = this.firstSignIn
    this.firstSignIn = undefined
    if (first) first(signIn)
    else super.setAuth(signIn.fetchToken, onChange, onRefreshChange)
  }

  /**
   * The first sign-in of a page loaded signed out: nobody. The socket opens
   * without a token, as it did before the hold, and someone who signs in
   * later without a page load (the join page) comes through `setAuth` as
   * usual. Not through `refreshRetry`, which would first ask Better Auth
   * whether anyone is signed in and, with no signal to ask, keep the socket
   * shut waiting for a token nobody has.
   */
  openSignedOut(): void {
    const first = this.firstSignIn
    this.firstSignIn = undefined
    first?.({ fetchToken: () => Promise.resolve(null) })
  }
}

/** `openSignedOut` for whichever client the router was handed. */
export function openSignedOut(client: ConvexReactClient): void {
  if (client instanceof HandoverConvexClient) client.openSignedOut()
}

type SignIn = {
  fetchToken: AuthTokenFetcher
  onChange?: (isAuthenticated: boolean) => void
  onRefreshChange?: (isRefreshing: boolean) => void
}

type HandoverOptions = ConvexReactClientOptions & {
  refreshRetry?: RefreshRetry
  /** In the browser: see `holdForSignIn`. */
  holdForSignIn?: boolean
}
