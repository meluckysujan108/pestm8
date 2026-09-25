import { ConvexReactClient } from 'convex/react'

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
 * that empty refetch, or a token the server rejects for good. Sending the
 * person to sign in is SessionWatch's job (__root.tsx), which follows Better
 * Auth, not the socket.
 */
export class HandoverConvexClient extends ConvexReactClient {
  private clearPending = false

  override clearAuth(): void {
    if (this.clearPending) return
    this.clearPending = true
    queueMicrotask(() => {
      if (!this.clearPending) return
      this.clearPending = false
      super.clearAuth()
    })
  }

  override setAuth(...args: Parameters<ConvexReactClient['setAuth']>): void {
    this.clearPending = false
    super.setAuth(...args)
  }
}
