import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, hashKey } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { ConvexError } from 'convex/values'
import { getFunctionName } from 'convex/server'
import { api } from '../../../convex/_generated/api'
import { logConnection } from '#/lib/connectionLog'
import { rq } from '#/lib/routeQueries'
import { flagIfTwoStepNeeded, isTwoStepNeeded } from '#/lib/twoStep'
import { FakeLockManager } from './fakeLocks.fixtures'
import { OutboxModel } from './outbox'
import { SEND_LOCK, itemLock, takeLock } from './outboxLocks'
import {
  ANSWER_WAIT_MS,
  EARLIER_STINT_MARGIN_MS,
  FIND_WAIT_MS,
  OUTBOX_TICK_MS,
  PAUSED_HOLD_MS,
  SENT_KEEP_MS,
  SETTLE_MIN_AGE_MS,
  STALE_AFTER_MS,
  STORE_OP_MS,
  SWITCH_WAIT_MS,
} from './outboxSet'
import {
  checkOutboxOwner,
  confirmStaleChange,
  setOutboxBackendForTests,
  writeSignOutTombstone,
} from './outboxStore'
import {
  B1,
  B2,
  bookingFor,
  itemFor,
  memoryStorage,
  outboxOf,
  personOf,
} from './outboxStore.fixtures'
import { Sender } from './sender'
import { duringSwitchStart, resetSwitchGateForTests } from './switchGate'
import type { QueryKey } from '@tanstack/react-query'
import type * as TwoStep from '#/lib/twoStep'
import type { Access } from '#/lib/access'
import type { Id } from '../../../convex/_generated/dataModel'
import type { OutboxChannel } from './outbox'
import type { OutboxItem } from './outboxItem'
import type { MemoryOutboxBackend } from './outboxStore.fixtures'
import type { SendOutcome, SenderDeps } from './sender'

/**
 * The sender: what goes, when, from which tab, and what each answer does.
 *
 * Against the outbox in memory (the same decisions IndexedDB makes), Web
 * Locks in memory shared by every tab of the phone, a real QueryClient for
 * access:me and the business list, and a Convex client and keeper faked:
 * each call and each find answered by hand.
 */

vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))
const who = vi.hoisted((): { id: string | null } => ({ id: 'u1' }))
const signedOutAfterAll = vi.hoisted(() => vi.fn(async () => false))
vi.mock('#/lib/rootState', () => ({
  signedInUserId: () => who.id,
  signedOutAfterAll,
}))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))
vi.mock('#/lib/twoStep', async (importOriginal) => ({
  ...(await importOriginal<typeof TwoStep>()),
  flagIfTwoStepNeeded: vi.fn(),
  isTwoStepNeeded: vi.fn(() => false),
}))

/** Tuesday 27 Oct 2026, 8am in Perth. */
const NOW = Date.UTC(2026, 9, 27, 0)
const M1 = 'm-u1' as Id<'memberships'>
const BUSINESS = { _id: B1, slug: 'pest-co', timezone: 'Australia/Perth' }

const own: Access = {
  membershipId: M1,
  role: 'subcontractor',
  caps: {} as Access['caps'],
  actingAs: null,
  expiresAt: null,
  degraded: null,
  viewingAs: null,
  lastRemovedAt: null,
}

const accessKey = (b: Id<'businesses'> = B1) =>
  rq.access(b).queryKey as QueryKey
const LIST_KEY = convexQuery(api.businesses.listForUser, {})
  .queryKey as QueryKey

type Call = {
  fn: string
  args: Record<string, unknown>
  /** The booking as the phone's storage had it when the call was made. */
  stored: OutboxItem | undefined
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}
type Watch = {
  fn: string
  args: Record<string, unknown>
  listeners: Set<() => void>
  value: unknown
  error: unknown
  stops: number
}

/** The Convex client: each call and each watch answered by hand. */
class FakeConvex {
  readonly calls: Array<Call> = []
  readonly watches: Array<Watch> = []
  readonly query = vi.fn(() => {
    throw new Error('the sender never asks query()')
  })

  constructor(private readonly backend: () => MemoryOutboxBackend) {}

  mutation(fn: Parameters<typeof getFunctionName>[0], args: object) {
    return new Promise((resolve, reject) => {
      const stored = [...this.backend().items.values()].find(
        (item) =>
          item.requestId ===
          (args as { clientRequestId?: string }).clientRequestId,
      )
      this.calls.push({
        fn: getFunctionName(fn),
        args: args as Record<string, unknown>,
        stored: stored && structuredClone(stored),
        resolve,
        reject,
      })
    })
  }

  watchQuery(fn: Parameters<typeof getFunctionName>[0], args: object) {
    const watch: Watch = {
      fn: getFunctionName(fn),
      args: args as Record<string, unknown>,
      listeners: new Set(),
      value: undefined,
      error: undefined,
      stops: 0,
    }
    this.watches.push(watch)
    return {
      onUpdate: (cb: () => void) => {
        watch.listeners.add(cb)
        return () => {
          watch.listeners.delete(cb)
          watch.stops++
        }
      },
      localQueryResult: () => {
        if (watch.error !== undefined) throw watch.error
        return watch.value
      },
    }
  }

  /** The finds still watching, for a kind. */
  open(kind?: string): Array<Watch> {
    return this.watches.filter(
      (w) =>
        w.listeners.size > 0 && (kind === undefined || w.args.kind === kind),
    )
  }

  answerFind(kind: string, value: unknown) {
    for (const watch of this.open(kind)) {
      watch.value = value
      for (const cb of [...watch.listeners]) cb()
    }
  }

  refuseFind(kind: string, error: unknown) {
    for (const watch of this.open(kind)) {
      watch.error = error
      for (const cb of [...watch.listeners]) cb()
    }
  }
}

/** The keeper, as far as the sender reads it. */
class FakeKeeper {
  live = true
  entered: typeof BUSINESS | null = BUSINESS
  socket: string | null = 'u1'
  conn = 1
  readonly liveKeys = new Set<string>()
  private readonly listeners = new Set<() => void>()
  lineLive = () => this.live
  isLive = (key: QueryKey) => this.liveKeys.has(hashKey(key))
  enteredBusiness = () => this.entered
  socketUserId = () => this.socket
  connection = () => this.conn
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  notify() {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Another tab's BroadcastChannel messages, by hand. */
function channel() {
  const made: { current: OutboxChannel | null } = { current: null }
  return {
    make: (): OutboxChannel => {
      made.current = {
        postMessage: vi.fn(),
        close: vi.fn(),
        onmessage: null,
      }
      return made.current
    },
    /** Another tab says it changed something. */
    fromAnotherTab: () =>
      made.current?.onmessage?.({ data: { changed: true } } as MessageEvent),
    get posted() {
      return vi.mocked(made.current?.postMessage ?? vi.fn()).mock.calls.length
    },
  }
}

const stops: Array<() => void> = []

/** Everything queued has run: the store, the locks, the kicks. */
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0)
}

/** A phone signed in as u1, in B1, with access:me live and `items` kept. */
async function phone(
  items: Array<OutboxItem> = [],
  opts: { locks?: FakeLockManager; tab?: string; access?: Access } = {},
) {
  const backend = await outboxOf('u1', items)
  setOutboxBackendForTests(backend)
  checkOutboxOwner(personOf('u1'))
  await flush(3)
  const locks = opts.locks ?? new FakeLockManager()
  const convex = new FakeConvex(() => backend)
  const keeper = new FakeKeeper()
  // As the app's: what something on screen shows is never dropped from
  // memory under it, as access:me and the business list never are.
  const qc = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  })
  qc.setQueryData(accessKey(), opts.access ?? own)
  keeper.liveKeys.add(hashKey(accessKey()))
  const model = new OutboxModel()
  const broadcast = channel()
  stops.push(model.start(broadcast.make))
  const sender = new Sender()
  stops.push(
    sender.attach({
      convex: convex as unknown as SenderDeps['convex'],
      qc,
      keeper,
      locks: locks.forTab(opts.tab ?? 'tab-a'),
      outbox: model,
    }),
  )
  await flush()
  return { backend, locks, convex, keeper, qc, model, sender, broadcast }
}

