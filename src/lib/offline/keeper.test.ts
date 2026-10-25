import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryObserver, hydrate } from '@tanstack/react-query'
import { ConvexError } from 'convex/values'
import { logConnection } from '#/lib/connectionLog'
import { GAP_MS, SOCKET_DOWN_MS } from '#/lib/reach'
import { rq } from '#/lib/routeQueries'
import { forgetRefusedQueries } from '#/lib/signInSettling'
import { QUIET_LINE_MS } from '#/lib/socketWatch'
import { KeepingConvexQueryClient } from './KeepingConvexQueryClient'
import { Keeper, lineDownAt, nextDownSince } from './keeper'
import {
  keepStartPage,
  keepStartPageIfMissing,
  purgeOtherBusinessPages,
} from './keptPages'
import {
  KEPT_FNS,
  KEPT_GRACE_MS,
  KEPT_SHAPE,
  KEPT_STAMP_MS,
  KEPT_TICK_MS,
  KEPT_UPGRADE_MARGIN_MS,
  KEPT_WRITE_DELAY_MS,
  RENDERED_AT_KEY,
} from './keptSet'
import { MemoryKeptBackend } from './keptStore.fixtures'
import { setKeptBackendForTests, wipeKept } from './keptStore'
import type { QueryKey, QueryState } from '@tanstack/react-query'
import type { ConvexReactClient } from 'convex/react'
import type { Access } from '#/lib/access'
import type { Id } from '../../../convex/_generated/dataModel'
import type * as KeptSet from './keptSet'
import type { KeptPeek, KeptRow } from './keptStore'

/**
 * The keeper of the copy kept on the phone: what answers from it, what
 * counts as live, what is written, the pins, refusals, and the line.
 *
 * Against a real QueryClient and the real adapter (as its subclass), with a
 * Convex client faked for the query function, the adapter's watches and the
 * connection, and the kept store in memory.
 */

// The adapter decides as it loads whether it is on the server, by looking
// for `window`: there it never watches anything, and a push is what makes
// an answer live.
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = new EventTarget()
})

const who = vi.hoisted((): { id: string | null } => ({ id: 'u1' }))
vi.mock('#/lib/rootState', () => ({ signedInUserId: () => who.id }))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))
vi.mock('./keptPages', () => ({
  keepStartPage: vi.fn(async () => {}),
  // As if the start page were kept already, unless a test says otherwise.
  keepStartPageIfMissing: vi.fn(async () => false),
  purgeOtherBusinessPages: vi.fn(async () => {}),
}))

const B = 'b1' as Id<'businesses'>
const B2 = 'b2' as Id<'businesses'>
const M1 = 'm1' as Id<'memberships'>
const BUSINESS = { _id: B, slug: 'pest-co', timezone: 'Australia/Perth' }
const LENS = 'm1|-'

/** Sunday 25 Oct 2026, 10am in Perth: the fortnight is 19 Oct to 1 Nov. */
const NOW = Date.UTC(2026, 9, 25, 2)
const TODAY = '2026-10-25'
const TOMORROW = '2026-10-26'

const own: Access = {
  membershipId: M1,
  role: 'owner',
  caps: {} as Access['caps'],
  actingAs: null,
  expiresAt: null,
  degraded: null,
  viewingAs: null,
}

const day = (dayKey: string, businessId = B) =>
  rq.day(businessId, dayKey).queryKey as QueryKey
const accessKey = (businessId = B) => rq.access(businessId).queryKey as QueryKey
const job = (id: string) => ({ _id: id, title: `Job ${id}` })

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }
type FakeWatch = {
  value: unknown
  error: unknown
  listeners: Set<() => void>
  fetches: Array<Pending>
}

/**
 * Just enough of the Convex client: the adapter's watches, the query
 * function's one-off fetches, and the connection, all moved on by hand.
 * `answer` is the server answering a query: the fetches waiting on it, and
 * a push to every watch. As the real client does (`ConvexReactClient.query`),
 * a fetch is answered at once from what it already holds, which outlives a
 * reconnect until the new connection's first answer replaces it all.
 */
class FakeConvex {
  connected = true
  count = 1
  paused = false
  lastMessageAt: number | null = Date.now()
  /** The sign-in token the socket has. */
  token: string | null = null
  asked: Array<string> = []
  // The connection the server last answered anything on.
  private answeredOn = 1
  private readonly subs = new Set<
    (s: { isWebSocketConnected: boolean; connectionCount: number }) => void
  >()
  private readonly watches = new Map<string, FakeWatch>()

  private watchOf(fn: unknown, args: unknown): FakeWatch {
    const id = `${String(fn)}|${JSON.stringify(args)}`
    let watch = this.watches.get(id)
    if (!watch) {
      watch = {
        value: undefined,
        error: undefined,
        listeners: new Set(),
        fetches: [],
      }
      this.watches.set(id, watch)
    }
    return watch
  }

  connectionState() {
    return {
      isWebSocketConnected: this.connected,
      connectionCount: this.count,
    }
  }

  subscribeToConnectionState(
    cb: (s: { isWebSocketConnected: boolean; connectionCount: number }) => void,
  ) {
    this.subs.add(cb)
    return () => {
      this.subs.delete(cb)
    }
  }

  lineState() {
    return {
      pausedForSignIn: this.paused,
      lastServerMessageAt: this.lastMessageAt,
    }
  }

  watchQuery(fn: string, args: unknown) {
    const watch = this.watchOf(fn, args)
    return {
      onUpdate: (cb: () => void) => {
        watch.listeners.add(cb)
        return () => {
          watch.listeners.delete(cb)
        }
      },
      localQueryResult: () => {
        if (watch.error !== undefined) throw watch.error
        return watch.value
      },
    }
  }

  currentToken() {
    return this.token
  }

  query(fn: string, args: unknown): Promise<unknown> {
    this.asked.push(fn)
    const watch = this.watchOf(fn, args)
    if (watch.error !== undefined) return Promise.reject(watch.error)
    if (watch.value !== undefined) return Promise.resolve(watch.value)
    return new Promise((resolve, reject) => {
      watch.fetches.push({ resolve, reject })
    })
  }

  /** The first answer on a new connection: what was held from the last
   * one goes, as the real client's first transition replaces it. */
  private newAnswers() {
    if (this.answeredOn === this.count) return
    this.answeredOn = this.count
    for (const watch of this.watches.values()) {
      watch.value = undefined
      watch.error = undefined
    }
  }

  answer(key: QueryKey, value: unknown) {
    this.newAnswers()
    const watch = this.watchOf(key[1], key[2])
    watch.value = value
    watch.error = undefined
    this.lastMessageAt = Date.now()
    for (const fetch of watch.fetches.splice(0)) fetch.resolve(value)
    for (const cb of [...watch.listeners]) cb()
  }

  refuse(key: QueryKey, error: unknown) {
    this.newAnswers()
    const watch = this.watchOf(key[1], key[2])
    watch.error = error
    this.lastMessageAt = Date.now()
    for (const fetch of watch.fetches.splice(0)) fetch.reject(error)
    for (const cb of [...watch.listeners]) cb()
  }

  /** A one-off fetch's answer alone, arriving late: no push with it. */
  answerFetches(key: QueryKey, value: unknown) {
    for (const fetch of this.watchOf(key[1], key[2]).fetches.splice(0)) {
      fetch.resolve(value)
    }
  }

  ping() {
    this.lastMessageAt = Date.now()
  }

  drop() {
    this.connected = false
    this.emit()
  }

