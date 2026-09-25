import { afterEach, describe, expect, it } from 'vitest'
import { ConvexReactClient } from 'convex/react'
import { HandoverConvexClient } from './convexClient'

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
