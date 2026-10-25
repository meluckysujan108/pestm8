import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  QueryClient,
  QueryObserver,
  focusManager,
  keepPreviousData,
  onlineManager,
} from '@tanstack/react-query'
import { ConvexReactClient } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import type * as Adapter from '@convex-dev/react-query'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Why a Convex query is switched off with 'skip', never with `enabled`.
 *
 * @convex-dev/react-query subscribes over the socket as soon as a query
 * enters react-query's cache, which a disabled `useQuery` still does; the
 * only key it leaves alone is a 'skip'. `enabled: false` stops react-query's
 * own fetch, not that subscription. New report asked `jobs.get` for a job id
 * of "" each time it opened without a job, and prod logged every refusal
 * (25 Oct 2026). If an adapter upgrade makes the first test fail, `enabled`
 * has started to work and the 'skip's are a choice rather than a need.
 *
 * The rest is what the app's call sites lean on once they skip: a condition
 * turning on and off, the cache, and the two ways a skip can still be run.
 */

type Change = {
  type: string
  queryId: number
  udfPath?: string
  args?: Array<Record<string, unknown>>
}

/**
 * Just enough of a Convex server for the real client: it opens on the next
 * tick, records what it is asked, and answers each query with its own name —
 * except a job id of "", which it refuses as `jobs.get`'s validator does.
 */
class ServerSocket {
  static open: Array<ServerSocket> = []
  sent: Array<{
    type: string
    newVersion?: number
    modifications?: Array<Change>
  }> = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private version = { querySet: 0, identity: 0, ts: 0 }

  constructor(readonly url: string) {
    ServerSocket.open.push(this)
    setTimeout(() => this.onopen?.({}), 0)
  }

  send(data: string) {
    const message = JSON.parse(data) as (typeof this.sent)[number]
    this.sent.push(message)
    if (message.type !== 'ModifyQuerySet') return
    const startVersion = this.wireVersion()
    this.version.querySet = message.newVersion ?? this.version.querySet
    this.version.ts++
    const answers = (message.modifications ?? [])
      .filter((change) => change.type === 'Add')
      .map(({ queryId, udfPath, args }) =>
        args?.[0]?.jobId === ''
          ? {
              type: 'QueryFailed',
              queryId,
              errorMessage:
                'ArgumentValidationError: Value does not match validator.',
              logLines: [],
              journal: null,
            }
          : {
              type: 'QueryUpdated',
              queryId,
              value: { answer: udfPath },
              logLines: [],
              journal: null,
            },
      )
    this.answer({
      type: 'Transition',
      startVersion,
      endVersion: this.wireVersion(),
      modifications: answers,
    })
  }

  close() {
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0)
  }

  /** Every query the server was asked to run, with its arguments. */
  asked() {
    return this.changes('Add').map(({ udfPath, args }) => ({ udfPath, args }))
  }

  /** The queries the client has since told the server to drop. */
  dropped() {
    const names = new Map(
      this.changes('Add').map(({ queryId, udfPath }) => [queryId, udfPath]),
    )
    return this.changes('Remove').map(({ queryId }) => names.get(queryId))
  }

  private changes(type: string) {
    return this.sent
      .flatMap((message) => message.modifications ?? [])
      .filter((change) => change.type === type)
  }

  private answer(message: object) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) }), 0)
  }

  private wireVersion() {
    const { querySet, identity, ts } = this.version
    return { querySet, identity, ts: u64(ts) }
  }
}

/** A u64 as the sync protocol sends one: eight little-endian bytes, base64. */
function u64(value: number) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true)
  return btoa(String.fromCharCode(...bytes))
}

let adapter: typeof Adapter

beforeAll(async () => {
  // The adapter decides once, as it loads, whether it is on the server —
  // where it never subscribes — by looking for `window`. Only it sees one:
  // the Convex client below runs as it does in convexClient.test.ts.
  vi.stubGlobal('window', globalThis)
  adapter = await import('@convex-dev/react-query')
  vi.unstubAllGlobals()
})

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
const server = () => ServerSocket.open.at(-1)!

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  ServerSocket.open = []
})