  reconnect() {
    this.count++
    this.connected = true
    this.ping()
    this.emit()
  }

  private emit() {
    const state = this.connectionState()
    for (const cb of this.subs) cb(state)
  }
}

function successState(data: unknown, at: number): QueryState {
  return {
    data,
    dataUpdateCount: 1,
    dataUpdatedAt: at,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: false,
    status: 'success',
    fetchStatus: 'idle',
  }
}

/** A phone that already keeps u1's copy of B, own view, with `rows`. */
async function phoneKeeps(
  rows: Array<{
    key: QueryKey
    data: unknown
    savedAt?: number
    renderedAt?: number
  }>,
  liveAt = 0,
): Promise<MemoryKeptBackend> {
  const backend = new MemoryKeptBackend()
  const claim = await backend.claim({
    userId: 'u1',
    businessId: B,
    slug: 'pest-co',
    timezone: 'Australia/Perth',
    membershipId: M1,
    lens: LENS,
  })
  if (!claim) throw new Error('claim failed')
  const hash = new KeepingConvexQueryClient(
    new FakeConvex() as unknown as ConvexReactClient,
  ).hashFn()
  await backend.write(
    claim.epoch,
    'u1',
    rows.map(({ key, data, savedAt, renderedAt }): KeptRow => ({
      hash: hash(key),
      fn: key[1] as KeptRow['fn'],
      queryKey: key as KeptRow['queryKey'],
      businessId: B,
      lens: LENS,
      data,
      savedAt: savedAt ?? NOW - 3_600_000,
      ...(renderedAt === undefined ? {} : { renderedAt }),
      shape: KEPT_SHAPE,
      build: 'test',
    })),
    [],
  )
  if (liveAt) await backend.stamp(claim.epoch, 'u1', liveAt)
  backend.done = []
  return backend
}

const stops: Array<() => void> = []
const clients: Array<QueryClient> = []

/** The app's query client as root-provider.tsx builds it, kept. */
function harness(backend: MemoryKeptBackend = new MemoryKeptBackend()) {
  setKeptBackendForTests(backend)
  const convex = new FakeConvex()
  const keeper = new Keeper()
  const adapter = new KeepingConvexQueryClient(
    convex as unknown as ConvexReactClient,
    {},
    keeper,
  )
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: adapter.hashFn(),
        queryFn: keeper.wrap(adapter.queryFn()),
        gcTime: 15 * 60_000,
        retry: false,
      },
    },
  })
  for (const name of KEPT_FNS) {
    qc.setQueryDefaults(['convexQuery', name], { networkMode: 'offlineFirst' })
  }
  adapter.connect(qc)
  stops.push(keeper.attach(qc, convex))
  clients.push(qc)
  const hash = adapter.hashFn()
  return {
    convex,
    keeper,
    qc,
    backend,
    hash,
    /** An answer the page's HTML brought, from `at`. */
    html(key: QueryKey, data: unknown, at = Date.now() - 60_000) {
      hydrate(qc, {
        queries: [
          {
            queryKey: key,
            queryHash: hash(key),
            state: successState(data, at),
          },
        ],
        mutations: [],
      })
    },
    /** A page (or loader) asking for `key`. */
    ask(key: QueryKey) {
      void qc.prefetchQuery({ queryKey: key, staleTime: Infinity })
    },
    data: (key: QueryKey) => qc.getQueryData(key),
    row: (key: QueryKey) => backend.rows.get(hash(key)),
  }
}

/** Signed in, in B, with access:me live under the person's own view. */
async function claimed(h: ReturnType<typeof harness>, access = own) {
  h.html(accessKey(), access)
  h.keeper.enter(BUSINESS)
  h.convex.answer(accessKey(), access)
  await vi.advanceTimersByTimeAsync(10)
}

function page() {
  const doc: EventTarget & { visibilityState: DocumentVisibilityState } =
    Object.assign(new EventTarget(), { visibilityState: 'visible' as const })
  vi.stubGlobal('document', doc)
  return {
    show(on: boolean) {
      doc.visibilityState = on ? 'visible' : 'hidden'
      doc.dispatchEvent(new Event('visibilitychange'))
    },
  }
}

function goOffline() {
  vi.stubGlobal('navigator', { onLine: false })
  ;(window as unknown as EventTarget).dispatchEvent(new Event('offline'))
}

/** Something on screen showing each of `keys`. Returns the way to stop. */
function observe(h: ReturnType<typeof harness>, ...keys: Array<QueryKey>) {
  const watching = keys.map((queryKey) =>
    new QueryObserver(h.qc, { queryKey, staleTime: Infinity }).subscribe(
      () => {},
    ),
  )
  return () => {
    for (const stop of watching) stop()
  }
}

/** `ms` on a working line: the server's pings every few seconds. */
async function pinging(h: ReturnType<typeof harness>, ms: number) {
  for (let left = ms; left > 0; left -= 5_000) {
    await vi.advanceTimersByTimeAsync(Math.min(5_000, left))
    h.convex.ping()
  }
}

/** A sign-in token for `sub`, as far as anything here reads one. */
function tokenFor(sub: string): string {
  return `e30.${btoa(JSON.stringify({ sub }))}.sig`
}