type Phone = Awaited<ReturnType<typeof phone>>

/** One of u1's, waiting, saved a minute ago. */
function waiting(extra: Partial<OutboxItem> = {}): OutboxItem {
  return itemFor('u1', extra, NOW - 60_000)
}

/** A Recurring Job of u1's, saved a minute ago, starting at `scheduledAt`. */
function series(scheduledAt: number, extra: Partial<OutboxItem> = {}) {
  return waiting({
    kind: 'series',
    booking: bookingFor({ scheduledAt, repeat: { count: 3, unit: 'month' } }),
    ...extra,
  })
}

/** One sent with no answer heard, `ago` ms back, as `kinds`. */
function unanswered(
  ago: number,
  kinds: Array<'job' | 'series'> = ['job'],
  extra: Partial<OutboxItem> = {},
): OutboxItem {
  return waiting({
    state: 'sending',
    attempts: 1,
    lastAttemptAt: Date.now() - ago,
    sentKinds: kinds,
    ...extra,
  })
}

const stored = (p: Phone, item: OutboxItem) => p.backend.items.get(item.localId)

function notes(event: string): Array<unknown> {
  return vi
    .mocked(logConnection)
    .mock.calls.filter(([what]) => what === event)
    .map(([, details]) => details)
}

/** access:me refused for this socket's person. */
function refuseAccess(p: Phone, code: string) {
  const query = p.qc.getQueryCache().build(p.qc, { queryKey: accessKey() })
  query.setState({
    ...query.state,
    status: 'error',
    error: new ConvexError(code),
    fetchStatus: 'idle',
  })
  p.keeper.liveKeys.delete(hashKey(accessKey()))
}

