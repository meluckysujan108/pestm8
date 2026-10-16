import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConvexReactClient } from 'convex/react'
import { makeFunctionReference } from 'convex/server'
import { HandoverConvexClient, openSignedOut } from './convexClient'
import type { AuthTokenFetcher } from 'convex/browser'
import type { RefreshRetry, SessionAnswer } from './tokenRefresh'

/**
 * Just enough of a WebSocket for the real Convex client to run against: it
 * opens on the next tick and records every message the client sends, which
 * is exactly what the server would have been told.
 */
class RecordingSocket {
  static open: Array<RecordingSocket> = []
  sent: Array<{ type: string; tokenType?: string; value?: string }> = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {
    RecordingSocket.open.push(this)
    setTimeout(() => this.onopen?.({}), 0)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0)
  }

  /** What each Authenticate told the server: a token, or "nobody". */
  identities() {
    return this.sent
      .filter((message) => message.type === 'Authenticate')
      .map((message) =>
        message.tokenType === 'None' ? 'nobody' : message.value,
      )
  }
}

const URL = 'https://happy-otter-123.convex.cloud'
const clients: Array<ConvexReactClient> = []

function connect(Client: typeof ConvexReactClient) {
  const client = new Client(URL, {
    webSocketConstructor: RecordingSocket as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
  })
  clients.push(client)
  return client
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const socket = () => RecordingSocket.open.at(-1)!

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  RecordingSocket.open = []
})

/**
 * What convex/react's ConvexProviderWithAuth does when its auth hook hands it
 * a new token getter while signed in — the old effect's cleanup, then the new
 * effect, in one synchronous pass (ConvexAuthStateLastEffect's cleanup and
 * ConvexAuthStateFirstEffect in convex/react/ConvexAuthState).
 */
function handOver(client: ConvexReactClient, token: string) {
  client.clearAuth()
  client.setAuth(async () => token)
}

describe('HandoverConvexClient', () => {
  it('hands one sign-in to the next without telling the server "nobody"', async () => {
    const client = connect(HandoverConvexClient)
    client.setAuth(async () => 'token-1')
    await settle()
    expect(socket().identities()).toEqual(['token-1'])

    handOver(client, 'token-1')
    await settle()

    expect(socket().identities()).toEqual(['token-1', 'token-1'])
  })

  it('still signs the socket out when nothing takes over', async () => {
    const client = connect(HandoverConvexClient)
    client.setAuth(async () => 'token-1')
    await settle()

    client.clearAuth()
    await settle()

    expect(socket().identities()).toEqual(['token-1', 'nobody'])
  })

  it('does not let a clear left over from before a sign-in land after it', async () => {
    const client = connect(HandoverConvexClient)
    client.setAuth(async () => 'token-1')
    await settle()

    client.clearAuth()
    client.clearAuth()
    client.setAuth(async () => 'token-2')
    await settle()
    await settle()

    expect(socket().identities()).toEqual(['token-1', 'token-2'])
  })

  it('is needed: the stock client tells the server "nobody" mid-hand-over', async () => {
    // If a Convex upgrade ever stops doing this, HandoverConvexClient can go.
    const client = connect(ConvexReactClient)
    client.setAuth(async () => 'token-1')
    await settle()

    handOver(client, 'token-1')
    await settle()

    expect(socket().identities()).toEqual(['token-1', 'nobody', 'token-1'])
  })
})

/**
 * A RecordingSocket that also answers, like a server that accepts every
 * token. The Convex client only moves its auth on when the server confirms a
 * token. Then it asks for the refresh it wants after a page's first token, and
 * schedules the next one to land before that token expires. Every query it is
 * asked for is answered with null.
 */
class ServerSocket extends RecordingSocket {
  /** Tokens this server turns down, as it does one that has run out. */
  static expired = new Set<string>()

  private version = { querySet: 0, identity: 0, ts: 0 }
  // Once it has turned a token down, this socket answers nothing more: the
  // client stops it and opens another.
  private refused = false

  override send(data: string) {
    super.send(data)
    const message = JSON.parse(data) as {
      type: string
      newVersion?: number
      value?: string
      modifications?: Array<{ type: string; queryId: number }>
    }
    if (message.type !== 'Authenticate' && message.type !== 'ModifyQuerySet') {
      return
    }
    if (this.refused) return
    if (
      message.type === 'Authenticate' &&
      message.value !== undefined &&
      ServerSocket.expired.has(message.value)
    ) {
      this.refused = true
      this.answer({
        type: 'AuthError',
        error: 'Token expired',
        baseVersion: this.version.identity,
        authUpdateAttempted: true,
      })
      return
    }
    const startVersion = this.wireVersion()
    if (message.type === 'Authenticate') this.version.identity++
    else this.version.querySet = message.newVersion ?? this.version.querySet
    this.version.ts++
    this.answer({
      type: 'Transition',
      startVersion,
      endVersion: this.wireVersion(),
      modifications: (message.modifications ?? [])
        .filter((change) => change.type === 'Add')
        .map(({ queryId }) => ({
          type: 'QueryUpdated',
          queryId,
          value: null,
          logLines: [],
          journal: null,
        })),
    })
  }