const B2_BUSINESS = { _id: B2, slug: 'other-co', timezone: 'Australia/Perth' }
const roster = (businessId = B) => rq.roster(businessId).queryKey as QueryKey

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  })
  vi.setSystemTime(NOW)
  vi.stubGlobal('navigator', { onLine: true })
  page()
  who.id = 'u1'
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const qc of clients.splice(0)) qc.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('answering from the phone', () => {
  test('with no signal, the kept answer comes at once', async () => {
    const h = harness(await phoneKeeps([{ key: day(TODAY), data: [job('a')] }]))
    h.html(accessKey(), own)
    h.convex.connected = false
    goOffline()

    h.ask(day(TODAY))
    await vi.advanceTimersByTimeAsync(10)

    expect(h.data(day(TODAY))).toEqual([job('a')])
    expect(h.keeper.isLive(day(TODAY))).toBe(false)
    expect(h.keeper.asOf([day(TODAY)])).toBe(NOW - 3_600_000)
  })

  test(`on a working line the server gets ${KEPT_GRACE_MS} ms first, and wins inside it`, async () => {
    const h = harness(
      await phoneKeeps([
        { key: day(TODAY), data: [job('kept')] },
        { key: day(TOMORROW), data: [job('kept')] },
      ]),
    )
    h.html(accessKey(), own)

    h.ask(day(TODAY))
    await vi.advanceTimersByTimeAsync(KEPT_GRACE_MS / 2)
    expect(h.data(day(TODAY))).toBeUndefined()
    h.convex.answer(day(TODAY), [job('live')])
    await vi.advanceTimersByTimeAsync(KEPT_GRACE_MS)
    expect(h.data(day(TODAY))).toEqual([job('live')])
    expect(h.keeper.isLive(day(TODAY))).toBe(true)

    // A server slower than that: the phone's copy, then the server's push.
    h.ask(day(TOMORROW))
    await vi.advanceTimersByTimeAsync(KEPT_GRACE_MS + 10)
    expect(h.data(day(TOMORROW))).toEqual([job('kept')])
    h.convex.answer(day(TOMORROW), [job('live')])
    expect(h.data(day(TOMORROW))).toEqual([job('live')])
    expect(h.keeper.isLive(day(TOMORROW))).toBe(true)
  })

  test('with nothing kept, it waits for the server', async () => {
    const h = harness()
    h.html(accessKey(), own)
    h.convex.connected = false
    goOffline()

    h.ask(day(TODAY))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.qc.getQueryState(day(TODAY))?.status).toBe('pending')

    h.convex.reconnect()
    h.convex.answer(day(TODAY), [job('live')])
    await vi.advanceTimersByTimeAsync(10)
    expect(h.data(day(TODAY))).toEqual([job('live')])
  })

  test('nothing is served while signing out, or working in someone else’s account', async () => {
    const backend = await phoneKeeps([
      { key: day(TODAY), data: [job('a')] },
      { key: day(TOMORROW), data: [job('a')] },
    ])
    const h = harness(backend)
    h.convex.connected = false
    goOffline()

    h.html(accessKey(), {
      ...own,
      actingAs: { membershipId: 'm2' as Id<'memberships'>, name: 'Sam' },
    })
    h.ask(day(TODAY))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.data(day(TODAY))).toBeUndefined()

    h.html(accessKey(), own, Date.now())
    who.id = null
    h.ask(day(TOMORROW))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.data(day(TOMORROW))).toBeUndefined()
    expect(backend.wipes).toBe(0)
  })

  test('another person’s copy is never served, and goes', async () => {
    const backend = await phoneKeeps([{ key: day(TODAY), data: [job('a')] }])
    const h = harness(backend)
    h.html(accessKey(), own)
    goOffline()
    who.id = 'u2'

    h.ask(day(TODAY))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.data(day(TODAY))).toBeUndefined()
    expect(backend.wipes).toBe(1)
  })

  test('a sign-out during the server’s grace serves nothing from the phone', async () => {
    const h = harness(await phoneKeeps([{ key: day(TODAY), data: [job('a')] }]))
    h.html(accessKey(), own)
    h.ask(day(TODAY))
    await vi.advanceTimersByTimeAsync(KEPT_GRACE_MS / 2)
    who.id = null
    await vi.advanceTimersByTimeAsync(KEPT_GRACE_MS)
    expect(h.data(day(TODAY))).toBeUndefined()
  })

  test('a wipe that lands as the page load’s read comes back leaves nothing to serve', async () => {
    const backend = await phoneKeeps([{ key: day(TODAY), data: [job('a')] }])
    // Just after the read has answered, before the keeper has taken it in.
    vi.mocked(logConnection).mockImplementation((what) => {
      if (what === 'kept-peek') queueMicrotask(() => void wipeKept('test'))
    })
    try {
      const h = harness(backend)
      h.html(accessKey(), own)
      goOffline()
      h.ask(day(TODAY))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(h.data(day(TODAY))).toBeUndefined()
    } finally {
      vi.mocked(logConnection).mockImplementation(() => {})
    }
  })

  test('a function not kept is asked for as it always was', async () => {
    const h = harness(await phoneKeeps([{ key: day(TODAY), data: [] }]))
    h.html(accessKey(), own)
    goOffline()
    const month = rq.month(B, '2026-10').queryKey as QueryKey

    h.ask(month)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.convex.asked).toContain('jobs:listMonth')
    expect(h.qc.getQueryState(month)?.status).toBe('pending')
  })
})