/** access:me pushed again on this connection, as `access`. */
function pushAccess(p: Phone, access: Access = own) {
  p.qc.setQueryData(accessKey(), { ...access })
  p.keeper.liveKeys.add(hashKey(accessKey()))
  p.keeper.notify()
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubGlobal('localStorage', memoryStorage())
  who.id = 'u1'
  vi.mocked(logConnection).mockClear()
  vi.mocked(flagIfTwoStepNeeded).mockClear()
  vi.mocked(isTwoStepNeeded).mockReturnValue(false)
  signedOutAfterAll.mockClear()
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  // One test's switch left starting never holds the next one's sends.
  resetSwitchGateForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('with nothing kept', () => {
  test('reads nothing more, calls nothing, watches nothing and sets no timer, whatever wakes it', async () => {
    const p = await phone()
    const done = [...p.backend.done]
    p.keeper.notify()
    p.keeper.conn++
    p.keeper.notify()
    p.sender.kick()
    await flush()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(p.convex.calls).toEqual([])
    expect(p.convex.watches).toEqual([])
    expect(p.convex.query).not.toHaveBeenCalled()
    // Nothing but reads, and nothing written.
    expect(p.backend.done.slice(done.length)).not.toContain('update')
    expect(p.backend.done).not.toContain('keep')
    expect(p.sender.inflight()).toBe(0)
    expect(p.sender.notice()).toBeNull()
  })
})

describe('a send', () => {
  test('marks it as going before the call, with its key and whose it is, and is sent once answered', async () => {
    const item = waiting()
    const p = await phone([item])
    expect(p.convex.calls).toHaveLength(1)
    const [call] = p.convex.calls
    expect(call.fn).toBe('jobs:create')
    expect(call.stored?.state).toBe('sending')
    expect(call.stored?.attempts).toBe(1)
    expect(call.args).toMatchObject({
      businessId: B1,
      propertyId: 'p1',
      clientRequestId: item.requestId,
      asMembership: M1,
    })
    expect(call.args).not.toHaveProperty('refuseBackfill')
    expect(p.sender.inflight()).toBe(1)

    call.resolve('job-1')
    await flush()
    expect(stored(p, item)).toMatchObject({
      state: 'sent',
      result: { id: 'job-1' },
      sentAt: NOW,
    })
    expect(p.sender.inflight()).toBe(0)
    expect(notes('outbox-sent')).toEqual([{ ms: 60_000, repeat: false }])
  })

  test('one call at a time in a tab: the next goes once the first is answered', async () => {
    const first = waiting()
    const second = itemFor('u1', {}, NOW - 30_000)
    const p = await phone([second, first])
    expect(p.convex.calls.map((c) => c.args.clientRequestId)).toEqual([
      first.requestId,
    ])
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(p.convex.calls.map((c) => c.args.clientRequestId)).toEqual([
      first.requestId,
      second.requestId,
    ])
  })

  test('a mark that fails makes no call, and says the storage isn’t answering', async () => {
    const item = waiting()
    const p = await phone()
    p.backend.update = () => Promise.resolve('error')
    p.backend.items.set(item.localId, structuredClone(item))
    p.broadcast.fromAnotherTab()
    await flush()
    await vi.advanceTimersByTimeAsync(2 * OUTBOX_TICK_MS)
    expect(p.convex.calls).toEqual([])
    expect(notes('outbox-store-failed')).toContainEqual({ op: 'beginSend' })
    expect(p.sender.storageNotAnswering()).toBe(true)
  })

  test(`nor one that never lands, given up after ${STORE_OP_MS / 1000} s`, async () => {
    const item = waiting()
    const p = await phone()
    p.backend.update = () => new Promise(() => {})
    p.backend.items.set(item.localId, structuredClone(item))
    p.broadcast.fromAnotherTab()
    await flush()
    await vi.advanceTimersByTimeAsync(STORE_OP_MS)
    expect(notes('outbox-store-failed')).toContainEqual({ op: 'beginSend' })
    await vi.advanceTimersByTimeAsync(2 * OUTBOX_TICK_MS)
    expect(p.convex.calls).toEqual([])
  })

  test('never called twice for one booking while its call is out, across reconnects included', async () => {
    const item = waiting()
    const p = await phone([item])
    for (let i = 0; i < 4; i++) {
      p.keeper.conn++
      p.keeper.notify()
      await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    }
    expect(p.convex.calls).toHaveLength(1)
  })

  test('a Recurring Job carries refuseBackfill only when its first visit was meant to be booked', async () => {
    // Saved a minute ago for an hour ago: its first visit is meant.
    const meant = series(NOW - 3_600_000)
    // Saved when it had already started three days before: booked as
    // online books it, from its next visit.
    const backdated = series(NOW - 3 * 86_400_000)
    const p = await phone([meant])
    expect(p.convex.calls[0].fn).toBe('recurrences:create')
    expect(p.convex.calls[0].args.refuseBackfill).toBe(true)
    expect(p.convex.calls[0].args).not.toHaveProperty('alsoGoing')

    const q = await phone([backdated])
    expect(q.convex.calls[0].args).not.toHaveProperty('refuseBackfill')
  })

  test('the booking as its mark read it goes: an Edit landed in another tab since the step read it', async () => {
    const item = waiting()
    const p = await phone()
    p.backend.items.set(item.localId, structuredClone(item))
    const realUpdate = p.backend.update.bind(p.backend)
    let edited = false
    p.backend.update = (epoch, localId, change) => {
      if (!edited) {
        edited = true
        // Another tab's Edit, booked just before this tab's mark.
        const row = p.backend.items.get(localId)
        if (row) row.booking = { ...row.booking, price: 25_000 }
      }
      return realUpdate(epoch, localId, change)
    }
    p.broadcast.fromAnotherTab()
    await flush()
    expect(p.convex.calls[0].args.price).toBe(25_000)
  })

  test('the send lock is let go as the call is answered: a switch starting never waits on the ask that follows a Recurring Job, which holds the booking’s own lock alone', async () => {
    const item = series(NOW + 86_400_000)
    const p = await phone([item])
    expect(p.locks.isHeld(SEND_LOCK)).toBe(true)
    p.convex.calls[0].resolve('rec-1')
    await flush()
    // Asking what it made, and no call out.
    expect(p.convex.open('series')).toHaveLength(1)
    expect(p.sender.inflight()).toBe(0)
    expect(p.locks.isHeld(SEND_LOCK)).toBe(false)
    expect(p.locks.isHeld(itemLock(item.localId))).toBe(true)
    const switching = await takeLock(p.locks.forTab('tab-b'), SEND_LOCK, {
      mode: 'exclusive',
      ifAvailable: true,
    })
    expect(switching).not.toBeNull()
    switching?.release()
    p.convex.answerFind('series', {
      kind: 'series',
      id: 'rec-1',
      firstJobId: 'job-9',
    })
    await flush()
    expect(p.locks.isHeld(itemLock(item.localId))).toBe(false)
  })

  test('the line gone as the answer comes: nothing is asked of a line that isn’t live', async () => {
    const item = series(NOW + 86_400_000)
    const p = await phone([item])
    p.keeper.live = false
    p.convex.calls[0].resolve('rec-1')
    await flush()
    expect(stored(p, item)?.state).toBe('sent')
    expect(p.convex.watches).toEqual([])
  })
})

describe('locks', () => {
  test('a booking another tab holds is passed over, and the others still go: a frozen tab blocks only its own', async () => {
    const frozen = waiting()
    const other = itemFor('u1', {}, NOW - 30_000)
    const locks = new FakeLockManager()
    // Another tab sent `frozen` and has been frozen with its call out.
    await takeLock(locks.forTab('tab-frozen'), itemLock(frozen.localId))
    const p = await phone([frozen, other], { locks })
    expect(p.convex.calls.map((c) => c.args.clientRequestId)).toEqual([
      other.requestId,
    ])
    expect(p.sender.sendingElsewhere(frozen.localId)).toBe(true)
    p.convex.calls[0].resolve('job-2')
    await vi.advanceTimersByTimeAsync(5 * OUTBOX_TICK_MS)
    expect(p.convex.calls).toHaveLength(1)
  })

  test('a booking is settled only by the tab holding its lock: never while another tab has it', async () => {
    const item = unanswered(SETTLE_MIN_AGE_MS + 1_000)
    const locks = new FakeLockManager()
    const elsewhere = await takeLock(
      locks.forTab('tab-b'),
      itemLock(item.localId),
    )
    const p = await phone([item], { locks })
    expect(p.convex.watches).toEqual([])
    elsewhere?.release()
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(p.convex.open('job')).toHaveLength(1)
  })

  test('an account switch starting in another tab stops new sends while it waits for the send lock, and while it holds it', async () => {
    const item = waiting()
    const locks = new FakeLockManager()
    // Another tab's send is out, and a switch in a third is waiting for it
    // (switchGate.ts asks for the send lock just so).
    const sending = await takeLock(locks.forTab('tab-b'), SEND_LOCK, {
      mode: 'shared',
    })
    const switching = takeLock(locks.forTab('tab-c'), SEND_LOCK, {
      mode: 'exclusive',
    })
    const p = await phone([item], { locks, tab: 'tab-a' })
    expect(p.convex.calls).toEqual([])
    expect(stored(p, item)?.state).toBe('waiting')
    // The other send done, the switch has the lock while it starts.
    sending?.release()
    const started = await switching
    await vi.advanceTimersByTimeAsync(SWITCH_WAIT_MS)
    expect(p.convex.calls).toEqual([])
    started?.release()
    await vi.advanceTimersByTimeAsync(SWITCH_WAIT_MS)
    expect(p.convex.calls).toHaveLength(1)
  })

  test('a switch starting in this tab between the check and the call: nothing goes, and it waits again', async () => {
    const item = waiting()
    const p = await phone()
    p.backend.items.set(item.localId, structuredClone(item))
    const realUpdate = p.backend.update.bind(p.backend)
    let finish: () => void = () => {}
    let starting: Promise<void> | null = null
    p.backend.update = (epoch, localId, change) => {
      // The switch is tapped while the mark is being written.
      starting ??= duringSwitchStart(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
        null,
      )
      return realUpdate(epoch, localId, change)
    }
    p.broadcast.fromAnotherTab()
    await flush()
    expect(p.convex.calls).toEqual([])
    expect(stored(p, item)?.state).toBe('waiting')
    finish()
    await starting
    await flush()
    expect(p.convex.calls).toHaveLength(1)
  })
})

describe('from the sheet', () => {
  test('sendHeld goes under the sheet’s lock, answers as soon as the server does, and lets the lock go only when the call has settled', async () => {
    const item = waiting()
    const p = await phone()
    // As the sheet does: its lock taken, then the booking kept.
    const lock = await takeLock(p.locks.forTab('tab-a'), itemLock(item.localId))
    p.backend.items.set(item.localId, structuredClone(item))
    await p.model.refresh()
    const outcome = p.sender.sendHeld(item.localId, lock!)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    expect(p.locks.isHeld(itemLock(item.localId))).toBe(true)
    p.convex.calls[0].resolve('job-1')
    expect(await outcome).toEqual({ outcome: 'sent', id: 'job-1' })
    await flush()
    expect(p.locks.isHeld(itemLock(item.localId))).toBe(false)
    expect(stored(p, item)?.state).toBe('sent')
  })

  test('a refusal that made nothing, with the sheet still open: the sheet’s to show, the booking needing a look until the sheet takes it off the phone', async () => {
    const item = waiting()
    const p = await phone()
    const lock = await takeLock(p.locks.forTab('tab-a'), itemLock(item.localId))
    p.backend.items.set(item.localId, structuredClone(item))
    await p.model.refresh()
    const handle = p.sender.watchAnswer(item.localId)
    const outcome = p.sender.sendHeld(item.localId, lock!)
    await flush()
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    p.convex.calls[0].reject(refusal)
    const heard = await outcome
    // Never deleted here: safe whatever the sheet does next (book.ts).
    const left = stored(p, item)
    expect(left).toMatchObject({
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
    expect(heard).toEqual({ outcome: 'refused', error: refusal, left })
    handle.release()
  })

  test('the sheet closed, then a refusal: it needs a look, and is never deleted (F1)', async () => {
    const item = waiting()
    const p = await phone()
    const lock = await takeLock(p.locks.forTab('tab-a'), itemLock(item.localId))
    p.backend.items.set(item.localId, structuredClone(item))
    await p.model.refresh()
    const handle = p.sender.watchAnswer(item.localId)
    const outcome = p.sender.sendHeld(item.localId, lock!)
    await flush()
    handle.release()
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    expect(await outcome).toEqual({ outcome: 'kept' })
    expect(stored(p, item)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
  })

  test('OUTBOX_PAUSED with the sheet open: held on the phone, for the sheet to take off it and send straight', async () => {
    const item = waiting()
    const p = await phone()
    const lock = await takeLock(p.locks.forTab('tab-a'), itemLock(item.localId))
    p.backend.items.set(item.localId, structuredClone(item))
    await p.model.refresh()
    const handle = p.sender.watchAnswer(item.localId)
    const outcome = p.sender.sendHeld(item.localId, lock!)
    await flush()
    const paused = new ConvexError('OUTBOX_PAUSED')
    p.convex.calls[0].reject(paused)
    const heard = await outcome
    const left = stored(p, item)
    expect(left).toMatchObject({
      state: 'waiting',
      holdUntil: NOW + PAUSED_HOLD_MS,
    })
    expect(heard).toEqual({ outcome: 'paused', error: paused, left })
    handle.release()
  })

  test('kept at once when a gate doesn’t hold, and the lock let go', async () => {
    const item = waiting()
    const p = await phone()
    p.keeper.live = false
    const lock = await takeLock(p.locks.forTab('tab-a'), itemLock(item.localId))
    p.backend.items.set(item.localId, structuredClone(item))
    await p.model.refresh()
    const outcome: SendOutcome = await p.sender.sendHeld(item.localId, lock!)
    expect(outcome).toEqual({ outcome: 'kept' })
    await flush()
    expect(p.convex.calls).toEqual([])
    expect(p.locks.isHeld(itemLock(item.localId))).toBe(false)
  })

  test.each([
    [
      'INVALID_ASSIGNEE',
      { state: 'needsLook', problem: { code: 'INVALID_ASSIGNEE' } },
    ],
    ['OUTBOX_PAUSED', { state: 'waiting', holdUntil: NOW + PAUSED_HOLD_MS }],
  ])(
    'the sender’s own send of one whose sheet still has its handle: %s keeps it, since nobody would hear of a delete',
    async (code, after) => {
      const item = waiting()
      const p = await phone([item])
      // The sheet kept it with no line, handed it to the sender, and is
      // still closing.
      const handle = p.sender.watchAnswer(item.localId)
      expect(p.convex.calls).toHaveLength(1)
      p.convex.calls[0].reject(new ConvexError(code))
      await flush()
      expect(stored(p, item)).toMatchObject(after)
      handle.release()
    },
  )

  test(`answers kept once ${ANSWER_WAIT_MS / 1000} s are up; a refusal after that needs a look, though the sheet has yet to let its handle go`, async () => {
    const item = waiting()
    const p = await phone()
    const lock = await takeLock(p.locks.forTab('tab-a'), itemLock(item.localId))
    p.backend.items.set(item.localId, structuredClone(item))
    await p.model.refresh()
    const handle = p.sender.watchAnswer(item.localId)
    const outcome = p.sender.sendHeld(item.localId, lock!)
    await flush()
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS)
    expect(await outcome).toEqual({ outcome: 'kept' })
    // The call is still out, under the sheet's lock.
    expect(p.locks.isHeld(itemLock(item.localId))).toBe(true)
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await flush()
    expect(stored(p, item)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
    expect(p.locks.isHeld(itemLock(item.localId))).toBe(false)
    handle.release()
  })

  test('a refusal in time is waited for until the phone has it as needing a look, however close to the end it came', async () => {
    const item = waiting()
    const p = await phone()
    const lock = await takeLock(p.locks.forTab('tab-a'), itemLock(item.localId))
    p.backend.items.set(item.localId, structuredClone(item))
    await p.model.refresh()
    const handle = p.sender.watchAnswer(item.localId)
    const outcome = p.sender.sendHeld(item.localId, lock!)
    let answered: SendOutcome | null = null
    void outcome.then((o) => {
      answered = o
    })
    await flush()
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 100)
    // Storage slow to write it.
    const realUpdate = p.backend.update.bind(p.backend)
    p.backend.update = (epoch, localId, change) =>
      new Promise((resolve) => setTimeout(resolve, 2_000)).then(() =>
        realUpdate(epoch, localId, change),
      )
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    p.convex.calls[0].reject(refusal)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(answered).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    const left = stored(p, item)
    expect(left).toMatchObject({ state: 'needsLook' })
    expect(answered).toEqual({ outcome: 'refused', error: refusal, left })
    handle.release()
  })
})

describe('the gates', () => {
  const held = async (
    set: (p: Phone) => void | Promise<unknown>,
    item = waiting(),
  ) => {
    const p = await phone()
    await set(p)
    p.backend.items.set(item.localId, structuredClone(item))
    p.broadcast.fromAnotherTab()
    await flush()
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    return { p, item }
  }

  test('G0: a booking a sign-out discarded never goes', async () => {
    const { p } = await held(() => writeSignOutTombstone('u1'))
    expect(p.convex.calls).toEqual([])
  })

  test('G1: only while its person is signed in on this page', async () => {
    const { p } = await held(() => {
      who.id = null
    })
    expect(p.convex.calls).toEqual([])
  })

  test('G2: never while the socket has someone else’s token; no token yet is no one else’s', async () => {
    const { p } = await held((q) => {
      q.keeper.socket = 'u2'
    })
    expect(p.convex.calls).toEqual([])
    p.keeper.socket = null
    p.keeper.notify()
    await flush()
    expect(p.convex.calls).toHaveLength(1)
  })

  test('G3: only in its own business; one for another waits until the person is back in it', async () => {
    const { p } = await held((q) => {
      q.keeper.entered = { ...BUSINESS, _id: B2 }
    })
    expect(p.convex.calls).toEqual([])
    p.keeper.entered = BUSINESS
    p.keeper.notify()
    await flush()
    expect(p.convex.calls).toHaveLength(1)
  })

  test('G4: only on a live line, which the 30 s tick finds came up quietly', async () => {
    const { p } = await held((q) => {
      q.keeper.live = false
    })
    expect(p.convex.calls).toEqual([])
    // Nothing says when a connected line goes quiet, or comes back.
    p.keeper.live = true
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(p.convex.calls).toHaveLength(1)
  })

  test.each([
    ['access:me not live', (p: Phone) => p.keeper.liveKeys.clear()],
    [
      'working in someone else’s account',
      (p: Phone) =>
        pushAccess(p, {
          ...own,
          actingAs: { membershipId: 'm-u2' as Id<'memberships'>, name: 'Jo' },
        }),
    ],
    [
      'a switch that ended for another reason than time (S7)',
      (p: Phone) => pushAccess(p, { ...own, degraded: 'SWITCH_REVOKED' }),
    ],
    [
      'the owner’s account view',
      (p: Phone) => pushAccess(p, { ...own, view: { mode: 'account' } }),
    ],
  ])('G5: never with %s', async (_what, set) => {
    const { p } = await held(set)
    expect(p.convex.calls).toEqual([])
  })

  test('G5: looking at the business as someone else (view as) still sends, as the person', async () => {
    const { p } = await held((q) =>
      pushAccess(q, {
        ...own,
        viewingAs: { membershipId: 'm-u2' as Id<'memberships'>, name: 'Jo' },
      }),
    )
    expect(p.convex.calls).toHaveLength(1)
    expect(p.convex.calls[0].args.asMembership).toBe(M1)
  })

  test('G6: never while an account switch is starting in this tab', async () => {
    let finish: () => void = () => {}
    let start: Promise<void> | null = null
    const { p } = await held(() => {
      start = duringSwitchStart(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
        null,
      )
    })
    expect(p.convex.calls).toEqual([])
    finish()
    await start
    await flush()
    expect(p.convex.calls).toHaveLength(1)
  })

  test('G7: a newer build’s booking is never sent', async () => {
    const { p } = await held(() => {}, waiting({ v: 2 }))
    expect(p.convex.calls).toEqual([])
  })

  test.each([
    ['backing off', { retryAt: NOW + 60_000 }],
    ['held', { holdUntil: NOW + 60_000 }],
    [
      'being edited in another tab',
      { editing: { tab: 'tab-b', until: NOW + 600_000 } },
    ],
  ])('G8: never while %s', async (_what, extra) => {
    const { p } = await held(() => {}, waiting(extra))
    expect(p.convex.calls).toEqual([])
  })

  test('G8: one made on a booking not sent yet waits for it', async () => {
    const parent = waiting({ state: 'needsLook', problem: { code: 'X' } })
    const child = waiting({
      booking: bookingFor({ property: { local: parent.localId } }),
      dependsOn: parent.localId,
    })
    const p = await phone([parent, child])
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(p.convex.calls).toEqual([])
  })

  test('once that one is sent, the site it made is asked for, and it goes there; with none to be had, it needs a look', async () => {
    const parent = waiting({
      booking: bookingFor({
        property: {
          newClient: {
            clientName: 'Priya Shah',
            kind: 'person',
            addressLine: '88 Marine Parade',
            suburb: 'Cottesloe',
            state: 'WA',
            postcode: '6011',
            phone: '0412 345 678',
          },
        },
      }),
    })
    const child = itemFor(
      'u1',
      {
        booking: bookingFor({ property: { local: parent.localId } }),
        dependsOn: parent.localId,
      },
      NOW - 30_000,
    )
    const p = await phone([parent, child])
    expect(p.convex.calls).toHaveLength(1)
    p.convex.calls[0].resolve('job-1')
    await flush()
    // Asked once, on the line it went on, before the next one goes.
    expect(p.convex.calls).toHaveLength(1)
    p.convex.answerFind('job', {
      kind: 'job',
      id: 'job-1',
      propertyId: 'p-new',
    })
    await flush()
    expect(p.convex.calls).toHaveLength(2)
    expect(p.convex.calls[1].args).toMatchObject({ propertyId: 'p-new' })
    expect(p.convex.calls[1].args).not.toHaveProperty('local')

    // The one it was made on sent long ago, and what it made unknown.
    const lost = waiting({
      state: 'sent',
      sentAt: NOW - 5 * 60_000,
      result: { id: 'job-2' },
    })
    const orphan = waiting({
      booking: bookingFor({ property: { local: lost.localId } }),
      dependsOn: lost.localId,
    })
    const q = await phone([orphan])
    q.backend.items.set(lost.localId, structuredClone(lost))
    q.broadcast.fromAnotherTab()
    await flush()
    expect(q.convex.calls).toEqual([])
    expect(stored(q, orphan)?.problem).toEqual({ code: 'NOT_FOUND' })
  })

  test('the one it was made on just sent from another tab, its site not yet known there: it waits, and needs a look only once that has had its time', async () => {
    const parent = waiting({
      state: 'sent',
      sentAt: NOW - 1_000,
      result: { id: 'job-1' },
    })
    const child = waiting({
      booking: bookingFor({ property: { local: parent.localId } }),
      dependsOn: parent.localId,
    })
    const p = await phone()
    p.backend.items.set(parent.localId, structuredClone(parent))
    p.backend.items.set(child.localId, structuredClone(child))
    p.broadcast.fromAnotherTab()
    await flush()
    expect(stored(p, child)?.state).toBe('waiting')
    // The next look after that time is up.
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    await flush()
    expect(stored(p, child)?.problem).toEqual({ code: 'NOT_FOUND' })
    expect(p.convex.calls).toEqual([])
  })

  test(`one sent ${SENT_KEEP_MS / 60_000} min ago goes from the phone, but not while another made on it is still there`, async () => {
    const parent = waiting({
      state: 'sent',
      sentAt: NOW - SENT_KEEP_MS - 1,
      result: { id: 'job-1', propertyId: 'p-new' as Id<'properties'> },
    })
    const child = waiting({
      booking: bookingFor({ property: { local: parent.localId } }),
      dependsOn: parent.localId,
      holdUntil: NOW + 10 * 60_000,
    })
    const alone = waiting({
      state: 'sent',
      sentAt: NOW - SENT_KEEP_MS - 1,
      result: { id: 'job-2' },
    })
    const p = await phone()
    // Sent in this page load, as the sweep at a page load deletes any sent.
    for (const item of [parent, child, alone]) {
      p.backend.items.set(item.localId, structuredClone(item))
    }
    p.broadcast.fromAnotherTab()
    await flush()
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(stored(p, alone)).toBeUndefined()
    expect(stored(p, parent)).toBeDefined()
    expect(stored(p, child)).toBeDefined()
  })

  test('G9: never while two-step sign-in is asked for', async () => {
    const { p } = await held(() => {
      vi.mocked(isTwoStepNeeded).mockReturnValue(true)
    })
    expect(p.convex.calls).toEqual([])
  })

  test('an Edit open in this tab holds it even once its lease has run out (S11)', async () => {
    const item = waiting({ editing: { tab: 'x', until: NOW - 1 } })
    const p = await phone()
    p.model.editingHere.add(item.localId)
    p.backend.items.set(item.localId, structuredClone(item))
    p.broadcast.fromAnotherTab()
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS * 3)
    expect(p.convex.calls).toEqual([])
    p.model.editingHere.delete(item.localId)
    p.sender.kick()
    await flush()
    expect(p.convex.calls).toHaveLength(1)
  })
})

describe('removed and invited back (the same membership again)', () => {
  test('a booking saved before the last removal goes, as the removal would have taken it; one saved since is sent', async () => {
    const removedAt = NOW - 10 * 60_000
    const before = itemFor('u1', {}, removedAt - EARLIER_STINT_MARGIN_MS - 1)
    const since = itemFor('u1', {}, removedAt + 60_000)
    const p = await phone([before, since], {
      access: { ...own, lastRemovedAt: removedAt },
    })
    expect(stored(p, before)).toBeUndefined()
    expect(notes('outbox-wipe')).toContainEqual(
      expect.objectContaining({ why: 'earlier-stint', n: 1 }),
    )
    expect(p.convex.calls.map((c) => c.args.clientRequestId)).toEqual([
      since.requestId,
    ])
  })

  test('a booking saved just before it, within a slow clock’s margin, is kept rather than lost', async () => {
    const removedAt = NOW - 10 * 60_000
    const close = itemFor('u1', {}, removedAt - EARLIER_STINT_MARGIN_MS + 1)
    const p = await phone([close], {
      access: { ...own, lastRemovedAt: removedAt },
    })
    expect(p.convex.calls).toHaveLength(1)
  })

  test('one from before in any state goes too, though nothing of that stint is waiting: never sent once the person sends it on', async () => {
    const removedAt = NOW - 10 * 60_000
    const before = removedAt - EARLIER_STINT_MARGIN_MS - 1
    const looked = itemFor(
      'u1',
      { state: 'needsLook', problem: { code: 'INVALID_PHONE' } },
      before,
    )
    const held = itemFor('u1', { holdUntil: NOW + 60_000 }, before)
    const stale = itemFor(
      'u1',
      { state: 'needsLook', problem: { code: 'STALE' } },
      before,
    )
    const p = await phone([looked, held, stale], {
      access: { ...own, lastRemovedAt: removedAt },
    })
    expect(p.backend.items.size).toBe(0)
    expect(p.model.all()).toEqual([])
    expect(p.convex.calls).toEqual([])
  })

  test('an answer naming another membership is someone else’s: held, never forgotten', async () => {
    // A person has one membership in a business, which a rejoin makes
    // active again: it is never another one of theirs.
    const item = waiting()
    const p = await phone([item], {
      access: { ...own, membershipId: 'm-u2' as Id<'memberships'> },
    })
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(stored(p, item)?.state).toBe('waiting')
    expect(p.convex.calls).toEqual([])
    expect(notes('outbox-wipe')).toEqual([])
  })

  test('only while the socket is the booking’s person: an answer for no one or someone else proves nothing', async () => {
    const removedAt = NOW - 10 * 60_000
    const before = itemFor('u1', {}, removedAt - EARLIER_STINT_MARGIN_MS - 1)
    const p = await phone()
    p.keeper.socket = null
    p.qc.setQueryData(accessKey(), { ...own, lastRemovedAt: removedAt })
    p.backend.items.set(before.localId, structuredClone(before))
    p.broadcast.fromAnotherTab()
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(stored(p, before)).toBeDefined()
    expect(p.convex.calls).toEqual([])
  })

  test('a backend from before the field tells nothing apart: nothing goes for it', async () => {
    const { lastRemovedAt: _absent, ...older } = own
    const item = waiting()
    const p = await phone([item], { access: older })
    expect(stored(p, item)).toBeDefined()
    expect(p.convex.calls).toHaveLength(1)
  })
})

describe('purges', () => {
  const M1_B2 = 'm-u1-b2' as Id<'memberships'>

  /** u1's bookings in B1 and B2, the line down so none goes meanwhile. */
  async function inTwo() {
    const inB1 = waiting()
    const inB2 = waiting({ businessId: B2, membershipId: M1_B2 })
    const p = await phone()
    p.keeper.live = false
    p.backend.items.set(inB1.localId, structuredClone(inB1))
    p.backend.items.set(inB2.localId, structuredClone(inB2))
    p.broadcast.fromAnotherTab()
    await flush()
    return { p, inB1, inB2 }
  }

  function listLive(p: Phone, listed: Array<Record<string, unknown>>) {
    p.qc.setQueryData(LIST_KEY, listed)
    p.keeper.liveKeys.add(hashKey(LIST_KEY))
    p.keeper.notify()
  }

  test('the person’s business list, live, no longer listing a business: its bookings go (F9)', async () => {
    const { p, inB1, inB2 } = await inTwo()
    // Theirs for certain: it lists the membership their B2 booking has.
    listLive(p, [{ businessId: B2, membershipId: M1_B2 }])
    await flush()
    expect(stored(p, inB1)).toBeUndefined()
    expect(stored(p, inB2)).toBeDefined()
    expect(notes('outbox-wipe')).toEqual([
      expect.objectContaining({ why: 'not-listed', n: 1 }),
    ])
  })

  test('a list that shows nothing of theirs forgets nothing: it may be someone else’s', async () => {
    const mine = waiting()
    const p = await phone()
    p.keeper.live = false
    p.backend.items.set(mine.localId, structuredClone(mine))
    p.broadcast.fromAnotherTab()
    await flush()
    listLive(p, [{ businessId: B2, membershipId: 'm-u2-b2' }])
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(stored(p, mine)).toBeDefined()
  })

  test('not when the socket is someone else’s, nor before the list is live on this connection', async () => {
    const { p, inB1 } = await inTwo()
    p.qc.setQueryData(LIST_KEY, [{ businessId: B2, membershipId: M1_B2 }])
    p.keeper.notify()
    await flush()
    expect(stored(p, inB1)).toBeDefined()
    p.keeper.socket = 'u2'
    listLive(p, [{ businessId: B2, membershipId: M1_B2 }])
    await flush()
    expect(stored(p, inB1)).toBeDefined()
  })
})

describe('whose an answer is: a sign-in handed over on this socket', () => {
  // A shared tablet: Jo signs in in another tab and this socket takes her
  // token, then Kevin (u1) signs in again in a third. The socket has his
  // token as soon as it is fetched, before the server has run anything with
  // it, so for that moment what is live on it is still Jo's.
  const JO_B1 = 'm-u2' as Id<'memberships'>

  test('access:me still hers: nothing of his forgotten or sent, until the server answers for him', async () => {
    const removedAt = NOW - 10 * 60_000
    const before = itemFor('u1', {}, removedAt - EARLIER_STINT_MARGIN_MS - 1)
    const since = waiting()
    const p = await phone()
    p.keeper.socket = 'u2'
    pushAccess(p, { ...own, membershipId: JO_B1, lastRemovedAt: removedAt })
    p.backend.items.set(before.localId, structuredClone(before))
    p.backend.items.set(since.localId, structuredClone(since))
    p.broadcast.fromAnotherTab()
    await flush()
    // His token, and no push yet.
    p.keeper.socket = 'u1'
    p.keeper.notify()
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(stored(p, before)).toBeDefined()
    expect(stored(p, since)?.state).toBe('waiting')
    expect(p.convex.calls).toEqual([])
    expect(notes('outbox-wipe')).toEqual([])
    // The server's answer for him.
    pushAccess(p, { ...own, lastRemovedAt: removedAt })
    await flush()
    expect(stored(p, before)).toBeUndefined()
    expect(p.convex.calls.map((c) => c.args.clientRequestId)).toEqual([
      since.requestId,
    ])
  })

  test('the business list still hers: nothing of his forgotten', async () => {
    const mine = waiting()
    const other = waiting({
      businessId: B2,
      membershipId: 'm-u1-b2' as Id<'memberships'>,
    })
    const p = await phone()
    p.keeper.live = false
    p.keeper.socket = 'u2'
    p.qc.setQueryData(LIST_KEY, [{ businessId: B2, membershipId: 'm-u2-b2' }])
    p.keeper.liveKeys.add(hashKey(LIST_KEY))
    p.backend.items.set(mine.localId, structuredClone(mine))
    p.backend.items.set(other.localId, structuredClone(other))
    p.broadcast.fromAnotherTab()
    await flush()
    p.keeper.socket = 'u1'
    p.keeper.notify()
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(stored(p, mine)).toBeDefined()
    expect(stored(p, other)).toBeDefined()
    expect(notes('outbox-wipe')).toEqual([])
  })
})

describe('answers', () => {
  async function answeredWith(error: unknown, item = waiting(), p?: Phone) {
    const phoneNow = p ?? (await phone([item]))
    phoneNow.convex.calls.at(-1)?.reject(error)
    await flush()
    return { p: phoneNow, item }
  }

  test.each([
    ['INVALID_ASSIGNEE'],
    ['TOO_MANY_PEOPLE'],
    ['NOT_FOUND'],
    ['MISSING_PROPERTY'],
    ['INVALID_PHONE'],
    ['FIRST_VISIT_PAST'],
    ['SOMETHING_NEW'],
  ])('%s needs a look, with its code', async (code) => {
    const { p, item } = await answeredWith(new ConvexError(code))
    expect(stored(p, item)).toMatchObject({
      state: 'needsLook',
      problem: { code },
    })
  })

  test('NO_ACCESS: needs a look while access:me is live and theirs; held while it isn’t known; forgotten once they are out', async () => {
    const live = await answeredWith(new ConvexError('NO_ACCESS'))
    expect(stored(live.p, live.item)).toMatchObject({ state: 'needsLook' })

    const unknownItem = waiting()
    const unknown = await phone([unknownItem])
    unknown.keeper.liveKeys.clear()
    await answeredWith(new ConvexError('NO_ACCESS'), unknownItem, unknown)
    expect(stored(unknown, unknownItem)).toMatchObject({
      state: 'waiting',
      holdUntil: NOW + 30_000,
    })

    const goneItem = waiting()
    const gone = await phone([goneItem])
    refuseAccess(gone, 'NO_ACCESS')
    await answeredWith(new ConvexError('NO_ACCESS'), goneItem, gone)
    expect(stored(gone, goneItem)).toBeUndefined()
  })

  test.each([
    ['no token', null],
    ['someone else’s token', 'u2'],
  ])(
    'NO_ACCESS while access:me is refused NO_ACCESS, the socket having %s: held, never forgotten',
    async (_what, socket) => {
      const item = waiting()
      const p = await phone([item])
      refuseAccess(p, 'NO_ACCESS')
      p.keeper.socket = socket
      await answeredWith(new ConvexError('NO_ACCESS'), item, p)
      expect(stored(p, item)).toMatchObject({
        state: 'waiting',
        holdUntil: NOW + 30_000,
      })
      expect(notes('outbox-wipe')).toEqual([])
    },
  )

  test('Unauthenticated three in a row asks nothing more while the line isn’t live', async () => {
    const item = waiting()
    const p = await phone([item])
    for (let i = 0; i < 3; i++) {
      if (i === 2) p.keeper.live = false
      p.convex.calls.at(-1)?.reject(new ConvexError('Unauthenticated'))
      await flush()
      const hold = stored(p, item)?.holdUntil ?? Date.now()
      await vi.advanceTimersByTimeAsync(hold - Date.now())
      await flush()
    }
    expect(p.convex.calls).toHaveLength(3)
    expect(signedOutAfterAll).not.toHaveBeenCalled()
  })

  test('Unauthenticated holds 5 s, 30 s, then 2 min, and asks whether they are signed in after 3 in a row (S14)', async () => {
    const item = waiting()
    const p = await phone([item])
    const holds: Array<number | null | undefined> = []
    for (let i = 0; i < 3; i++) {
      p.convex.calls.at(-1)?.reject(new ConvexError('Unauthenticated'))
      await flush()
      const hold = stored(p, item)?.holdUntil
      holds.push(hold === null || hold === undefined ? hold : hold - Date.now())
      expect(p.convex.calls).toHaveLength(i + 1)
      await vi.advanceTimersByTimeAsync((hold ?? Date.now()) - Date.now())
      await flush()
    }
    expect(holds).toEqual([5_000, 30_000, 120_000])
    expect(signedOutAfterAll).toHaveBeenCalledTimes(1)
  })

  test('NOT_OWN_ACCOUNT holds at least 30 s and until access:me is pushed again, and is no progress: the loop ends (S7, F7)', async () => {
    const item = waiting()
    const p = await phone([item])
    p.convex.calls[0].reject(new ConvexError('NOT_OWN_ACCOUNT'))
    await flush()
    expect(stored(p, item)).toMatchObject({
      state: 'waiting',
      holdUntil: NOW + 30_000,
    })
    // 30 s on, access:me hasn't been pushed again: still held.
    await vi.advanceTimersByTimeAsync(2 * OUTBOX_TICK_MS)
    expect(p.convex.calls).toHaveLength(1)
    // Pushed again (the switch shown, then gone): it goes.
    pushAccess(p)
    await flush()
    expect(p.convex.calls).toHaveLength(2)
    // A second refusal holds longer.
    p.convex.calls[1].reject(new ConvexError('SWITCH_EXPIRED'))
    await flush()
    expect((stored(p, item)?.holdUntil ?? 0) - Date.now()).toBe(120_000)
  })

  test('OUTBOX_PAUSED holds it 15 min', async () => {
    const { p, item } = await answeredWith(new ConvexError('OUTBOX_PAUSED'))
    expect(stored(p, item)).toMatchObject({
      state: 'waiting',
      holdUntil: NOW + PAUSED_HOLD_MS,
    })
    await vi.advanceTimersByTimeAsync(PAUSED_HOLD_MS - 1_000)
    expect(p.convex.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(p.convex.calls).toHaveLength(2)
  })

  test('INVALID_REQUEST_ID: a new id in place, the same booking, sent again; a second needs a look (F17)', async () => {
    const item = waiting()
    const p = await phone([item])
    p.convex.calls[0].reject(new ConvexError('INVALID_REQUEST_ID'))
    await flush()
    const renewed = stored(p, item)
    expect(renewed?.localId).toBe(item.localId)
    expect(renewed?.requestId).not.toBe(item.requestId)
    expect(renewed?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(p.convex.calls).toHaveLength(2)
    expect(p.convex.calls[1].args.clientRequestId).toBe(renewed?.requestId)
    expect(p.backend.items.size).toBe(1)

    p.convex.calls[1].reject(new ConvexError('INVALID_REQUEST_ID'))
    await flush()
    expect(stored(p, item)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'INVALID_REQUEST_ID' },
    })
  })

  test('MFA: two-step sign-in is asked for, and it waits for it (G9)', async () => {
    vi.mocked(flagIfTwoStepNeeded).mockImplementation(() => {
      vi.mocked(isTwoStepNeeded).mockReturnValue(true)
    })
    const refusal = new ConvexError('MFA_ENROLMENT_REQUIRED')
    const { p, item } = await answeredWith(refusal)
    expect(flagIfTwoStepNeeded).toHaveBeenCalledWith(refusal)
    await vi.advanceTimersByTimeAsync(2 * OUTBOX_TICK_MS)
    expect(stored(p, item)?.state).toBe('waiting')
    expect(p.convex.calls).toHaveLength(1)
    vi.mocked(flagIfTwoStepNeeded).mockReset()
  })

  test('an error that isn’t a refusal backs off 1, 5 and 15 min, then needs a look, with its request id noted', async () => {
    const item = waiting()
    const p = await phone([item])
    const waits: Array<number> = []
    for (let i = 0; i < 3; i++) {
      const sentAt = Date.now()
      p.convex.calls
        .at(-1)
        ?.reject(new Error('[Request ID: abc123] Server Error'))
      await flush()
      const at = stored(p, item)?.retryAt ?? 0
      waits.push(at - sentAt)
      await vi.advanceTimersByTimeAsync(at - Date.now())
      await flush()
    }
    expect(waits).toEqual([60_000, 300_000, 900_000])
    p.convex.calls.at(-1)?.reject(new Error('Server Error'))
    await flush()
    expect(stored(p, item)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'SERVER' },
      serverFailures: 4,
    })
    expect(notes('outbox-refused')).toContainEqual({
      code: 'none',
      cls: 'SERVER',
      requestId: 'abc123',
    })
  })

  test('an error heard across a reconnect leaves it locked, to be settled by asking', async () => {
    const item = waiting()
    const p = await phone([item])
    p.keeper.conn++
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await flush()
    expect(stored(p, item)?.state).toBe('sending')
    expect(p.convex.watches).toEqual([])
    await vi.advanceTimersByTimeAsync(SETTLE_MIN_AGE_MS)
    await flush()
    expect(p.convex.open('job')).toHaveLength(1)
  })

  test('a Recurring Job sent: its first visit and site asked for once, for its card', async () => {
    const item = series(NOW + 86_400_000)
    const p = await phone([item])
    p.convex.calls[0].resolve('rec-1')
    await flush()
    expect(p.convex.open('series')).toHaveLength(1)
    p.convex.answerFind('series', {
      kind: 'series',
      id: 'rec-1',
      propertyId: 'p1',
      firstJobId: 'job-9',
    })
    await flush()
    expect(stored(p, item)?.result).toEqual({
      id: 'rec-1',
      propertyId: 'p1',
      firstJobId: 'job-9',
    })
    expect(p.convex.watches[0].stops).toBe(1)
  })
})