/** The app's wiring (root-provider.tsx), over the fake server. */
function connect() {
  const convex = new ConvexReactClient('https://happy-otter-123.convex.cloud', {
    webSocketConstructor: ServerSocket as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
  })
  const convexQueryClient = new adapter.ConvexQueryClient(convex)
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
        // The app's own retry would only slow the refusals below down.
        retry: false,
      },
    },
  })
  convexQueryClient.connect(queryClient)
  // A query that is never asked opens no socket; this one always is, so
  // every test has a server to read.
  mount(queryClient, adapter.convexQuery(api.access.me, { businessId }))
  cleanups.push(async () => {
    queryClient.clear()
    await convex.close()
  })
  return queryClient
}

/** What a mounted `useQuery` does with its options. */
function mount<TOptions extends { queryKey: ReadonlyArray<unknown> }>(
  queryClient: QueryClient,
  options: TOptions,
) {
  const observer = new QueryObserver(queryClient, options)
  cleanups.push(async () => observer.destroy())
  observer.subscribe(() => {})
  return observer
}

/** What a render with new options does to that `useQuery`: one hook is
 * handed several queries' options over its life, as the app's are. */
function rerender<TOptions extends { queryKey: ReadonlyArray<unknown> }>(
  observer: QueryObserver,
  options: TOptions,
) {
  observer.setOptions(options)
}

const businessId = 'k57businessid' as Id<'businesses'>
const jobId = 'k57jobid' as Id<'jobs'>
const ME = { udfPath: 'access:me', args: [{ businessId }] }

/** New report's query, before and after the fix. */
const linkedJob = (linked: Id<'jobs'> | undefined) =>
  adapter.convexQuery(
    api.jobs.get,
    linked ? { businessId, jobId: linked } : 'skip',
  )

describe('switching a Convex query off', () => {
  it("with `enabled: false` still asks the server — New report's empty job id", async () => {
    const queryClient = connect()
    const observer = mount(queryClient, {
      ...adapter.convexQuery(api.jobs.get, {
        businessId,
        jobId: '' as Id<'jobs'>,
      }),
      enabled: false,
    })
    await settle()

    expect(server().asked()).toEqual([
      ME,
      { udfPath: 'jobs:get', args: [{ businessId, jobId: '' }] },
    ])
    // And the refusal lands on the query the page thought was switched off.
    expect(observer.getCurrentResult().error?.message).toMatch(
      /ArgumentValidationError/,
    )
  })

  it("with 'skip' asks nothing, and reads as no answer yet", async () => {
    const queryClient = connect()
    const observer = mount(queryClient, linkedJob(undefined))
    await settle()

    expect(server().asked()).toEqual([ME])
    expect(observer.getCurrentResult()).toMatchObject({
      data: undefined,
      error: null,
      fetchStatus: 'idle',
    })
  })
})