describe('live, and what is written', () => {
  test('a fetch that lost the race to the phone is never taken as live', async () => {
    const h = harness(
      await phoneKeeps([{ key: day(TODAY), data: [job('kept')] }]),
    )
    h.html(accessKey(), own)
    goOffline()
    h.ask(day(TODAY))
    await vi.advanceTimersByTimeAsync(10)
    expect(h.data(day(TODAY))).toEqual([job('kept')])

    vi.stubGlobal('navigator', { onLine: true })
    h.convex.answerFetches(day(TODAY), [job('late')])
    await vi.advanceTimersByTimeAsync(10)
    expect(h.data(day(TODAY))).toEqual([job('kept')])
    expect(h.keeper.isLive(day(TODAY))).toBe(false)

    // Nor is a push that brought nothing (the adapter sets nothing then).
    h.convex.answer(day(TODAY), undefined)
    expect(h.data(day(TODAY))).toEqual([job('kept')])
    expect(h.keeper.isLive(day(TODAY))).toBe(false)

    // The push is what makes it live.
    h.convex.answer(day(TODAY), [job('live')])
    expect(h.data(day(TODAY))).toEqual([job('live')])
    expect(h.keeper.isLive(day(TODAY))).toBe(true)
    expect(h.keeper.asOf([day(TODAY)])).toBeNull()
  })

  test('a push that confirms the same answer still makes it live', async () => {
    const h = harness()
    h.html(day(TODAY), [job('a')])
    expect(h.keeper.isLive(day(TODAY))).toBe(false)
    h.convex.answer(day(TODAY), [job('a')])
    expect(h.keeper.isLive(day(TODAY))).toBe(true)
  })

  test('only live answers are written: never the phone’s, an upgrade’s or the HTML’s', async () => {
    const backend = await phoneKeeps([
      { key: day(TODAY), data: [job('kept')] },
      { key: day(TOMORROW), data: [job('kept')], savedAt: NOW - 600_000 },
    ])
    const h = harness(backend)
    h.html(day('2026-10-27'), [job('html')], NOW - 1_000_000)
    h.html(day(TOMORROW), [job('older')], NOW - 1_000_000)
    await claimed(h)
    await h.keeper.upgradeFromKept([day(TOMORROW)], 500)
    expect(h.data(day(TOMORROW))).toEqual([job('kept')])
    await vi.advanceTimersByTimeAsync(KEPT_GRACE_MS + 10)
    expect(h.data(day(TODAY))).toEqual([job('kept')])

    await vi.advanceTimersByTimeAsync(10_000)
    expect(backend.done).not.toContain('write')
    expect(h.row(day('2026-10-27'))).toBeUndefined()

    h.convex.answer(day(TODAY), [job('live')])
    await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
    expect(backend.done).toContain('write')
    expect(h.row(day(TODAY))?.data).toEqual([job('live')])
    expect(h.row(day(TODAY))?.savedAt).toBe(
      Date.now() - KEPT_WRITE_DELAY_MS - 10,
    )
    expect(h.row(day(TOMORROW))?.data).toEqual([job('kept')])
    expect(h.row(day('2026-10-27'))).toBeUndefined()
  })

  test('nothing is written while working in someone else’s account', async () => {
    const backend = new MemoryKeptBackend()
    const h = harness(backend)
    await claimed(h, {
      ...own,
      viewingAs: { membershipId: 'm2' as Id<'memberships'>, name: 'Sam' },
    })
    h.convex.answer(day(TODAY), [job('theirs')])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(backend.done).toEqual(['peek'])
    expect(backend.rows.size).toBe(0)
  })

  test('nothing is written for another business, or after a wipe', async () => {
    const backend = new MemoryKeptBackend()
    const h = harness(backend)
    await claimed(h)
    expect(backend.done).toContain('claim')

    h.html(day(TODAY, B2), [])
    h.convex.answer(day(TODAY, B2), [job('other')])
    await vi.advanceTimersByTimeAsync(10_000)
    expect([...backend.rows.values()].some((r) => r.businessId === B2)).toBe(
      false,
    )

    await wipeKept('test')
    h.convex.answer(day(TODAY), [job('after')])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(backend.rows.size).toBe(0)
    expect(backend.done.filter((op) => op === 'write')).toEqual([])
  })

  test('a change of view leaves live what it didn’t change, and writes it all under the new view', async () => {
    const backend = new MemoryKeptBackend()
    const h = harness(backend)
    await claimed(h, { ...own, view: { mode: 'everyone' } })
    h.convex.answer(day(TODAY), [job('everyone')])
    h.convex.answer(roster(), [])
    const shown = observe(h, day(TODAY), roster())
    await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
    expect(h.row(roster())?.lens).toBe('m1|everyone')
    vi.mocked(keepStartPage).mockClear()

    // "Just my jobs": access:me and the day change in the one transition.
    // The team is the same in both views, so the server sends it no more.
    h.convex.answer(accessKey(), { ...own, view: { mode: 'mine' } })
    h.convex.answer(day(TODAY), [job('mine')])
    await vi.advanceTimersByTimeAsync(10)
    expect(backend.owner?.lens).toBe('m1|mine')
    expect(h.keeper.isLive(roster())).toBe(true)

    // Nothing waits on a line that works, and all of it is written again.
    await pinging(h, 15_000)
    expect(h.keeper.keptWaiting()).toEqual([])
    expect(h.row(roster())).toMatchObject({ lens: 'm1|mine' })
    expect(h.row(day(TODAY))).toMatchObject({
      lens: 'm1|mine',
      data: [job('mine')],
    })
    // The start page, drawn again under the view now kept: a cold open with
    // no signal reads whose view it is from that page.
    expect(keepStartPage).toHaveBeenCalledWith('pest-co')
    shown()
  })

  test('back from someone else’s account, the start page is drawn again though the copy was already this view’s', async () => {
    const h = harness(await phoneKeeps([{ key: day(TODAY), data: [] }]))
    await claimed(h, {
      ...own,
      viewingAs: { membershipId: 'm2' as Id<'memberships'>, name: 'Sam' },
    })
    expect(keepStartPage).not.toHaveBeenCalled()

    h.convex.answer(accessKey(), own)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.backend.done).toContain('claim')
    expect(logConnection).not.toHaveBeenCalledWith(
      'kept-claim',
      expect.anything(),
    )
    expect(keepStartPage).toHaveBeenCalledWith('pest-co')
  })

  test('switching business in the app leaves the new one’s answers live, and writes them', async () => {
    const backend = new MemoryKeptBackend()
    const h = harness(backend)
    await claimed(h)

    // The switch's guard, prefetch and loader ask for the new business's
    // answers before its layout enters it, each through the query function,
    // each answered on its own.
    for (const key of [accessKey(B2), day(TODAY, B2), roster(B2)]) h.ask(key)
    await vi.advanceTimersByTimeAsync(10)
    h.convex.answer(accessKey(B2), {
      ...own,
      membershipId: 'm2' as Id<'memberships'>,
    })
    await vi.advanceTimersByTimeAsync(10)
    h.convex.answer(day(TODAY, B2), [job('b2')])
    await vi.advanceTimersByTimeAsync(10)
    h.convex.answer(roster(B2), [])
    await vi.advanceTimersByTimeAsync(10)
    const shown = observe(h, day(TODAY, B2), roster(B2))

    h.keeper.enter(B2_BUSINESS)
    await vi.advanceTimersByTimeAsync(10)
    expect(backend.owner).toMatchObject({ businessId: B2, lens: 'm2|-' })
    expect(h.keeper.isLive(day(TODAY, B2))).toBe(true)
    expect(h.keeper.isLive(roster(B2))).toBe(true)

    await pinging(h, 15_000)
    expect(h.keeper.keptWaiting()).toEqual([])
    expect(h.row(day(TODAY, B2))?.data).toEqual([job('b2')])
    expect(h.row(roster(B2))?.data).toEqual([])
    shown()
  })

  test('a claim for another business clears the copy, its pages and its answers', async () => {
    const backend = await phoneKeeps([{ key: day(TODAY), data: [job('a')] }])
    backend.owner = { ...backend.owner!, businessId: B2, slug: 'other-co' }
    const h = harness(backend)
    h.html(day(TODAY, B2), [job('other')])
    await claimed(h)

    expect(backend.rows.size).toBe(0)
    expect(backend.owner).toMatchObject({ businessId: B, slug: 'pest-co' })
    expect(h.data(day(TODAY, B2))).toBeUndefined()
    expect(logConnection).toHaveBeenCalledWith('kept-claim', {
      changed: 'business',
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(purgeOtherBusinessPages).toHaveBeenCalledWith('pest-co')
    expect(keepStartPage).toHaveBeenCalledWith('pest-co')
  })

  test('the first claim keeps this business’s start page, and drops another’s pages before IndexedDB answers', async () => {
    const h = harness()
    await claimed(h)
    expect(purgeOtherBusinessPages).toHaveBeenCalledWith('pest-co')
    expect(keepStartPageIfMissing).toHaveBeenCalledWith('pest-co')
    expect(logConnection).toHaveBeenCalledWith('kept-claim', {
      changed: 'user',
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(keepStartPage).toHaveBeenCalledWith('pest-co')
  })

  test('a claim of a copy already this one’s fetches the start page only if it is missing', async () => {
    const h = harness(await phoneKeeps([{ key: day(TODAY), data: [] }]))
    await claimed(h)
    expect(keepStartPageIfMissing).toHaveBeenCalledWith('pest-co')
    expect(keepStartPage).not.toHaveBeenCalled()
  })

  test('a claim IndexedDB fails, or never answers, still drops the other business’s pages', async () => {
    const failing = new MemoryKeptBackend()
    failing.unavailable = true
    await claimed(harness(failing))
    expect(purgeOtherBusinessPages).toHaveBeenCalledWith('pest-co')
    expect(keepStartPageIfMissing).toHaveBeenCalledWith('pest-co')
    expect(logConnection).toHaveBeenCalledWith('kept-write-failed', {
      why: 'claim',
    })

    vi.clearAllMocks()
    const hung = new MemoryKeptBackend()
    const claim = hung.claim.bind(hung)
    hung.claim = () => new Promise(() => {})
    const h = harness(hung)
    await claimed(h)
    expect(purgeOtherBusinessPages).toHaveBeenCalledWith('pest-co')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(logConnection).toHaveBeenCalledWith('kept-write-failed', {
      why: 'claim-late',
    })
    // And it holds up no claim after it.
    hung.claim = claim
    h.convex.reconnect()
    h.convex.answer(accessKey(), own)
    await vi.advanceTimersByTimeAsync(10)
    expect(hung.owner).toMatchObject({ userId: 'u1', lens: LENS })
  })

  test('nothing is claimed from the HTML’s access alone, so nothing is cleared with no signal', async () => {
    const backend = await phoneKeeps([{ key: day(TODAY), data: [job('a')] }])
    const h = harness(backend)
    h.convex.connected = false
    goOffline()
    h.html(accessKey(B2), own)
    h.keeper.enter(B2_BUSINESS)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(backend.done).toEqual(['peek'])
    expect(backend.rows.size).toBe(1)
    expect(purgeOtherBusinessPages).not.toHaveBeenCalled()
  })

  test('nothing is claimed or written under this person once the socket is someone else’s', async () => {
    const backend = new MemoryKeptBackend()
    const h = harness(backend)
    h.convex.token = tokenFor('u1')
    await claimed(h)
    expect(backend.owner).toMatchObject({ userId: 'u1', lens: LENS })
    backend.done = []

    // Someone else signs in in another tab, and this tab's next token comes
    // through their cookie. From that moment nothing more is written, even
    // before access:me says whose it is...
    h.convex.token = tokenFor('u2')
    h.convex.answer(day(TODAY), [job('theirs')])
    await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
    expect(backend.done).toEqual([])
    // ...and nothing is claimed for this person with their membership.
    h.convex.answer(accessKey(), {
      ...own,
      membershipId: 'm2' as Id<'memberships'>,
    })
    h.convex.answer(day(TODAY), [job('theirs too')])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(backend.done).toEqual([])
    expect(backend.owner).toMatchObject({ userId: 'u1', lens: LENS })
    expect(backend.rows.size).toBe(0)
  })

  test('a day outside the fortnight is not written, and one left behind is dropped at the next write', async () => {
    const backend = await phoneKeeps([
      { key: day('2026-10-12'), data: [job('last week')] },
    ])
    const h = harness(backend)
    await claimed(h)
    h.ask(day('2026-11-15'))
    await vi.advanceTimersByTimeAsync(10)
    h.convex.answer(day('2026-11-15'), [job('later')])
    h.convex.answer(day(TODAY), [job('a')])
    await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
    expect(h.row(day(TODAY))?.data).toEqual([job('a')])
    expect(h.row(day('2026-11-15'))).toBeUndefined()
    expect(h.row(day('2026-10-12'))).toBeUndefined()
  })

  test('a claim a wipe overtakes writes nothing after it', async () => {
    const backend = new MemoryKeptBackend()
    const claim = backend.claim.bind(backend)
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    backend.claim = async (next) => {
      await held
      return claim(next)
    }
    const h = harness(backend)
    await claimed(h)
    await wipeKept('test')
    release()
    await vi.advanceTimersByTimeAsync(10)
    h.convex.answer(day(TODAY), [job('a')])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(backend.done).not.toContain('write')
    expect(backend.rows.size).toBe(0)
  })

  test('a write a wipe overtakes is no failure: writing goes on under the next claim', async () => {
    const backend = new MemoryKeptBackend()
    const write = backend.write.bind(backend)
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    backend.write = async (...args) => {
      await held
      return write(...args)
    }
    const h = harness(backend)
    await claimed(h)
    h.convex.answer(day(TODAY), [job('a')])
    await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
    await wipeKept('test')
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(logConnection).not.toHaveBeenCalledWith(
      'kept-write-failed',
      expect.anything(),
    )

    backend.write = write
    h.convex.reconnect()
    h.convex.answer(accessKey(), own)
    h.convex.answer(day(TODAY), [job('b')])
    await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
    expect(h.row(day(TODAY))?.data).toEqual([job('b')])
  })

  test('a write a new claim overtakes is no failure either', async () => {
    const backend = new MemoryKeptBackend()
    const write = backend.write.bind(backend)
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    backend.write = async (...args) => {
      await held
      return write(...args)
    }
    const h = harness(backend)
    await claimed(h, { ...own, view: { mode: 'everyone' } })
    h.convex.answer(day(TODAY), [job('everyone')])
    await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
    // A change of view is claimed while that write is on its way.
    h.convex.answer(accessKey(), { ...own, view: { mode: 'mine' } })
    await vi.advanceTimersByTimeAsync(10)
    backend.write = write
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(logConnection).not.toHaveBeenCalledWith(
      'kept-write-failed',
      expect.anything(),
    )
    h.convex.answer(day(TODAY), [job('mine')])
    await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
    expect(h.row(day(TODAY))).toMatchObject({
      lens: 'm1|mine',
      data: [job('mine')],
    })
  })

  test('a failed write stops writing for the page load, and says so', async () => {
    const backend = new MemoryKeptBackend()
    const h = harness(backend)
    await claimed(h)
    backend.unavailable = true
    h.convex.answer(day(TODAY), [job('a')])
    await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
    expect(logConnection).toHaveBeenCalledWith('kept-write-failed', {
      why: 'write',
      n: 1,
    })
    backend.unavailable = false
    h.convex.answer(day(TODAY), [job('b')])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(backend.rows.size).toBe(0)
  })

  test('every pinned answer live: the phone notes when the server last spoke', async () => {
    const backend = new MemoryKeptBackend()
    const h = harness(backend)
    await claimed(h)
    const pinned = h.qc
      .getQueryCache()
      .getAll()
      .filter((q) =>
        (KEPT_FNS as ReadonlyArray<unknown>).includes(q.queryKey[1]),
      )
    expect(pinned).toHaveLength(19)
    for (const query of pinned) h.convex.answer(query.queryKey, [])
    await vi.advanceTimersByTimeAsync(KEPT_STAMP_MS - 5_000)
    h.convex.ping()
    const spoke = Date.now()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(backend.owner?.liveAt).toBe(spoke)
  })
})

describe('the stamp', () => {
  /** Claimed, with every pinned answer in and written. */
  async function allIn(h: ReturnType<typeof harness>, skip?: QueryKey) {
    await claimed(h)
    for (const query of h.qc.getQueryCache().getAll()) {
      if (!(KEPT_FNS as ReadonlyArray<unknown>).includes(query.queryKey[1])) {
        continue
      }
      if (skip && h.hash(skip) === query.queryHash) continue
      h.convex.answer(query.queryKey, [])
    }
  }

  test('not while a pinned answer has yet to come live', async () => {
    const backend = new MemoryKeptBackend()
    const h = harness(backend)
    await allIn(h, day(TOMORROW))
    await pinging(h, KEPT_STAMP_MS * 2)
    expect(backend.done).not.toContain('stamp')
    expect(backend.owner?.liveAt).toBe(0)
  })

  test('not while a change waits to be written, and once it is', async () => {
    const backend = new MemoryKeptBackend()
    const h = harness(backend)
    await allIn(h)
    await pinging(h, KEPT_STAMP_MS - 5_000)
    await vi.advanceTimersByTimeAsync(4_000)
    h.convex.answer(day(TODAY), [job('changed')])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.done).not.toContain('stamp')
    await pinging(h, KEPT_STAMP_MS)
    expect(backend.done).toContain('stamp')
    expect(h.row(day(TODAY))?.data).toEqual([job('changed')])
  })

  test('never a time no later than the one the phone already has', async () => {
    const backend = await phoneKeeps([], NOW + 3_600_000)
    const h = harness(backend)
    await allIn(h)
    await pinging(h, KEPT_STAMP_MS * 2)
    expect(backend.done).not.toContain('stamp')
  })
})

describe('liveness', () => {
  test('follows the connection: a new one is live only once it has pushed', async () => {
    const h = harness()
    h.html(day(TODAY), [])
    h.convex.answer(day(TODAY), [job('a')])
    expect(h.keeper.isLive(day(TODAY))).toBe(true)

    h.convex.drop()
    expect(h.keeper.isLive(day(TODAY))).toBe(false)
    h.convex.reconnect()
    expect(h.keeper.isLive(day(TODAY))).toBe(false)
    h.convex.answer(day(TODAY), [job('a')])
    expect(h.keeper.isLive(day(TODAY))).toBe(true)
  })

  test('an answer the query function gets is live once the server has pushed it on this connection', async () => {
    const h = harness()
    h.ask(accessKey())
    await vi.advanceTimersByTimeAsync(10)
    h.convex.answer(accessKey(), own)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.keeper.isLive(accessKey())).toBe(true)
  })

  test('an answer the Convex client still holds from the last connection is live only once this one pushes it', async () => {
    const h = harness()
    const month = rq.month(B, '2026-10').queryKey as QueryKey
    h.ask(day(TODAY))
    h.ask(month)
    await vi.advanceTimersByTimeAsync(10)
    h.convex.answer(day(TODAY), [job('a')])
    h.convex.answer(month, [])
    await vi.advanceTimersByTimeAsync(10)
    expect(h.keeper.isLive(day(TODAY))).toBe(true)
    expect(h.keeper.isLive(month)).toBe(true)

    // Dropped from memory while the line was down, and asked for again as it
    // comes back, before the new connection has sent anything.
    h.convex.drop()
    h.qc.removeQueries({ queryKey: day(TODAY), exact: true })
    h.qc.removeQueries({ queryKey: month, exact: true })
    h.convex.reconnect()
    h.ask(day(TODAY))
    h.ask(month)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.data(day(TODAY))).toEqual([job('a')])
    expect(h.keeper.isLive(day(TODAY))).toBe(false)
    expect(h.keeper.isLive(month)).toBe(false)

    // The new connection's first answers.
    h.convex.answer(day(TODAY), [job('a')])
    h.convex.answer(month, [])
    expect(h.keeper.isLive(day(TODAY))).toBe(true)
    expect(h.keeper.isLive(month)).toBe(true)
  })

  test('a line that has said nothing for a while is not live', async () => {
    const h = harness()
    h.html(day(TODAY), [])
    h.convex.answer(day(TODAY), [])
    await vi.advanceTimersByTimeAsync(QUIET_LINE_MS)
    expect(h.keeper.isLive(day(TODAY))).toBe(false)
    h.convex.ping()
    expect(h.keeper.isLive(day(TODAY))).toBe(true)
  })

  test('asOf is the server’s last word, not the end of a wait for a token', async () => {
    const h = harness()
    h.html(day(TODAY), [])
    h.convex.answer(day(TODAY), [job('a')])
    await vi.advanceTimersByTimeAsync(10_000)
    h.convex.ping()
    const lastWord = Date.now()
    h.convex.drop()

    // Held for a token, which then lands: nothing from the server.
    h.convex.paused = true
    await vi.advanceTimersByTimeAsync(15_000)
    h.convex.paused = false
    // The new connection has spoken since; that is not when the day was.
    h.convex.reconnect()
    expect(h.convex.lastMessageAt).not.toBe(lastWord)
    expect(h.keeper.asOf([day(TODAY)])).toBe(lastWord)

    // HTML answers are as old as the HTML says.
    h.html(day(TOMORROW), [], NOW - 5_000)
    expect(h.keeper.asOf([day(TODAY), day(TOMORROW)])).toBe(NOW - 5_000)
  })
})

