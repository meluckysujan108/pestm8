import { ConvexReactClient } from 'convex/react'
import { getFunctionName } from 'convex/server'
import type { ConvexReactClientOptions } from 'convex/react'
import type { AuthTokenFetcher } from 'convex/browser'
import type {
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from 'convex/server'
import { APP_VERSION } from '#/lib/appVersion'
import { logConnection } from '#/lib/connectionLog'
import { isStandalone } from '#/lib/installPrompt'
import { expiryOfToken, issueOfToken } from '#/lib/jwt'
import { retryNow } from '#/lib/online'
import {
  MAX_PATIENCE,
  RESUME_GRACE_MS,
  WatchedSockets,
  judgeSocket,
} from '#/lib/socketWatch'
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
 *
 * That same page-load token is what every hand-over offers first, for the
 * life of the page: the hook's getter answers "no forced refresh" with it. On
 * a page served from the service worker's cache it had run out before the
 * page opened, so the server turned it down and the Convex client stopped the
 * socket to fetch a fresh one — and a hand-over landing during that fetch
 * left the socket stopped for good, every screen on "Loading…" until the app
 * was closed (16 Oct 2026; patches/convex@1.45.0.patch fixes that half, and
 * the test "a sign-in handed over while the socket is stopped for a fresh
 * token still reopens it" pins it). So a hand-over offers the freshest token
 * this page has been given instead, when that one runs out later: usually
 * the one the socket already has, which the server accepts. It is never for a
 * different person than the stale one would have been: every sign-in and
 * sign-out here ends in a full page load, except the join page's, where the
 * stale token is the person before's just the same — and the forced refresh
 * the Convex client runs after every hand-over fetches the new person's.
 *
 * Since 25 Oct 2026 a token that has already run out is never offered at all
 * (`preferFreshest`): the server would only turn it down, and the Convex
 * client would stop the socket, fetch another and open a new socket — a
 * second connection to the US from a phone in Perth. And in the browser it
 * watches the line itself (`watchSocket`, src/lib/socketWatch.ts): a socket
 * that died while the phone was busy elsewhere is given up within seconds of
 * the app coming back, not the minute the Convex client waits, and a token
 * about to run out is fetched as the app comes back rather than after the
 * server has refused it.
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
  // Of the tokens any sign-in's getter has answered with since the last clear
  // that went through, the one that runs out last.
  private freshest: { token: string; expiresAt: number } | undefined
  // The last token handed to the Convex client, since that clear.
  private handedOut: string | undefined
  // The current sign-in's forced refresh, for fetching one early
  // (`fetchEarly`), and what that fetched, until the client asks for it.
  private refreshEarly: (() => Promise<string | null | undefined>) | undefined
  private early: { token: string; at: number } | 'fetching' | undefined
  // Token fetches the Convex client holds the socket paused for: a line must
  // never be given up then, since reconnecting unpauses it (`whilePaused`).
  private paused = 0
  // Actions in flight that must not be cut off (`action`).
  private unsafeActions = 0
  // The line, as watched in the browser (`watchLine`).
  private readonly sockets: WatchedSockets | undefined
  private shownAt: number | null = null
  private hiddenAt: number | null = null
  private cameBackAt = 0
  private resumed = false
  private patience = 1
  private gaveUpAt: number | null = null
  private keptNoted: string | null = null
  private stopWatching: (() => void) | undefined

  constructor(
    address: string,
    {
      refreshRetry,
      holdForSignIn,
      watchSocket,
      ...options
    }: HandoverOptions = {},
  ) {
    const sockets = watchSocket ? new WatchedSockets() : undefined
    super(
      address,
      sockets
        ? {
            ...options,
            webSocketConstructor: sockets.wrap(
              options.webSocketConstructor ?? WebSocket,
            ),
          }
        : options,
    )
    this.refreshRetry = refreshRetry
    this.sockets = sockets
    if (holdForSignIn) this.holdForSignIn()
    if (sockets) this.watchLine()
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
      this.whilePaused(async (args) =>
        (signIn ??= await known).fetchToken(args),
      ),
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
      this.freshest = undefined
      this.handedOut = undefined
      this.refreshEarly = undefined
      this.early = undefined
      super.clearAuth()
    })
  }

  override setAuth(
    ...[getToken, onChange, onRefreshChange]: Parameters<
      ConvexReactClient['setAuth']
    >
  ): void {
    this.clearPending = false
    const generation = ++this.authGeneration
    const isCurrent = () => generation === this.authGeneration
    const fresh = this.preferFreshest(getToken)
    const retrying = this.refreshRetry
      ? withRefreshRetry(fresh, this.refreshRetry, isCurrent)
      : fresh
    // Early fetches only where forced refreshes share one request, so the
    // client's own refresh joins an early one still in flight.
    this.refreshEarly = this.refreshRetry
      ? () => retrying({ forceRefreshToken: true })
      : undefined
    this.early = undefined
    const signIn: SignIn = {
      fetchToken: this.handOut(retrying, isCurrent),
      onChange:
        onChange &&
        ((isAuthenticated) => {
          if (!isAuthenticated) logConnection('signed-out')
          onChange(isAuthenticated)
        }),
      onRefreshChange,
    }
    const first = this.firstSignIn
    this.firstSignIn = undefined
    if (first) first(signIn)
    else {
      super.setAuth(
        this.whilePaused(signIn.fetchToken),
        signIn.onChange,
        onRefreshChange,
      )
    }
  }

  /**
   * What the Convex client is handed: `fetchToken`, remembering what it
   * answered with (the token the client now has), and answering a forced
   * refresh with one fetched early (`fetchEarly`) when there is one.
   */
  private handOut(
    fetchToken: AuthTokenFetcher,
    isCurrent: () => boolean,
  ): AuthTokenFetcher {
    return async (args) => {
      const asked = Date.now()
      // Only the current sign-in's: the Convex client drops a replaced
      // one's answer, and the early token with it.
      const early =
        args.forceRefreshToken && isCurrent() ? this.takeEarly() : null
      const token = early ?? (await fetchToken(args))
      if (token && isCurrent()) this.handedOut = token
      const ms = Date.now() - asked
      if (args.forceRefreshToken || ms >= 1_000) {
        logConnection('token', {
          forced: args.forceRefreshToken,
          ms,
          got: !token ? 'none' : early ? 'early' : 'token',
        })
      }
      return token
    }
  }

  /**
   * `fetchToken`, remembering every token it answers with, and answering
   * "no forced refresh" with the freshest one remembered when that runs out
   * later than its own (see the top of this class).
   *
   * A forced refresh never answers with the token the Convex client was last
   * handed. Better Auth mints the same string twice within one second — the
   * same claims, `iat` in whole seconds, no `jti`, a deterministic signature —
   * and the Convex client reads "the same token again" as one it cannot
   * refresh: after a confirmed token it schedules no more refreshes, so the
   * socket is stopped when that token runs out; after a refused one it signs
   * the socket out. Offering the freshest token at a hand-over made the first
   * of those likely: the refresh straight after it could land in the second
   * that token was minted. So it waits for the next second and asks again,
   * once, and keeps what it had if that comes back the same or empty.
   *
   * Nor does "no forced refresh" ever answer with a token that has run out.
   * A page the service worker served from its cache carries the token it was
   * rendered with, and after a phone has been away longer than a token lives
   * (15 minutes) that has run out. Offered, the server turns it down, and the
   * Convex client stops the socket, fetches another and opens a new socket.
   * Fetched straight away instead, the socket's first token is a good one.
   */
  private preferFreshest(fetchToken: AuthTokenFetcher): AuthTokenFetcher {
    return async (args) => {
      let token = await fetchToken(args)
      if (args.forceRefreshToken && token && token === this.handedOut) {
        const issuedAt = issueOfToken(token)
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            issuedAt === null
              ? 1_000
              : Math.min(
                  1_500,
                  Math.max(0, (issuedAt + 1) * 1_000 - Date.now()),
                ),
          ),
        )
        const again = await fetchToken(args)
        if (again) token = again
      }
      if (!token) return token
      token = this.remember(token, args.forceRefreshToken)
      if (!args.forceRefreshToken && hasRunOut(token)) {
        const issuedAt = issueOfToken(token)
        logConnection('stale-token', {
          age: issuedAt === null ? -1 : Date.now() - issuedAt * 1_000,
        })
        const fresh = await fetchToken({ forceRefreshToken: true }).catch(
          () => null,
        )
        if (fresh) token = this.remember(fresh, true)
      }
      return token
    }
  }

  /**
   * Keeps `token` as the freshest if it runs out last, and says which token
   * to answer with: the freshest, for "no forced refresh" when that runs out
   * later than `token` does.
   */
  private remember(token: string, forced: boolean): string {
    const expiresAt = expiryOfToken(token)
    const freshest = this.freshest
    if (
      expiresAt !== null &&
      freshest &&
      expiresAt < freshest.expiresAt &&
      !forced
    ) {
      return freshest.token
    }
    if (expiresAt !== null && (!freshest || expiresAt >= freshest.expiresAt)) {
      this.freshest = { token, expiresAt }
    }
    return token
  }

  /**
   * `fetchToken`, counted while the Convex client holds the socket paused
   * for it. It pauses for the first token of every sign-in it is handed —
   * and, when that comes back empty, for the forced refresh it asks for next —
   * and nothing it sends in between leaves the phone. Giving up the line then
   * would undo the pause: a new socket starts unpaused, and would ask for
   * every query as nobody, before the token. That is the "Not found" of
   * 26 Sept 2026 (`holdForSignIn`, PR #47).
   */
  private whilePaused(fetchToken: AuthTokenFetcher): AuthTokenFetcher {
    let settled = false
    return async (args) => {
      const pausing = !settled
      if (pausing) this.paused++
      try {
        const token = await fetchToken(args)
        if (token || args.forceRefreshToken) settled = true
        return token
      } finally {
        if (pausing) this.paused--
      }
    }
  }

  /**
   * Fetches a fresh token now, ahead of the Convex client, when the one it
   * has is about to run out (or has): as the app comes back on screen, and
   * as a dead line is given up, the socket is about to present its token,
   * and the Convex client's own refresh timer may not have run while the
   * phone slept. Fetched now, it is ready when the client asks for it — at
   * once if this is still in flight, since forced refreshes share one request
   * (lib/tokenRefresh.ts).
   */
  private fetchEarly(): void {
    const refresh = this.refreshEarly
    const expiresAt = expiryOfToken(this.handedOut)
    if (
      !refresh ||
      this.early === 'fetching' ||
      expiresAt === null ||
      expiresAt * 1_000 - Date.now() > EARLY_WITHIN_MS
    ) {
      return
    }
    const generation = this.authGeneration
    this.early = 'fetching'
    void refresh().then(
      (token) => {
        if (generation !== this.authGeneration) return
        this.early =
          token && token !== this.handedOut
            ? { token, at: Date.now() }
            : undefined
      },
      () => {
        if (generation === this.authGeneration) this.early = undefined
      },
    )
  }

  /**
   * The token `fetchEarly` fetched, once, if the Convex client has not been
   * handed it already and it is still good for a while.
   */
  private takeEarly(): string | null {
    const early = this.early
    if (typeof early !== 'object') return null
    this.early = undefined
    const expiresAt = expiryOfToken(early.token)
    return early.token !== this.handedOut &&
      Date.now() - early.at < EARLY_KEPT_MS &&
      expiresAt !== null &&
      expiresAt * 1_000 - Date.now() > EARLY_WITHIN_MS
      ? early.token
      : null
  }

  /**
   * Actions are counted while in flight, except the ones that only read
   * (`RETRY_SAFE_ACTIONS`). A line is never given up of its own accord while
   * one is out: the Convex client fails an action in flight when it
   * reconnects, as it must — it can't know whether the action ran — and a
   * report reported as not sent, though it went, gets sent twice.
   */
  override action<TAction extends FunctionReference<'action'>>(
    action: TAction,
    ...args: OptionalRestArgs<TAction>
  ): Promise<FunctionReturnType<TAction>> {
    if (RETRY_SAFE_ACTIONS.has(getFunctionName(action))) {
      return super.action(action, ...args)
    }
    this.unsafeActions++
    return super.action(action, ...args).finally(() => {
      this.unsafeActions--
    })
  }

  /**
   * Watches the line in the browser (src/lib/socketWatch.ts has the rules):
   * every couple of seconds, and a moment after the app comes back on screen
   * — told by the page becoming visible, by a page restored from the
   * browser's back-forward cache, or by a gap in this timer, since a phone
   * can freeze a page without saying it was hidden.
   *
   * Coming back, it also starts a token if the one the socket has is about
   * to run out. A socket that is already down is left to the Convex client,
   * whose overdue reconnect runs as the page wakes.
   */
  private watchLine(): void {
    const page = window
    const doc = document
    const visible = () => doc.visibilityState === 'visible'
    let lastTick = Date.now()
    this.shownAt = visible() ? lastTick : null
    logConnection('load', {
      v: APP_VERSION,
      standalone: isStandalone(),
      nav: navigationType(),
    })
    const onVisibility = () => {
      lastTick = Date.now()
      if (visible()) this.cameBack('shown')
      else {
        this.shownAt = null
        this.hiddenAt = Date.now()
        logConnection('hidden')
      }
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) this.cameBack('restored')
    }
    doc.addEventListener('visibilitychange', onVisibility)
    page.addEventListener('pageshow', onPageShow)
    const tick = setInterval(() => {
      const now = Date.now()
      const gap = now - lastTick
      lastTick = now
      if (!visible()) {
        this.shownAt = null
        return
      }
      if (gap > FROZEN_MS) this.cameBack('thawed', gap)
      else this.shownAt ??= now
      this.checkLine()
    }, TICK_MS)
    this.stopWatching = () => {
      clearInterval(tick)
      doc.removeEventListener('visibilitychange', onVisibility)
      page.removeEventListener('pageshow', onPageShow)
    }
  }

  override async close(): Promise<void> {
    this.stopWatching?.()
    this.stopWatching = undefined
    return super.close()
  }

  private cameBack(how: string, away?: number): void {
    const now = Date.now()
    // The page becoming visible and the timer's gap can both say so.
    if (now - this.cameBackAt < 1_000) return
    this.cameBackAt = now
    logConnection('shown', {
      how,
      away: away ?? (this.hiddenAt === null ? -1 : now - this.hiddenAt),
    })
    this.shownAt = now
    this.resumed = true
    this.fetchEarly()
    setTimeout(() => this.checkLine(), RESUME_GRACE_MS + 100)
  }

  /** Gives up the line if it is dead, and it is safe to. */
  private checkLine(): void {
    const socket = this.sockets?.current
    // Closed clients are not watched.
    if (!socket || !this.stopWatching) return
    const now = Date.now()
    const reading = socket.reading()
    // The socket after one given up has answered what it was asked: the
    // line works again, so the limits are back to normal.
    if (
      this.gaveUpAt !== null &&
      reading.askedAt === null &&
      (reading.heardAt ?? 0) > this.gaveUpAt
    ) {
      this.gaveUpAt = null
      this.patience = 1
    }
    const verdict = judgeSocket(reading, {
      now,
      shownAt: this.shownAt,
      resumed: this.resumed,
      patience: this.patience,
    })
    if (verdict === 'alive') {
      this.keptNoted = null
      return
    }
    const keptFor =
      this.paused > 0 ? 'signing-in' : this.unsafeActions > 0 ? 'sending' : null
    if (keptFor) {
      if (this.keptNoted !== keptFor) {
        logConnection('ws-kept', { why: verdict, for: keptFor })
      }
      this.keptNoted = keptFor
      return
    }
    this.keptNoted = null
    logConnection('ws-dead', {
      why: verdict,
      quiet: now - (reading.heardAt ?? reading.createdAt),
    })
    this.giveUp(socket, `PestM8: ${verdict}`)
  }

  private giveUp(
    socket: NonNullable<WatchedSockets['current']>,
    why: string,
  ): void {
    socket.giveUp(why)
    this.gaveUpAt = Date.now()
    this.patience = Math.min(this.patience * 2, MAX_PATIENCE)
    // The Convex client reconnects after its own short wait (a second, give
    // or take, after a line that had been working). Not hurried with an
    // `online` event, as Try again is: Better Auth hears that too and asks
    // who is signed in, and an answer racing a sign-in's change of session —
    // two-step set-up swaps it — can read as signed out.
    this.fetchEarly()
  }

  /**
   * Try again (components/shell/ConnectionNotice.tsx): a new line now, and
   * a token if one is due. Whatever is keeping the page waiting, a fresh
   * socket asks for everything again, and the person asked for it — so even
   * with an action in flight, which on a line this stuck the Convex client
   * would fail anyway when it finally noticed. Never while the socket is
   * paused for a token (`whilePaused`). Without a watched line, it does what
   * Try again always did: tells everything waiting on the network to go now.
   */
  reconnectNow(): void {
    logConnection('try')
    const socket = this.sockets?.current
    if (socket && socket.reading().state !== 'closed' && this.paused === 0) {
      logConnection('ws-dead', { why: 'try' })
      // Not counted towards the watch's patience: asking is not a sign that
      // lines here open and then carry nothing.
      socket.giveUp('PestM8: try again')
      this.gaveUpAt = Date.now()
    }
    retryNow()
    this.fetchEarly()
  }

  /**
   * The freshest token this page has that has not run out, for asking the
   * server something over HTTP rather than the socket
   * (components/shell/ConnectionDiagnostics.tsx). Null when it has none.
   */
  currentToken(): string | null {
    for (const token of [this.freshest?.token, this.handedOut]) {
      if (token && !hasRunOut(token)) return token
    }
    return null
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

/** Try again's `reconnectNow`, for whichever client the router was handed. */
export function reconnectNow(client: ConvexReactClient): void {
  if (client instanceof HandoverConvexClient) client.reconnectNow()
  else retryNow()
}

/** `currentToken`, for whichever client the router was handed. */
export function currentToken(client: ConvexReactClient): string | null {
  return client instanceof HandoverConvexClient ? client.currentToken() : null
}

/**
 * Actions that only read, and so can be cut off by a reconnect and asked
 * again: the weather, and a draft report's preview. Every other action is
 * waited for before a line is given up (`action`).
 */
const RETRY_SAFE_ACTIONS = new Set(['weather:forDays', 'reportPdf:preview'])

/** How soon before a token runs out it is fetched early (`fetchEarly`). */
const EARLY_WITHIN_MS = 2 * 60_000
/** How long a token fetched early is kept for the Convex client. */
const EARLY_KEPT_MS = 60_000
/** How often the line is checked. */
const TICK_MS = 2_000
/** A gap this long between checks means the page was frozen in between. */
const FROZEN_MS = 5_000

/** Whether a token has run out, or will in the next few seconds. */
function hasRunOut(token: string): boolean {
  const expiresAt = expiryOfToken(token)
  return expiresAt !== null && expiresAt * 1_000 <= Date.now() + 5_000
}

/** How this page load came about: 'navigate', 'reload' or 'back_forward'. */
function navigationType(): string {
  try {
    const entry = performance.getEntriesByType('navigation').at(0)
    return entry && 'type' in entry && typeof entry.type === 'string'
      ? entry.type
      : 'unknown'
  } catch {
    return 'unknown'
  }
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
  /** In the browser: see `watchLine`. */
  watchSocket?: boolean
}