describe('settling one sent with no answer', () => {
  test(`not before ${SETTLE_MIN_AGE_MS / 1000} s after it went, and only on a live line`, async () => {
    const item = unanswered(10_000)
    const p = await phone([item])
    expect(p.convex.watches).toEqual([])
    p.keeper.live = false
    await vi.advanceTimersByTimeAsync(20_000)
    expect(p.convex.watches).toEqual([])
    p.keeper.live = true
    p.keeper.notify()
    await flush()
    expect(p.convex.open('job')).toHaveLength(1)
    expect(p.convex.query).not.toHaveBeenCalled()
  })

  test('nothing made under its id: unlocked, and sent again with the same id', async () => {
    const item = unanswered(SETTLE_MIN_AGE_MS)
    const p = await phone([item])
    p.convex.answerFind('job', null)
    await flush()
    expect(p.convex.watches[0].stops).toBe(1)
    expect(p.convex.calls).toHaveLength(1)
    expect(p.convex.calls[0].args.clientRequestId).toBe(item.requestId)
    expect(notes('outbox-settle')).toEqual([
      expect.objectContaining({ found: false }),
    ])
  })

  test('a record: sent, with its site and first visit', async () => {
    const item = unanswered(SETTLE_MIN_AGE_MS, ['series'], { kind: 'series' })
    const p = await phone([item])
    p.convex.answerFind('series', {
      kind: 'series',
      id: 'rec-1',
      propertyId: 'p1',
      firstJobId: 'job-2',
    })
    await flush()
    expect(stored(p, item)).toMatchObject({
      state: 'sent',
      result: { id: 'rec-1', propertyId: 'p1', firstJobId: 'job-2' },
    })
    expect(p.convex.calls).toEqual([])
  })

  test('both kinds asked when it has gone as both, and a record of either settles it (S17)', async () => {
    const item = unanswered(SETTLE_MIN_AGE_MS, ['job', 'series'])
    const p = await phone([item])
    expect(p.convex.open('job')).toHaveLength(1)
    expect(p.convex.open('series')).toHaveLength(1)
    p.convex.answerFind('series', { kind: 'series', id: 'rec-1' })
    await flush()
    // The other is given its time, then let go.
    await vi.advanceTimersByTimeAsync(FIND_WAIT_MS)
    await flush()
    expect(stored(p, item)).toMatchObject({
      state: 'sent',
      result: { id: 'rec-1' },
    })
    expect(p.convex.watches.every((w) => w.stops === 1)).toBe(true)
  })

  test('gone as both kinds, one saying nothing was made and the other not answering, or refused: still locked, never sent again (S17)', async () => {
    const item = unanswered(SETTLE_MIN_AGE_MS, ['job', 'series'])
    const p = await phone([item])
    p.convex.answerFind('job', null)
    await vi.advanceTimersByTimeAsync(FIND_WAIT_MS)
    await flush()
    expect(stored(p, item)?.state).toBe('sending')

    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    await flush()
    expect(p.convex.open('series')).toHaveLength(1)
    p.convex.answerFind('job', null)
    p.convex.refuseFind('series', new ConvexError('Unauthenticated'))
    await flush()
    expect(stored(p, item)?.state).toBe('sending')
    expect(p.convex.calls).toEqual([])
  })

  test(`no answer in ${FIND_WAIT_MS / 1000} s, or a refusal: still locked, and the watch stopped`, async () => {
    const item = unanswered(SETTLE_MIN_AGE_MS)
    const p = await phone([item])
    await vi.advanceTimersByTimeAsync(FIND_WAIT_MS)
    await flush()
    expect(p.convex.watches[0].stops).toBe(1)
    expect(stored(p, item)?.state).toBe('sending')

    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    await flush()
    p.convex.refuseFind('job', new ConvexError('Unauthenticated'))
    await flush()
    expect(p.convex.watches.every((w) => w.stops === 1)).toBe(true)
    expect(stored(p, item)?.state).toBe('sending')
    expect(p.sender.refusedFinds(item.localId)).toBe(1)
    expect(p.convex.calls).toEqual([])
  })

  test('the line coming up wakes one waiting only to be settled (S3)', async () => {
    const item = unanswered(SETTLE_MIN_AGE_MS)
    const p = await phone()
    p.keeper.live = false
    p.backend.items.set(item.localId, structuredClone(item))
    p.broadcast.fromAnotherTab()
    await flush()
    expect(p.convex.watches).toEqual([])
    p.keeper.live = true
    p.keeper.notify()
    await flush()
    expect(p.convex.open('job')).toHaveLength(1)
  })
})