  /** What the server tells a socket whose token has run out. */
  rejectToken() {
    this.answer({
      type: 'AuthError',
      error: 'Token expired',
      baseVersion: this.version.identity - 1,
      authUpdateAttempted: false,
    })
  }

  private answer(message: object) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) }), 0)
  }

  private wireVersion() {
    const { querySet, identity, ts } = this.version
    return { querySet, identity, ts: u64(ts) }
  }
}

const serverSocket = () => socket() as ServerSocket

/** A u64 as the sync protocol sends one: eight little-endian bytes, base64. */
function u64(value: number) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true)
  return btoa(String.fromCharCode(...bytes))
}

/**
 * With this leeway a token that lives a minute is refreshed 50 ms after the
 * server confirms it, and one that lives an hour is not refreshed during a
 * test.
 */
const LEEWAY_SECONDS = 59.95

/** A JWT the client can read a lifetime from; nothing checks the signature. */
function jwt(name: string, lifetimeSeconds: number) {
  const now = Math.floor(Date.now() / 1000)
  const part = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  return [
    part({ alg: 'none' }),
    part({ sub: name, iat: now, exp: now + lifetimeSeconds }),
    name,
  ].join('.')
}

const LOADED = jwt('loaded', 3_600)
const FRESH = jwt('fresh', 60)
const RENEWED = jwt('renewed', 3_600)

/**
 * The token getter @convex-dev/better-auth hands the client, scripted: the
 * token the page loaded with, then one answer per forced refresh. Its `null`
 * is what the real getter answers for no signal, a 5xx and a 401 alike.
 */
function tokens(loadedWith: string, refreshes: Array<string | null>) {
  let forced = 0
  return {
    forced: () => forced,
    fetchToken: async ({
      forceRefreshToken,
    }: {
      forceRefreshToken: boolean
    }) => {
      if (!forceRefreshToken) return loadedWith
      forced++
      if (refreshes.length === 0) throw new Error('an unscripted refresh')
      return refreshes.shift()!
    },
  }
}

/**
 * Better Auth's answers, scripted, and a pause that is over at once unless a
 * test holds it.
 */
function betterAuth(...answers: Array<SessionAnswer>) {
  const pauses: Array<number> = []
  let asked = 0
  let held: Promise<void> | undefined
  let release = () => {}
  const retry: RefreshRetry = {
    askSession: async () => {
      asked++
      return answers.shift() ?? 'signedIn'
    },
    pause: async (attempt) => {
      pauses.push(attempt)
      await held
    },
  }
  return {
    retry,
    pauses,
    asked: () => asked,
    hold() {
      held = new Promise((resolve) => (release = resolve))
    },
    release: () => release(),
  }
}

/** The app's client given a retry, or the stock one without. */
function connectToServer(refreshRetry?: RefreshRetry) {
  const options = {
    webSocketConstructor: ServerSocket as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
    authRefreshTokenLeewaySeconds: LEEWAY_SECONDS,
  }
  const client = refreshRetry
    ? new HandoverConvexClient(URL, { ...options, refreshRetry })
    : new ConvexReactClient(URL, options)
  clients.push(client)
  return client
}

/**
 * Signs in, and records each time the client reports the socket signed in or
 * out. It reports "in" again after every token the server confirms, so these
 * tests only ever look for an "out".
 */
function signIn(client: ConvexReactClient, fetchToken: AuthTokenFetcher) {
  const reported: Array<boolean> = []
  client.setAuth(fetchToken, (isAuthenticated) =>
    reported.push(isAuthenticated),
  )
  return reported
}

const everyIdentity = () =>
  RecordingSocket.open.flatMap((open) => open.identities())