describe('a skipped query whose condition changes', () => {
  it('asks once when it turns on, and gets its answer', async () => {
    const queryClient = connect()
    const observer = mount(queryClient, linkedJob(undefined))
    await settle()

    rerender(observer, linkedJob(jobId))
    await settle()

    expect(server().asked()).toEqual([
      ME,
      { udfPath: 'jobs:get', args: [{ businessId, jobId }] },
    ])
    expect(observer.getCurrentResult().data).toEqual({ answer: 'jobs:get' })
  })

  it('reads as no answer at once when it turns off, and the server drops it after its gcTime', async () => {
    const queryClient = connect()
    // `lastAtProperty`'s shape, with 100 ms standing in for its minute.
    const lastVisit = (overview: boolean) => ({
      ...adapter.convexQuery(
        api.reports.lastAtProperty,
        overview
          ? { businessId, reportId: 'k57report' as Id<'reports'> }
          : 'skip',
      ),
      gcTime: 100,
    })
    const observer = mount(queryClient, lastVisit(true))
    await settle()
    expect(observer.getCurrentResult().data).toEqual({
      answer: 'reports:lastAtProperty',
    })

    rerender(observer, lastVisit(false))
    await settle()
    expect(observer.getCurrentResult().data).toBeUndefined()
    // Still held for its gcTime, so coming straight back costs nothing...
    expect(server().dropped()).toEqual([])

    await settle(150)
    // ...and then let go of, which `enabled: false` never did.
    expect(server().dropped()).toEqual(['reports:lastAtProperty'])
  })

  it('comes back from the cache, without asking again, when it turns on within its gcTime', async () => {
    const queryClient = connect()
    const observer = mount(queryClient, linkedJob(jobId))
    await settle()

    rerender(observer, linkedJob(undefined))
    await settle()
    rerender(observer, linkedJob(jobId))

    // At once: the answer is there on the same render that turns it back on.
    expect(observer.getCurrentResult().data).toEqual({ answer: 'jobs:get' })
    await settle()
    expect(server().asked()).toEqual([
      ME,
      { udfPath: 'jobs:get', args: [{ businessId, jobId }] },
    ])
  })

  it('keeps the last answer up under `keepPreviousData` — why TeamJoined checks canManage itself', async () => {
    const queryClient = connect()
    const joins = (canManage: boolean) => ({
      ...(canManage
        ? adapter.convexQuery(api.teamJoins.recent, { businessId, since: 0 })
        : adapter.convexQuery(api.teamJoins.recent, 'skip')),
      placeholderData: keepPreviousData,
    })
    const observer = mount(queryClient, joins(true))
    await settle()

    rerender(observer, joins(false))
    await settle()

    expect(observer.getCurrentResult()).toMatchObject({
      data: { answer: 'teamJoins:recent' },
      isPlaceholderData: true,
    })
  })
})

describe('a skipped query is never run', () => {
  it('by app-wide refetches, refocusing, or the signal coming back', async () => {
    const queryClient = connect()
    const observer = mount(queryClient, linkedJob(undefined))
    await settle()

    await queryClient.refetchQueries()
    await queryClient.invalidateQueries()
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await settle()

    expect(observer.getCurrentResult()).toMatchObject({
      status: 'pending',
      fetchStatus: 'idle',
      error: null,
    })
    expect(
      server()
        .asked()
        .filter((q) => q.udfPath !== 'access:me'),
    ).toEqual([])
    focusManager.setFocused(undefined)
  })

  it('with `enabled` kept beside it, as long as `enabled` repeats the condition', async () => {
    const queryClient = connect()
    // SignatureRow's shape.
    const savedSignature = (hydrated: boolean, ownSignature: boolean) => ({
      ...adapter.convexQuery(
        api.reports.mySavedSignature,
        ownSignature ? { businessId } : 'skip',
      ),
      enabled: hydrated && ownSignature,
    })
    // Hydrated, on someone else's slot.
    const observer = mount(queryClient, savedSignature(true, false))
    await settle()

    expect(observer.getCurrentResult()).toMatchObject({
      fetchStatus: 'idle',
      error: null,
    })
  })

  it('but is, and fails, if an `enabled` beside it says true — why those call sites repeat it', async () => {
    const queryClient = connect()
    const observer = mount(queryClient, {
      ...adapter.convexQuery(api.reports.mySavedSignature, 'skip'),
      enabled: true,
    })
    await settle()

    expect(observer.getCurrentResult().error?.message).toMatch(
      /Skipped query should not actually be run/,
    )
  })

  it('but is, and fails, if `refetch()` is called on it — which nothing changed here does', async () => {
    const queryClient = connect()
    const observer = mount(queryClient, linkedJob(undefined))
    await settle()

    const result = await observer.refetch()

    expect(result.error?.message).toMatch(
      /Skipped query should not actually be run/,
    )
  })
})