describe('pins', () => {
  test('what is kept stays in memory, the HTML’s too', async () => {
    const h = harness()
    h.html(day(TODAY), [])
    h.keeper.enter(BUSINESS)
    for (const key of [
      day(TODAY),
      day('2026-11-01'),
      rq.directory(B).queryKey,
    ]) {
      expect(h.qc.getQueryDefaults(key).gcTime).toBe(Infinity)
    }
    expect(h.qc.getQueryCache().find({ queryKey: day(TODAY) })?.gcTime).toBe(
      Infinity,
    )
    // All nineteen asked for at once.
    await vi.advanceTimersByTimeAsync(10)
    expect(new Set(h.convex.asked)).toEqual(new Set(KEPT_FNS))
  })

  test('a refused answer forgotten before it had data is asked for again on the next connection', async () => {
    const h = harness()
    h.keeper.enter(BUSINESS)
    await vi.advanceTimersByTimeAsync(10)
    // Pushed as nobody, between two tokens, onto a day still loading.
    h.convex.refuse(day(TOMORROW), new ConvexError('Unauthenticated'))
    await vi.advanceTimersByTimeAsync(10)
    forgetRefusedQueries(h.qc)
    expect(h.qc.getQueryState(day(TOMORROW))).toBeUndefined()

    h.convex.reconnect()
    await vi.advanceTimersByTimeAsync(10)
    // Not asked yet: the Convex client would answer with the refusal it
    // still holds from the last connection, and it would be dropped again.
    expect(h.qc.getQueryState(day(TOMORROW))).toBeUndefined()
    // The new connection's first answers, which replace all of that.
    h.convex.answer(day(TODAY), [])
    await vi.advanceTimersByTimeAsync(10)
    expect(h.qc.getQueryState(day(TOMORROW))?.status).toBe('pending')
    h.convex.answer(day(TOMORROW), [job('a')])
    await vi.advanceTimersByTimeAsync(10)
    expect(h.data(day(TOMORROW))).toEqual([job('a')])
  })

  test('a new week moves the pins on, and lets the old days go once nothing shows them', async () => {
    // Sunday, a minute to midnight in Perth.
    vi.setSystemTime(Date.UTC(2026, 9, 25, 15, 59))
    const h = harness()
    h.keeper.enter(BUSINESS)
    await vi.advanceTimersByTimeAsync(10)
    const shown = new QueryObserver(h.qc, {
      queryKey: day('2026-10-20'),
      staleTime: Infinity,
    })
    const unsubscribe = shown.subscribe(() => {})

    await vi.advanceTimersByTimeAsync(KEPT_TICK_MS)
    expect(h.qc.getQueryDefaults(day('2026-11-08')).gcTime).toBe(Infinity)
    expect(h.qc.getQueryState(day('2026-11-08'))).toBeDefined()
    expect(h.qc.getQueryDefaults(day('2026-10-19')).gcTime).toBe(15 * 60_000)
    expect(h.qc.getQueryState(day('2026-10-19'))).toBeUndefined()
    expect(h.qc.getQueryState(day('2026-10-20'))).toBeDefined()

    unsubscribe()
    await vi.advanceTimersByTimeAsync(KEPT_TICK_MS)
    expect(h.qc.getQueryState(day('2026-10-20'))).toBeUndefined()
  })
})