describe('HandoverConvexClient, when a token refresh fails', () => {
  it('fetches again while the person is still signed in, and the socket keeps its sign-in', async () => {
    const auth = betterAuth('signedIn')
    const client = connectToServer(auth.retry)
    const script = tokens(LOADED, [FRESH, null, RENEWED])
    const reported = signIn(client, script.fetchToken)

    // The refresh scheduled for FRESH is the one that fails.
    await vi.waitFor(() =>
      expect(socket().identities()).toEqual([LOADED, FRESH, RENEWED]),
    )
    await settle()
    expect(script.forced()).toBe(3)
    expect(auth.asked()).toBe(1)
    expect(reported).not.toContain(false)
  })

  it('with no signal, keeps trying, waiting longer each time, until one gets through', async () => {
    const auth = betterAuth('unknown', 'unknown', 'unknown')
    const client = connectToServer(auth.retry)
    const script = tokens(LOADED, [FRESH, null, null, null, RENEWED])
    const reported = signIn(client, script.fetchToken)

    await vi.waitFor(() =>
      expect(socket().identities()).toEqual([LOADED, FRESH, RENEWED]),
    )
    expect(auth.pauses).toEqual([0, 1, 2])
    expect(reported).not.toContain(false)
  })

  it('signs the socket out when the session has really ended', async () => {
    const auth = betterAuth('signedOut')
    const client = connectToServer(auth.retry)
    const script = tokens(LOADED, [FRESH, null])
    const reported = signIn(client, script.fetchToken)

    await vi.waitFor(() =>
      expect(socket().identities()).toEqual([LOADED, FRESH, 'nobody']),
    )
    expect(auth.pauses).toEqual([])
    expect(reported.at(-1)).toBe(false)
  })

  it('a token the server rejects while the refresh is retrying waits for that same retry', async () => {
    // The phone slept through the refresh: by the time it has signal again,
    // the server has turned the old token down as well.
    const auth = betterAuth('unknown')
    auth.hold()
    const client = connectToServer(auth.retry)
    const script = tokens(LOADED, [FRESH, null, RENEWED])
    const reported = signIn(client, script.fetchToken)
    await vi.waitFor(() => expect(auth.pauses).toEqual([0]))

    serverSocket().rejectToken()
    await settle()
    auth.release()

    // The client restarts the socket it stopped, with the retry's token.
    await vi.waitFor(() => expect(RecordingSocket.open).toHaveLength(2))
    await vi.waitFor(() => expect(socket().identities()).toEqual([RENEWED]))
    await settle()
    expect(everyIdentity()).toEqual([LOADED, FRESH, RENEWED])
    expect(script.forced()).toBe(3)
    expect(reported).not.toContain(false)
  })

  it('a sign-in handed over while a refresh is retrying stops the old retry', async () => {
    const auth = betterAuth('signedIn')
    auth.hold()
    const client = connectToServer(auth.retry)
    const before = tokens(LOADED, [FRESH, null])
    signIn(client, before.fetchToken)
    await vi.waitFor(() => expect(auth.pauses).toEqual([0]))

    const NEXT = jwt('next', 3_600)
    const NEXT_RENEWED = jwt('next-renewed', 3_600)
    const after = tokens(NEXT, [NEXT_RENEWED])
    handOver(client, NEXT)
    client.setAuth(after.fetchToken)
    await vi.waitFor(() =>
      expect(socket().identities()).toEqual([
        LOADED,
        FRESH,
        NEXT,
        NEXT_RENEWED,
      ]),
    )

    auth.release()
    await settle()
    expect(before.forced()).toBe(2)
    expect(socket().identities()).toEqual([LOADED, FRESH, NEXT, NEXT_RENEWED])
  })

  it('is needed: the stock client signs the socket out for want of signal', async () => {
    const client = connectToServer()
    const script = tokens(LOADED, [FRESH, null])
    const reported = signIn(client, script.fetchToken)

    await vi.waitFor(() =>
      expect(socket().identities()).toEqual([LOADED, FRESH, 'nobody']),
    )
    expect(reported.at(-1)).toBe(false)
  })
})

/** Asks for a query, the way a server-rendered page's cache does on load. */
function subscribe(client: ConvexReactClient) {
  client
    .watchQuery(makeFunctionReference<'query'>('businesses:getBySlug'), {
      slug: 'acme',
    })
    .onUpdate(() => {})
}

/** What the socket sent, in order, by kind. */
const sentKinds = () =>
  socket().sent.map((message) =>
    message.type === 'Authenticate' && message.tokenType === 'None'
      ? 'nobody'
      : message.type,
  )

const socketOptions = {
  webSocketConstructor: RecordingSocket as unknown as typeof WebSocket,
  unsavedChangesWarning: false,
}

function connectHeld(refreshRetry?: RefreshRetry) {
  const client = new HandoverConvexClient(URL, {
    ...socketOptions,
    holdForSignIn: true,
    refreshRetry,
  })
  clients.push(client)
  return client
}