describe('before a send', () => {
  test(`one unsent for ${STALE_AFTER_MS / 86_400_000} days needs a look before anything goes; Send lets it go`, async () => {
    const old = itemFor('u1', {}, NOW - STALE_AFTER_MS - 1)
    const fresh = itemFor('u1', {}, NOW - STALE_AFTER_MS + 60_000)
    const p = await phone([old, fresh])
    expect(stored(p, old)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'STALE' },
    })
    expect(p.convex.calls.map((c) => c.args.clientRequestId)).toEqual([
      fresh.requestId,
    ])
    p.convex.calls[0].resolve('job-1')
    await flush()
    await p.model.change('send', old.localId, confirmStaleChange(Date.now()))
    await flush()
    expect(p.convex.calls.map((c) => c.args.clientRequestId)).toEqual([
      fresh.requestId,
      old.requestId,
    ])
  })

  test('one whose session ended on the server needs a look, however new', async () => {
    const item = waiting({ sessionEndedAt: NOW - 1_000 })
    const p = await phone([item])
    expect(stored(p, item)?.problem).toEqual({ code: 'STALE' })
    expect(p.convex.calls).toEqual([])
  })

  test('a claim marking it as having outlived its session between the look and the mark: nothing goes, and it needs a look (D8)', async () => {
    const item = waiting()
    const p = await phone()
    p.backend.items.set(item.localId, structuredClone(item))
    const realUpdate = p.backend.update.bind(p.backend)
    let marked = false
    p.backend.update = (epoch, localId, change) => {
      if (!marked) {
        marked = true
        // The same person signed in again in a new session: the claim
        // that marks their bookings lands first, and the mark reads it.
        const row = p.backend.items.get(localId)
        if (row) Object.assign(row, { sessionEndedAt: NOW, updatedAt: NOW })
      }
      return realUpdate(epoch, localId, change)
    }
    p.broadcast.fromAnotherTab()
    await flush()
    expect(p.convex.calls).toEqual([])
    expect(stored(p, item)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'STALE' },
      sessionEndedAt: NOW,
    })
  })

  test('a Recurring Job whose first visit has gone by while it waited needs a look', async () => {
    const item = series(NOW - 23 * 3_600_000 - 60_000, {
      createdAt: NOW - 24 * 3_600_000,
    })
    const p = await phone([item])
    expect(stored(p, item)?.problem).toEqual({ code: 'FIRST_VISIT_PAST' })
    expect(p.convex.calls).toEqual([])
  })
})