describe('refusals and readability', () => {
  test('NO_ACCESS on access:me wipes what was kept of the business; Unauthenticated does not', async () => {
    const backend = await phoneKeeps([{ key: day(TODAY), data: [] }])
    const h = harness(backend)
    h.html(accessKey(), own)

    h.convex.refuse(accessKey(), new ConvexError('Unauthenticated'))
    await vi.advanceTimersByTimeAsync(10)
    expect(backend.wipes).toBe(0)

    h.convex.refuse(accessKey(), new ConvexError('NO_ACCESS'))
    await vi.advanceTimersByTimeAsync(10)
    expect(backend.wipes).toBe(1)
  })

  test('NO_ACCESS wipes the copy another tab has since kept for that business, whatever this tab claimed last', async () => {
    const backend = await phoneKeeps([{ key: day(TODAY), data: [] }])
    const h = harness(backend)
    h.html(accessKey(B2), own)
    await vi.advanceTimersByTimeAsync(10)

    // The copy is this business's, as this tab read it: another stays.
    h.convex.refuse(accessKey(B2), new ConvexError('NO_ACCESS'))
    await vi.advanceTimersByTimeAsync(10)
    expect(backend.wipes).toBe(0)

    // Another tab has since kept it for the business refused.
    backend.owner = { ...backend.owner!, businessId: B2, slug: 'other-co' }
    h.convex.refuse(accessKey(B2), new ConvexError('NO_ACCESS'))
    await vi.advanceTimersByTimeAsync(10)
    expect(backend.wipes).toBe(1)
  })

  test('readable while the copy is read, with a row, or with a line; not otherwise', async () => {
    const backend = await phoneKeeps([{ key: day(TODAY), data: [] }])
    let release = () => {}
    const slow = new Promise<void>((resolve) => (release = resolve))
    const peek = backend.peek.bind(backend)
    backend.peek = async (): Promise<KeptPeek | null> => {
      await slow
      return peek()
    }
    const h = harness(backend)
    h.html(accessKey(), own)
    goOffline()

    expect(h.keeper.readable(day(TOMORROW))).toBe(true)
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.keeper.readable(day(TODAY))).toBe(true)
    expect(h.keeper.readable(day(TOMORROW))).toBe(false)

    vi.stubGlobal('navigator', { onLine: true })
    expect(h.keeper.readable(day(TOMORROW))).toBe(true)
  })
})