describe('HandoverConvexClient, held until the page load knows who it is for', () => {
  it('a signed-in page load tells the server who it is before asking for anything', async () => {
    const client = connectHeld(betterAuth().retry)
    subscribe(client)
    // Open, as on a slow phone, before the provider has mounted.
    await settle()
    expect(socket().sent).toEqual([])

    client.setAuth(async () => 'token-1')
    await settle()

    expect(sentKinds()).toEqual(['Connect', 'Authenticate', 'ModifyQuerySet'])
    expect(socket().identities()).toEqual(['token-1'])
  })

  it('is needed: unheld, the socket asks as nobody before the token arrives', async () => {
    const client = connect(ConvexReactClient)
    subscribe(client)
    await settle()

    client.setAuth(async () => 'token-1')
    await settle()

    expect(sentKinds()).toEqual(['Connect', 'ModifyQuerySet', 'Authenticate'])
  })

  it("is needed: convex's own expectAuth never sends Connect once the socket opened first", async () => {
    // If a Convex upgrade fixes this, expectAuth could hold the socket instead.
    const client = new ConvexReactClient(URL, {
      ...socketOptions,
      expectAuth: true,
    })
    clients.push(client)
    subscribe(client)
    await settle()

    client.setAuth(async () => 'token-1')
    await settle()

    expect(sentKinds()).toEqual(['Authenticate', 'ModifyQuerySet'])
  })

  it('a page loaded signed out lets the socket go with no token, without asking Better Auth', async () => {
    const auth = betterAuth('unknown')
    const client = connectHeld(auth.retry)
    subscribe(client)
    await settle()

    openSignedOut(client)
    await settle()

    expect(sentKinds()).toEqual(['Connect', 'ModifyQuerySet'])
    expect(auth.asked()).toBe(0)
  })

  it('someone who signs in after that still hands the socket their token', async () => {
    const client = connectHeld(betterAuth().retry)
    subscribe(client)
    openSignedOut(client)
    await settle()

    client.setAuth(async () => 'token-1')
    await settle()

    expect(socket().identities()).toEqual(['token-1'])
  })

  it("the first sign-in's token is the one refreshed, and its callbacks hear about it", async () => {
    const auth = betterAuth()
    const client = new HandoverConvexClient(URL, {
      webSocketConstructor: ServerSocket as unknown as typeof WebSocket,
      unsavedChangesWarning: false,
      authRefreshTokenLeewaySeconds: LEEWAY_SECONDS,
      holdForSignIn: true,
      refreshRetry: auth.retry,
    })
    clients.push(client)
    const script = tokens(LOADED, [FRESH, RENEWED])
    const reported = signIn(client, script.fetchToken)

    await vi.waitFor(() =>
      expect(socket().identities()).toEqual([LOADED, FRESH, RENEWED]),
    )
    expect(reported).toContain(true)
    expect(reported).not.toContain(false)
  })
})

/** A promise and the means to settle it, for holding a token fetch open. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

/** A query a page would have on screen, and whether it has an answer yet. */
function watch(client: ConvexReactClient) {
  const answered = { yes: false }
  client
    .watchQuery(makeFunctionReference<'query'>('views:options'), {})
    .onUpdate(() => (answered.yes = true))
  return answered
}