describe('wakes', () => {
  test('another tab’s change on the channel', async () => {
    const item = waiting()
    const p = await phone()
    p.backend.items.set(item.localId, structuredClone(item))
    await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    expect(p.convex.calls).toEqual([])
    p.broadcast.fromAnotherTab()
    await flush()
    expect(p.convex.calls).toHaveLength(1)
  })

  test('coming back on screen renews this tab’s Edits before it looks (S11)', async () => {
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    })
    vi.stubGlobal('document', doc)
    const item = waiting({ editing: { tab: '', until: NOW + 60_000 } })
    const p = await phone()
    const edited = {
      ...item,
      editing: { tab: p.model.tab, until: NOW + 60_000 },
    }
    p.backend.items.set(item.localId, structuredClone(edited))
    p.model.editingHere.add(item.localId)
    p.broadcast.fromAnotherTab()
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(stored(p, item)?.editing).toEqual({
      tab: p.model.tab,
      until: Date.now() + 10 * 60_000,
    })
    expect(p.convex.calls).toEqual([])
  })
})

describe('the notes it leaves', () => {
  test('why a booking is held, once per change of reason, with how many looks found the last (F20)', async () => {
    const item = waiting()
    const p = await phone()
    p.keeper.live = false
    p.backend.items.set(item.localId, structuredClone(item))
    p.broadcast.fromAnotherTab()
    await flush()
    for (let i = 0; i < 3; i++)
      await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS)
    p.keeper.liveKeys.clear()
    p.keeper.live = true
    p.keeper.notify()
    await flush()
    const held = notes('outbox-held') as Array<{ why: string; n: number }>
    expect(held.map((h) => h.why)).toEqual(['line', 'access'])
    expect(held[1].n).toBeGreaterThan(1)
  })

  test('what goes is codes and times, never what was booked', async () => {
    const item = waiting({
      booking: bookingFor({ notes: 'Gate code 4417', workOrder: 'WO-77' }),
    })
    const p = await phone([item])
    p.convex.calls[0].resolve('job-1')
    await flush()
    const all = JSON.stringify(vi.mocked(logConnection).mock.calls)
    expect(all).not.toContain('4417')
    expect(all).not.toContain('WO-77')
    expect(all).not.toContain('Jane')
  })
})

describe('for ConnectionNotice', () => {
  test('counts the person’s bookings waiting or out for the business on screen, and says when they wait on their own account', async () => {
    const p = await phone([waiting(), waiting({ businessId: B2 })])
    expect(p.sender.inflight()).toBe(1)
    expect(p.sender.notice()).toEqual({ count: 1, held: null })
    pushAccess(p, { ...own, degraded: 'SWITCH_EXPIRED' })
    expect(p.sender.notice()).toEqual({ count: 1, held: 'switched' })
  })
})