describe('what the can’t-reach notice is told', () => {
  test('a kept answer on screen waits until the server confirms it; one refused, or not shown, does not', async () => {
    const savedAt = NOW - 2 * 3_600_000
    const h = harness(
      await phoneKeeps([
        { key: day(TODAY), data: [job('kept')], savedAt },
        { key: day(TOMORROW), data: [job('kept')], savedAt },
      ]),
    )
    h.html(accessKey(), own)
    h.convex.connected = false
    goOffline()
    const shown = new QueryObserver(h.qc, {
      queryKey: day(TODAY),
      staleTime: Infinity,
    })
    const unsubscribe = shown.subscribe(() => {})
    h.ask(day(TOMORROW))
    await vi.advanceTimersByTimeAsync(10)

    const today = h.hash(day(TODAY))
    expect(h.keeper.keptWaiting()).toEqual([today])
    expect(h.keeper.screenAsOf()).toBe(savedAt)

    vi.stubGlobal('navigator', { onLine: true })
    h.convex.reconnect()
    h.convex.refuse(day(TODAY), new ConvexError('Unauthenticated'))
    await vi.advanceTimersByTimeAsync(10)
    expect(h.keeper.keptWaiting()).toEqual([])

    h.convex.answer(day(TODAY), [job('live')])
    await vi.advanceTimersByTimeAsync(10)
    expect(h.keeper.keptWaiting()).toEqual([])
    expect(h.keeper.screenAsOf()).toBeNull()
    unsubscribe()
  })
})

describe('the HTML’s own time', () => {
  test('stays as it came, whatever is pushed since, for the note the server drew', () => {
    const h = harness()
    const at = NOW - 3_600_000
    h.html(day(TODAY), [job('a')], at)
    h.convex.answer(day(TODAY), [job('b')])
    expect(h.qc.getQueryState(day(TODAY))?.dataUpdatedAt).toBe(NOW)
    expect(h.keeper.htmlAsOf([day(TODAY), day(TOMORROW)])).toBe(at)
    expect(h.keeper.htmlAsOf([day(TOMORROW)])).toBeNull()
  })
})

describe('when a kept answer was written', () => {
  test('said only while the phone’s copy is the answer: not the HTML’s, nor the server’s', async () => {
    const savedAt = NOW - 15 * 3_600_000
    const h = harness(
      await phoneKeeps([{ key: day(TODAY), data: [job('kept')], savedAt }]),
    )
    h.html(accessKey(), own)
    h.html(day(TOMORROW), [job('html')])
    expect(h.keeper.keptSavedAt(day(TOMORROW))).toBeNull()

    h.convex.connected = false
    goOffline()
    h.ask(day(TODAY))
    await vi.advanceTimersByTimeAsync(10)
    expect(h.keeper.keptSavedAt(day(TODAY))).toBe(savedAt)

    vi.stubGlobal('navigator', { onLine: true })
    h.convex.reconnect()
    h.convex.answer(day(TODAY), [job('live')])
    expect(h.keeper.keptSavedAt(day(TODAY))).toBeNull()
  })
})

describe('upgrading what the HTML drew', () => {
  test('only within the time given, only when the copy differs and is clearly newer', async () => {
    const htmlAt = NOW - 3_600_000
    const later = htmlAt + KEPT_UPGRADE_MARGIN_MS + 60_000
    const backend = await phoneKeeps([
      { key: day(TODAY), data: [job('changed')], savedAt: later },
      { key: day(TOMORROW), data: [job('same')], savedAt: later },
      {
        key: day('2026-10-27'),
        data: [job('changed')],
        savedAt: htmlAt + 60_000,
      },
    ])
    const h = harness(backend)
    h.html(accessKey(), own)
    h.html(day(TODAY), [job('html')], htmlAt)
    h.html(day(TOMORROW), [job('same')], htmlAt)
    h.html(day('2026-10-27'), [job('html')], htmlAt)

    await h.keeper.upgradeFromKept(
      [day(TODAY), day(TOMORROW), day('2026-10-27')],
      500,
    )
    expect(h.data(day(TODAY))).toEqual([job('changed')])
    expect(h.qc.getQueryState(day(TODAY))?.dataUpdatedAt).toBe(later)
    expect(h.keeper.asOf([day(TODAY)])).toBe(later)
    expect(h.qc.getQueryState(day(TOMORROW))?.dataUpdatedAt).toBe(htmlAt)
    expect(h.data(day('2026-10-27'))).toEqual([job('html')])
  })

  test('the same answer, confirmed later on the phone, keeps its place but takes the copy’s time', async () => {
    // The HTML a service worker kept before a booking, the copy confirmed
    // live after it: the booked day is replaced, and the days the booking
    // didn't touch no longer hold the "Updated" note back at the HTML's time.
    const htmlAt = NOW - 3_600_000
    const later = htmlAt + KEPT_UPGRADE_MARGIN_MS + 60_000
    const backend = await phoneKeeps([
      { key: day(TODAY), data: [job('booked')], savedAt: later },
      { key: day(TOMORROW), data: [job('same')], savedAt: later },
      {
        key: day('2026-10-27'),
        data: [job('same')],
        savedAt: htmlAt + 60_000,
      },
    ])
    const h = harness(backend)
    h.html(accessKey(), own)
    h.html(day(TODAY), [], htmlAt)
    h.html(day(TOMORROW), [job('same')], htmlAt)
    h.html(day('2026-10-27'), [job('same')], htmlAt)
    const tomorrowData = h.data(day(TOMORROW))

    await h.keeper.upgradeFromKept([day(TODAY), day(TOMORROW)], 500)
    expect(h.data(day(TODAY))).toEqual([job('booked')])
    expect(h.data(day(TOMORROW))).toBe(tomorrowData)
    expect(h.qc.getQueryState(day(TOMORROW))?.dataUpdatedAt).toBe(htmlAt)
    expect(h.keeper.asOf([day(TODAY), day(TOMORROW)])).toBe(later)
    // Not within the clocks' margin, nor a day it wasn't asked about.
    await h.keeper.upgradeFromKept([day('2026-10-27')], 500)
    expect(h.keeper.asOf([day('2026-10-27')])).toBe(htmlAt)
    expect(h.keeper.keptSavedAt(day(TOMORROW))).toBeNull()
  })

  test('a copy written under this very page replaces its HTML however soon after, by when each page was drawn', async () => {
    // The app opened at `drawn`, a caller was booked a minute later, and the
    // phone locked before the copy was confirmed again: reopened with no
    // signal, on the page the service worker kept from that opening.
    const drawn = NOW - 3_600_000
    Reflect.set(window, RENDERED_AT_KEY, drawn)
    try {
      const backend = await phoneKeeps([
        {
          key: day(TODAY),
          data: [job('booked')],
          savedAt: drawn + 60_000,
          renderedAt: drawn,
        },
        // Under an earlier page, on a phone whose clock ran hours fast.
        {
          key: day(TOMORROW),
          data: [job('older')],
          savedAt: NOW + 3_600_000,
          renderedAt: drawn - 1,
        },
      ])
      const h = harness(backend)
      h.html(accessKey(), own, drawn)
      h.html(day(TODAY), [], drawn)
      h.html(day(TOMORROW), [job('html')], drawn)

      await h.keeper.upgradeFromKept([day(TODAY), day(TOMORROW)], 500)
      expect(h.data(day(TODAY))).toEqual([job('booked')])
      expect(h.data(day(TOMORROW))).toEqual([job('html')])
    } finally {
      Reflect.deleteProperty(window, RENDERED_AT_KEY)
    }
  })

  test('what a page load writes says when its page was drawn', async () => {
    const drawn = NOW - 60_000
    Reflect.set(window, RENDERED_AT_KEY, drawn)
    try {
      const h = harness(await phoneKeeps([]))
      await claimed(h)
      h.convex.answer(day(TODAY), [job('live')])
      await vi.advanceTimersByTimeAsync(KEPT_WRITE_DELAY_MS + 10)
      expect(h.row(day(TODAY))?.renderedAt).toBe(drawn)
    } finally {
      Reflect.deleteProperty(window, RENDERED_AT_KEY)
    }
  })

  test('a copy read too late changes nothing', async () => {
    const backend = await phoneKeeps([
      { key: day(TODAY), data: [job('changed')], savedAt: NOW },
    ])
    const peek = backend.peek.bind(backend)
    backend.peek = async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      return peek()
    }
    const h = harness(backend)
    h.html(accessKey(), own)
    h.html(day(TODAY), [job('html')], NOW - 3_600_000)

    const upgrading = h.keeper.upgradeFromKept([day(TODAY)], 500)
    await vi.advanceTimersByTimeAsync(1_000)
    await upgrading
    expect(h.data(day(TODAY))).toEqual([job('html')])
    expect(logConnection).toHaveBeenCalledWith('kept-upgrade', {
      n: 0,
      late: true,
    })
  })
})