describe('HandoverConvexClient, when the token a page opened with has run out', () => {
  afterEach(() => ServerSocket.expired.clear())

  // A page served from the service worker's cache carries the token from
  // when it was rendered, and on a phone that had been away longer than a
  // token lives, it has run out. The server turns it down, and the Convex
  // client stops the socket while it fetches a fresh one. Better Auth's
  // first answer about the session lands in that window — later than the
  // refusal, on a slow link — and hands the sign-in over.
  const STALE = jwt('stale', -60)
  const FRESH_TOKEN = jwt('fresh', 3_600)

  /** The app's client as root-provider.tsx builds it, against a server. */
  function openPage() {
    ServerSocket.expired.add(STALE)
    const client = new HandoverConvexClient(URL, {
      webSocketConstructor: ServerSocket as unknown as typeof WebSocket,
      unsavedChangesWarning: false,
      holdForSignIn: true,
      refreshRetry: betterAuth().retry,
    })
    clients.push(client)
    return client
  }

  it('a sign-in handed over while the socket is stopped for a fresh token still reopens it', async () => {
    // Fails on convex 1.45.0 without patches/convex@1.45.0.patch: the socket
    // stays stopped, the query is never answered, and only a reload ends it.
    const client = openPage()
    const answered = watch(client)

    // Forced refreshes wait until the test lets them through; after that,
    // every one is answered, whenever it is asked.
    const forced: Array<ReturnType<typeof deferred<string | null>>> = []
    let through = false
    const fetcher =
      (): AuthTokenFetcher =>
      async ({ forceRefreshToken }) => {
        if (!forceRefreshToken) return STALE
        if (through) return FRESH_TOKEN
        const next = deferred<string | null>()
        forced.push(next)
        return next.promise
      }

    client.setAuth(fetcher())
    await vi.waitFor(() => expect(forced).toHaveLength(1))
    // The socket that presented the stale token is shut while it waits.
    expect(client.connectionState().isWebSocketConnected).toBe(false)

    handOver(client, STALE)
    client.setAuth(fetcher())
    await settle()
    through = true
    for (const fetch of forced) fetch.resolve(FRESH_TOKEN)

    const longer = { timeout: 5_000 }
    await vi.waitFor(
      () => expect(client.connectionState().isWebSocketConnected).toBe(true),
      longer,
    )
    await vi.waitFor(
      () => expect(socket().identities().at(-1)).toBe(FRESH_TOKEN),
      longer,
    )
    await vi.waitFor(() => expect(answered.yes).toBe(true), longer)
  })

  it('a sign-in handed over after the fresh token landed offers that one, not the run-out one', async () => {
    const client = openPage()
    const RENEWED_TOKEN = jwt('renewed', 3_600)
    client.setAuth(tokens(STALE, [FRESH_TOKEN]).fetchToken)
    await vi.waitFor(() =>
      expect(socket().identities().at(-1)).toBe(FRESH_TOKEN),
    )
    await settle()
    const sockets = RecordingSocket.open.length

    handOver(client, STALE)
    client.setAuth(tokens(STALE, [RENEWED_TOKEN]).fetchToken)
    await vi.waitFor(() =>
      expect(socket().identities().at(-1)).toBe(RENEWED_TOKEN),
    )

    // Nothing was turned down, so the socket was never stopped for it.
    expect(RecordingSocket.open).toHaveLength(sockets)
    expect(socket().identities()).toEqual([
      FRESH_TOKEN,
      FRESH_TOKEN,
      RENEWED_TOKEN,
    ])
  })

  it('a clear that goes through forgets the fresh token, so the next sign-in gets its own', async () => {
    const client = openPage()
    client.setAuth(tokens(STALE, [FRESH_TOKEN]).fetchToken)
    await vi.waitFor(() =>
      expect(socket().identities().at(-1)).toBe(FRESH_TOKEN),
    )

    client.clearAuth()
    await settle()
    const NEXT = jwt('next', 1_800)
    client.setAuth(tokens(NEXT, [jwt('next-renewed', 3_600)]).fetchToken)
    await vi.waitFor(() => expect(socket().identities()).toContain(NEXT))
  })

  it('a refresh answered with the very token the hand-over offered asks again the next second', async () => {
    // Better Auth mints the same string twice within a second. Taken as is,
    // the Convex client reads it as a token it can't refresh and schedules
    // no more refreshes, so the socket stops when it runs out.
    const client = openPage()
    client.setAuth(tokens(STALE, [FRESH_TOKEN]).fetchToken)
    await vi.waitFor(() =>
      expect(socket().identities().at(-1)).toBe(FRESH_TOKEN),
    )
    await settle()

    const RENEWED_TOKEN = jwt('renewed', 3_600)
    const after = tokens(STALE, [FRESH_TOKEN, RENEWED_TOKEN])
    handOver(client, STALE)
    client.setAuth(after.fetchToken)

    await vi.waitFor(
      () => expect(socket().identities().at(-1)).toBe(RENEWED_TOKEN),
      { timeout: 5_000 },
    )
    expect(after.forced()).toBe(2)
    expect(socket().identities()).toEqual([
      FRESH_TOKEN,
      FRESH_TOKEN,
      RENEWED_TOKEN,
    ])
  })
})

describe('HandoverConvexClient, when a refresh comes back with the same token', () => {
  it('asks again the next second, rather than leaving the socket with nothing scheduled', async () => {
    const client = connectToServer(betterAuth().retry)
    const SAME = jwt('same', 3_600)
    const RENEWED_TOKEN = jwt('renewed', 3_600)
    const script = tokens(SAME, [SAME, RENEWED_TOKEN])
    signIn(client, script.fetchToken)

    await vi.waitFor(
      () => expect(socket().identities()).toEqual([SAME, RENEWED_TOKEN]),
      { timeout: 5_000 },
    )
    expect(script.forced()).toBe(2)
  })
})