describe('the line', () => {
  test('counts from when the socket was first seen down on screen', () => {
    const at = { now: 1_000, visible: true, connected: false }
    expect(nextDownSince(null, at)).toBe(1_000)
    expect(nextDownSince(400, at)).toBe(400)
    expect(
      nextDownSince(400, { now: 1_000, visible: true, connected: true }),
    ).toBeNull()
    expect(
      nextDownSince(400, { now: 1_000, visible: false, connected: false }),
    ).toBeNull()
  })

  test('is down after the socket’s 8 s, 20 s while held for a token, or at once with no signal', () => {
    expect(lineDownAt(false, 0, SOCKET_DOWN_MS - 1)).toBeNull()
    expect(lineDownAt(false, 0, SOCKET_DOWN_MS)).toBe('unreachable')
    expect(lineDownAt(false, 0, SOCKET_DOWN_MS, true)).toBeNull()
    expect(lineDownAt(false, 0, QUIET_LINE_MS, true)).toBe('unreachable')
    expect(lineDownAt(false, null, 60_000)).toBeNull()
    expect(lineDownAt(true, null, 0)).toBe('no-signal')
  })

  test('a socket that drops is unreachable after 8 s on screen, and up the moment it is back', async () => {
    const h = harness()
    const heard = vi.fn()
    h.keeper.subscribe(heard)
    h.convex.drop()
    await vi.advanceTimersByTimeAsync(SOCKET_DOWN_MS - 1_000)
    expect(h.keeper.downReason()).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.keeper.downReason()).toBe('unreachable')
    expect(h.keeper.lineDown()).toBe(true)
    expect(heard).toHaveBeenCalled()
    h.convex.reconnect()
    expect(h.keeper.lineDown()).toBe(false)
  })

  test('held for a sign-in token, it waits 20 s', async () => {
    const h = harness()
    h.convex.paused = true
    h.convex.drop()
    await vi.advanceTimersByTimeAsync(SOCKET_DOWN_MS + 1_000)
    expect(h.keeper.downReason()).toBeNull()
    await vi.advanceTimersByTimeAsync(QUIET_LINE_MS - SOCKET_DOWN_MS)
    expect(h.keeper.downReason()).toBe('unreachable')
  })

  test('only time on screen counts', async () => {
    const screen = page()
    const h = harness()
    h.convex.drop()
    await vi.advanceTimersByTimeAsync(SOCKET_DOWN_MS - 2_000)
    screen.show(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.keeper.downReason()).toBeNull()
    screen.show(true)
    await vi.advanceTimersByTimeAsync(SOCKET_DOWN_MS - 1_000)
    expect(h.keeper.downReason()).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.keeper.downReason()).toBe('unreachable')
  })

  test('a page frozen in between starts the 8 s again', async () => {
    const h = harness()
    h.convex.drop()
    // Frozen: the clock moves on, and the look due each second fires only
    // once the page thaws.
    vi.setSystemTime(Date.now() + SOCKET_DOWN_MS + GAP_MS + 1_000)
    expect(h.keeper.downReason()).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.keeper.downReason()).toBeNull()
    await vi.advanceTimersByTimeAsync(SOCKET_DOWN_MS - 1_000)
    expect(h.keeper.downReason()).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.keeper.downReason()).toBe('unreachable')
  })

  test('no signal says so whatever the socket is doing, and the line is not live', () => {
    const h = harness()
    expect(h.keeper.lineLive()).toBe(true)
    goOffline()
    expect(h.keeper.downReason()).toBe('no-signal')
    expect(h.keeper.lineLive()).toBe(false)
  })
})

describe('with the kill switch off', () => {
  test('nothing is read, served or written, and only what New Job is made of is pinned', async () => {
    const backend = await phoneKeeps([{ key: day(TODAY), data: [job('a')] }])
    vi.resetModules()
    vi.doMock('./keptSet', async (original) => ({
      ...(await original<typeof KeptSet>()),
      KEPT_ENABLED: false,
    }))
    try {
      const store = await import('./keptStore')
      const { Keeper: SwitchedOff } = await import('./keeper')
      store.setKeptBackendForTests(backend)
      const convex = new FakeConvex()
      const keeper = new SwitchedOff()
      const adapter = new KeepingConvexQueryClient(
        convex as unknown as ConvexReactClient,
        {},
        keeper,
      )
      const qc = new QueryClient({
        defaultOptions: {
          queries: {
            queryKeyHashFn: adapter.hashFn(),
            queryFn: keeper.wrap(adapter.queryFn()),
            retry: false,
          },
        },
      })
      adapter.connect(qc)
      stops.push(keeper.attach(qc, convex))
      clients.push(qc)
      hydrate(qc, {
        queries: [
          {
            queryKey: accessKey(),
            queryHash: adapter.hashFn()(accessKey()),
            state: successState(own, NOW - 60_000),
          },
        ],
        mutations: [],
      })

      keeper.enter(BUSINESS)
      await vi.advanceTimersByTimeAsync(10)
      expect(new Set(convex.asked)).toEqual(
        new Set([
          'clients:directory',
          'memberships:listForBusiness',
          'jobTypes:list',
        ]),
      )
      convex.answer(accessKey(), own)
      convex.answer(rq.directory(B).queryKey, { clients: [], sites: [] })
      await vi.advanceTimersByTimeAsync(10_000)

      convex.connected = false
      goOffline()
      void qc.prefetchQuery({ queryKey: day(TODAY), staleTime: Infinity })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(qc.getQueryData(day(TODAY))).toBeUndefined()
      expect(backend.done).toEqual([])
    } finally {
      vi.doUnmock('./keptSet')
      vi.resetModules()
    }
  })
})
