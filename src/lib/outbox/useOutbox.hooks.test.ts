import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { ConvexError } from 'convex/values'
import { getFunctionName } from 'convex/server'
import { api } from '../../../convex/_generated/api'
import { useNewJobBooking } from '#/components/schedule/useNewJobBooking'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { rq } from '#/lib/routeQueries'
import { FakeLockManager } from './fakeLocks.fixtures'
import { outbox } from './outbox'
import { KEEP_WAIT_MS, STORE_OP_MS } from './outboxSet'
import { checkOutboxOwner, setOutboxBackendForTests } from './outboxStore'
import {
  B1,
  DISPLAY,
  bookingFor,
  memoryStorage,
  outboxOf,
  personOf,
} from './outboxStore.fixtures'
import { sender } from './sender'
import { resetSwitchGateForTests } from './switchGate'
import {
  useBooking,
  useCanKeep,
  useDraftRequestId,
  useOutboxDay,
} from './useOutbox'
import type * as React from 'react'
import type * as ReactQuery from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import type * as TwoStep from '#/lib/twoStep'
import type * as Keeper from '#/lib/offline/keeper'
import type { Access } from '#/lib/access'
import type { JobRow } from '#/components/schedule/JobCard'
import type { Id } from '../../../convex/_generated/dataModel'
import type { BookingPath, BookingWho } from './book'
import type { Locks } from './outboxLocks'
import type * as OutboxLocks from './outboxLocks'
import type * as OutboxSet from './outboxSet'
import type { BookingCall, SendableBooking } from './outboxItem'
import type { MemoryOutboxBackend } from './outboxStore.fixtures'
import type { SenderDeps } from './sender'
import type { OutboxDaySlot } from './useOutbox'

/**
 * New Job's Book and a day's list as the page wires them (useOutbox.ts):
 * the hooks themselves, run by the harness, over this page load's outbox
 * and sender, in memory, as book.test.ts runs a press. What they hand the
 * screens over time: whether closing the sheet loses nothing (`kept`), and
 * what a day's list draws of a booking.
 */

// React's hooks run here by the harness, effects and timers included: there
// is no document to render into. A test can hold passive effects back
// (`react.holdPassive`), as React runs them only after the commit, when a
// tap can land first; and the one context read here is the sheet's lock
// registry (`useSheetLock`), which is the test's.
type SheetLockEntry = { changed: boolean; discarded: () => void }
const react = vi.hoisted(() => ({
  holdPassive: false,
  lockRegistry: null as
    ((id: string, lock: SheetLockEntry | null) => void) | null,
}))
vi.mock('react', async (importOriginal) => {
  const { hookHarness: harness } = await import('#/lib/offline/hooks.fixtures')
  return {
    ...(await importOriginal<typeof React>()),
    ...harness.hooks,
    useEffect: (
      effect: () => void | (() => void),
      deps?: ReadonlyArray<unknown>,
    ) => harness.hooks.useEffect(react.holdPassive ? () => {} : effect, deps),
    useContext: () => react.lockRegistry,
    useId: () => 'new-job-lock',
  }
})
// Who is signed in reads a server function, which needs a deployment's
// address to load at all.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))
vi.mock('#/lib/rootState', () => ({
  signedInUserId: () => 'u1',
  signedOutAfterAll: vi.fn(async () => false),
}))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))
vi.mock('#/lib/twoStep', async (importOriginal) => ({
  ...(await importOriginal<typeof TwoStep>()),
  flagIfTwoStepNeeded: vi.fn(),
  isTwoStepNeeded: vi.fn(() => false),
}))

/** The page's parts the hooks reach for: set by each test's phone. */
const page = vi.hoisted(() => {
  class PageKeeper {
    live = true
    conn = 1
    readonly liveKeys = new Set<string>()
    private readonly listeners = new Set<() => void>()
    lineLive = () => this.live
    isLive = (key: ReadonlyArray<unknown>) =>
      this.liveKeys.has(JSON.stringify(key))
    enteredBusiness = () => ({ _id: 'b1', slug: 'pest-co' })
    socketUserId = () => 'u1'
    connection = () => this.conn
    subscribe = (listener: () => void) => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }
    /** The line changed, as the keeper tells its listeners. */
    changed() {
      for (const listener of [...this.listeners]) listener()
    }
  }
  return {
    keeper: new PageKeeper(),
    access: { current: null as Access | null },
    qc: { current: null as QueryClient | null },
    locks: { current: null as Locks | null },
  }
})

vi.mock('#/lib/offline/keeper', async (importOriginal) => ({
  ...(await importOriginal<typeof Keeper>()),
  keeper: page.keeper,
}))
vi.mock('#/lib/access', () => ({ useAccess: () => page.access.current }))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => page.qc.current,
}))
// Keeping switched on, as a build with VITE_PESTM8_OUTBOX=on has it, and
// the browser's Web Locks the phone's, in memory.
vi.mock('./outboxSet', async (importOriginal) => ({
  ...(await importOriginal<typeof OutboxSet>()),
  OUTBOX_ENABLED: true,
}))
vi.mock('./outboxLocks', async (importOriginal) => ({
  ...(await importOriginal<typeof OutboxLocks>()),
  browserLocks: () => page.locks.current,
}))

const NOW = Date.UTC(2026, 9, 27, 0)
const M1 = 'm-u1' as Id<'memberships'>
/** The day booked: 9am Perth on 27 Oct (`bookingFor`). */
const DAY = '2026-10-27'
const TZ = 'Australia/Perth'
const ARGS = bookingFor() as SendableBooking

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

const WHO: BookingWho = {
  userId: 'u1',
  lens: 'lens',
  membershipId: M1,
  business: { slug: 'pest-co', name: 'Pest Co' },
  display: () => DISPLAY,
}

type Call = {
  fn: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

class FakeConvex {
  readonly calls: Array<Call> = []
  mutation(fn: Parameters<typeof getFunctionName>[0], args: object) {
    return new Promise((resolve, reject) => {
      this.calls.push({
        fn: getFunctionName(fn),
        args: args as Record<string, unknown>,
        resolve,
        reject,
      })
    })
  }
  watchQuery() {
    return { onUpdate: () => () => {}, localQueryResult: () => undefined }
  }
}

const stops: Array<() => void> = []

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0)
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A phone signed in as u1, in B1, access:me live, nothing kept: this page
 * load's outbox and sender over it. */
async function phone() {
  const backend = await outboxOf('u1', [])
  setOutboxBackendForTests(backend)
  checkOutboxOwner(personOf('u1'))
  await flush(3)
  const locks = new FakeLockManager().forTab('tab-a')
  page.locks.current = locks
  page.access.current = own
  page.keeper.live = true
  page.keeper.liveKeys.clear()
  const qc = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  })
  const accessKey = rq.access(B1).queryKey as QueryKey
  qc.setQueryData(accessKey, own)
  page.keeper.liveKeys.add(JSON.stringify(accessKey))
  page.qc.current = qc
  const convex = new FakeConvex()
  stops.push(outbox.start(() => null))
  stops.push(
    sender.attach({
      convex: convex as unknown as SenderDeps['convex'],
      qc,
      keeper: page.keeper as unknown as SenderDeps['keeper'],
      locks,
    }),
  )
  await outbox.refresh()
  await flush()
  return { backend, convex }
}

/** The phone's storage reaches each keep `ms` after it is asked. */
function slowKeep(backend: MemoryOutboxBackend, ms: number) {
  const real = backend.keep.bind(backend)
  backend.keep = (epoch, item, wanted) =>
    sleep(ms).then(() => real(epoch, item, wanted))
}

/** …and each change to a booking, from now. */
function slowChanges(backend: MemoryOutboxBackend, ms: number) {
  const real = backend.update.bind(backend)
  backend.update = (epoch, localId, change) =>
    sleep(ms).then(() => real(epoch, localId, change))
}

/** …and each change that deletes a booking, from now. */
function slowDeletes(backend: MemoryOutboxBackend, ms: number) {
  const real = backend.update.bind(backend)
  backend.update = (epoch, localId, change) => {
    const now = backend.items.get(localId)
    return now && change(structuredClone(now)) === 'delete'
      ? sleep(ms).then(() => real(epoch, localId, change))
      : real(epoch, localId, change)
  }
}

/** A keep the phone's storage writes `writeAt` after it is asked, and
 * answers for `answerAfter` later. */
function keepWrittenThenAnswered(
  backend: MemoryOutboxBackend,
  writeAt: number,
  answerAfter: number,
) {
  const real = backend.keep.bind(backend)
  backend.keep = (epoch, item, wanted) =>
    sleep(writeAt)
      .then(() => real(epoch, item, wanted))
      .then((result) => sleep(answerAfter).then(() => result))
}

/** What each keep came to in the phone's storage, from now. Asked first,
 * so it sees what the storage itself did. */
function keepResults(backend: MemoryOutboxBackend): Array<string> {
  const results: Array<string> = []
  const real = backend.keep.bind(backend)
  backend.keep = (epoch, item, wanted) =>
    real(epoch, item, wanted).then((result) => {
      results.push(result)
      return result
    })
  return results
}

/** Where a booking New Job gave up keeping is noted (`giveUpKeep`). */
const GIVEN_UP_KEY = 'pestm8-outbox-given-up'

type Drawn = {
  kept: boolean
  path: BookingPath
  slots: Array<OutboxDaySlot>
  hidden: ReadonlySet<string>
  heading: string | null
}

/**
 * New Job's Book and the day's list under it, as one screen: the sheet's
 * hooks, and the day's (`useOutboxDay`) over the rows the server has sent.
 * Each render is kept. Closing the sheet is `session.dispose()`, as its
 * unmount runs it.
 */
function screen(convex: FakeConvex) {
  const sheet = { booked: vi.fn(), close: vi.fn() }
  let rows: Array<JobRow> = []
  const renders: Array<Drawn> = []
  const call = (made: BookingCall) =>
    made.fn === 'jobs.create'
      ? convex.mutation(api.jobs.create, made.args)
      : convex.mutation(api.recurrences.create, made.args)
  const hook = hookHarness.mount(() => {
    const draft = useDraftRequestId()
    const booking = useBooking(sheet, call)
    const day = useOutboxDay({
      businessId: B1,
      dayShown: DAY,
      timezone: TZ,
      rows,
      drawsCards: true,
      redrawKey: 'day',
      allStatuses: true,
      staffId: 'all',
      mineOnly: null,
    })
    renders.push({
      kept: booking.kept,
      path: booking.path,
      slots: day.slots,
      hidden: day.hidden,
      heading: day.heading,
    })
    return { draft, booking }
  })
  return {
    sheet,
    renders,
    hook,
    /** A press of Book, its outcome caught. */
    press() {
      const { booking, draft } = hook.current()
      const outcome: { value?: unknown; error?: unknown } = {}
      void booking.session.book(ARGS, draft, WHO).then(
        (value) => {
          outcome.value = value
        },
        (error: unknown) => {
          outcome.error = error
        },
      )
      return { outcome, requestId: draft.requestId, localId: draft.localId }
    },
    close: () => hook.current().booking.session.dispose(),
    setRows(next: Array<JobRow>) {
      rows = next
      hook.rerender()
    },
    now: () => renders[renders.length - 1],
  }
}

/**
 * The day's list alone, as the page has it once New Job has gone: mounted
 * in the sheet's place, so the sheet unmounts as a discard unmounts it, its
 * layout effect's cleanup and all. Each render's slots are kept.
 */
function dayAlone() {
  const draws: Array<Array<OutboxDaySlot>> = []
  const hook = hookHarness.mount(() => {
    const day = useOutboxDay({
      businessId: B1,
      dayShown: DAY,
      timezone: TZ,
      rows: [],
      drawsCards: true,
      redrawKey: 'day',
      allStatuses: true,
      staffId: 'all',
      mineOnly: null,
    })
    draws.push(day.slots)
    return day
  })
  return { draws, hook }
}

/** Each change of where the booking is, and of `kept`, in render order. */
function steps(renders: Array<Drawn>): Array<[BookingPath, boolean]> {
  const out: Array<[BookingPath, boolean]> = []
  for (const { path, kept } of renders) {
    const last = out.at(-1)
    if (last?.[0] !== path || last[1] !== kept) out.push([path, kept])
  }
  return out
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  hookHarness.mount(() => null)
  react.holdPassive = false
  react.lockRegistry = null
  for (const stop of stops.splice(0)) stop()
  resetSwitchGateForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('whether closing New Job loses nothing (`useBooking` kept)', () => {
  test('false while the booking is being kept, true once it is, and false again once a refusal has taken it off the phone', async () => {
    const { backend, convex } = await phone()
    slowKeep(backend, KEEP_WAIT_MS / 2)
    const s = screen(convex)
    const { outcome } = s.press()
    await flush()
    expect(s.now()).toMatchObject({ path: 'keeping', kept: false })
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS / 2)
    await flush()
    expect(s.now()).toMatchObject({ path: 'kept', kept: true })
    expect(convex.calls).toHaveLength(1)
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    convex.calls[0].reject(refusal)
    await flush()
    expect(outcome.error).toBe(refusal)
    expect(steps(s.renders)).toEqual([
      [null, false],
      ['keeping', false],
      ['kept', true],
      [null, false],
    ])
  })

  test('false again once the kill switch has sent it straight: nothing of it is on the phone', async () => {
    const { convex } = await phone()
    const s = screen(convex)
    const { outcome } = s.press()
    await flush()
    expect(s.now()).toMatchObject({ path: 'kept', kept: true })
    convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
    await flush()
    expect(convex.calls).toHaveLength(2)
    expect(convex.calls[1].args).not.toHaveProperty('asMembership')
    expect(s.now()).toMatchObject({ path: 'direct', kept: false })
    convex.calls[1].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    expect(steps(s.renders)).toEqual([
      [null, false],
      ['keeping', false],
      ['kept', true],
      ['direct', false],
    ])
  })
})

describe('without localStorage taking the page’s notes (`localNotesWork`), nothing is kept', () => {
  /** As a full or blocked localStorage refuses a write. */
  function refuseNotes() {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
  }

  test('Book goes straight, as it always did: nothing on the phone, nothing said whose it is, and the sheet closes on the job', async () => {
    const { backend, convex } = await phone()
    const s = screen(convex)
    refuseNotes()
    const { outcome, requestId, localId } = s.press()
    await flush()
    expect(backend.items.has(localId)).toBe(false)
    expect(convex.calls).toHaveLength(1)
    expect(convex.calls[0].args).toMatchObject({ clientRequestId: requestId })
    expect(convex.calls[0].args).not.toHaveProperty('asMembership')
    expect(s.now()).toMatchObject({ path: 'direct', kept: false })
    convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    expect(s.sheet.close).toHaveBeenCalledTimes(1)
  })

  test('the words above Book job say so as the sheet opens (`useCanKeep`)', async () => {
    await phone()
    const can = hookHarness.mount(() => useCanKeep(true))
    expect(can.current()).toBe(true)
    refuseNotes()
    // Opened again.
    const again = hookHarness.mount(() => useCanKeep(true))
    expect(again.current()).toBe(false)
  })
})

describe('closing New Job while the phone writes what an answer says (`useBooking` kept)', () => {
  test('a refusal, the phone slow to write it: true while the phone marks it as needing a look, false once the sheet is taking it off, and FormAlert once it has', async () => {
    const { backend, convex } = await phone()
    const s = screen(convex)
    const { outcome, localId } = s.press()
    await flush()
    expect(s.now()).toMatchObject({ path: 'kept', kept: true })
    slowChanges(backend, 1_000)
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    convex.calls[0].reject(refusal)
    await flush()
    // Answered, the phone still writing it: closing now keeps it.
    expect(backend.items.get(localId)?.state).toBe('sending')
    expect(s.now()).toMatchObject({ path: 'kept', kept: true })
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    // Needing a look, and the sheet taking it off: closing now asks first.
    expect(backend.items.get(localId)?.state).toBe('needsLook')
    expect(s.now()).toMatchObject({ path: null, kept: false })
    expect(outcome.error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(outcome.error).toBe(refusal)
    expect(backend.items.has(localId)).toBe(false)
    expect(s.sheet.booked).not.toHaveBeenCalled()
    expect(steps(s.renders)).toEqual([
      [null, false],
      ['keeping', false],
      ['kept', true],
      [null, false],
    ])
  })

  test('closed while the phone marks a refusal: booked said once, the booking needing a look in its day’s list, and true to the last', async () => {
    const { backend, convex } = await phone()
    const s = screen(convex)
    const { outcome, localId } = s.press()
    await flush()
    slowChanges(backend, 1_000)
    convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await flush()
    expect(s.now().kept).toBe(true)
    s.close()
    expect(s.sheet.booked).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    s.hook.rerender()
    expect(outcome.value).toEqual({ outcome: 'kept' })
    expect(backend.items.get(localId)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
    expect(s.now().slots.map((slot) => slot.item.localId)).toEqual([localId])
    expect(s.sheet.booked).toHaveBeenCalledTimes(1)
    expect(s.sheet.close).not.toHaveBeenCalled()
    expect(steps(s.renders)).toEqual([
      [null, false],
      ['keeping', false],
      ['kept', true],
    ])
  })

  test('closed while the phone holds one the kill switch refused: booked said, held on the phone, and nothing sent straight', async () => {
    const { backend, convex } = await phone()
    const s = screen(convex)
    const { outcome, localId } = s.press()
    await flush()
    slowChanges(backend, 1_000)
    convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
    await flush()
    expect(s.now().kept).toBe(true)
    s.close()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(outcome.value).toEqual({ outcome: 'kept' })
    expect(backend.items.get(localId)).toMatchObject({ state: 'waiting' })
    expect(convex.calls).toHaveLength(1)
    expect(s.sheet.booked).toHaveBeenCalledTimes(1)
  })

  test('closed by its unmount while its send is out: booked said as it goes, and a refusal after makes it need a look, never deleted (F1)', async () => {
    const { backend, convex } = await phone()
    const s = screen(convex)
    const { outcome, localId } = s.press()
    await flush()
    expect(convex.calls).toHaveLength(1)
    expect(s.now()).toMatchObject({ path: 'kept', kept: true })
    // The sheet goes, as ✕ takes it once the booking is kept: unmounted.
    s.hook.unmount()
    expect(s.sheet.booked).toHaveBeenCalledTimes(1)
    convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await flush()
    expect(outcome.value).toEqual({ outcome: 'kept' })
    expect(backend.items.get(localId)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
    expect(s.sheet.booked).toHaveBeenCalledTimes(1)
    expect(s.sheet.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(convex.calls).toHaveLength(1)
  })

  test('refused, the phone slower to take it off than the store’s own limit: false, and no FormAlert till the delete really lands; then FormAlert with nothing on the phone', async () => {
    const { backend, convex } = await phone()
    const s = screen(convex)
    const { outcome, localId } = s.press()
    await flush()
    slowDeletes(backend, STORE_OP_MS + 1_000)
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    convex.calls[0].reject(refusal)
    await flush()
    expect(s.now()).toMatchObject({ path: null, kept: false })
    await vi.advanceTimersByTimeAsync(STORE_OP_MS + 500)
    await flush()
    expect(outcome.error).toBeUndefined()
    expect(outcome.value).toBeUndefined()
    expect(backend.items.get(localId)?.state).toBe('needsLook')
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(outcome.error).toBe(refusal)
    expect(backend.items.has(localId)).toBe(false)
    expect(s.sheet.booked).not.toHaveBeenCalled()
  })
})

describe('New Job discarded while `kept` is false ("Discard your changes?"): the booking ends with the sheet', () => {
  test('while it is being kept: the sheet’s unmount gives the keep up, so nothing is on the phone, drawn, or sent', async () => {
    const { backend, convex } = await phone()
    const keeps = keepResults(backend)
    slowKeep(backend, KEEP_WAIT_MS - 300)
    const s = screen(convex)
    const { outcome, localId } = s.press()
    await flush()
    expect(s.now()).toMatchObject({ path: 'keeping', kept: false })
    // The sheet goes, as Discard takes it: given up on as it unmounts.
    const day = dayAlone()
    expect(localStorage.getItem(GIVEN_UP_KEY)).toBe(JSON.stringify([localId]))
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS)
    await flush()
    day.hook.rerender()
    // Refused in its own transaction, never written and taken off again.
    expect(keeps).toEqual(['refused'])
    expect(backend.items.has(localId)).toBe(false)
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    day.hook.rerender()
    expect(convex.calls).toHaveLength(0)
    expect(day.draws.length).toBeGreaterThan(1)
    for (const slots of day.draws) expect(slots).toEqual([])
    expect(s.sheet.booked).not.toHaveBeenCalled()
    expect(outcome.value).toEqual({ outcome: 'discarded' })
  })

  test('while it went straight, its keep reaching the store only after (the review’s PROBE-1): given up on as it went straight, so refused, never written, drawn or sent', async () => {
    const { backend, convex } = await phone()
    const keeps = keepResults(backend)
    slowKeep(backend, 1_800)
    slowChanges(backend, 2_000)
    const s = screen(convex)
    const { outcome, localId } = s.press()
    await flush()
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS)
    await flush()
    // Given up on as it went straight, before the keep reached the store.
    expect(localStorage.getItem(GIVEN_UP_KEY)).toBe(JSON.stringify([localId]))
    await vi.advanceTimersByTimeAsync(2_000 - KEEP_WAIT_MS)
    await flush()
    expect(keeps).toEqual(['refused'])
    expect(convex.calls).toHaveLength(1)
    convex.calls[0].reject(new Error('Server Error'))
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(outcome.error).toBeInstanceOf(Error)
    expect(s.now()).toMatchObject({ path: null, kept: false })
    const day = dayAlone()
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()
    day.hook.rerender()
    expect(backend.items.has(localId)).toBe(false)
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    day.hook.rerender()
    expect(convex.calls).toHaveLength(1)
    for (const slots of day.draws) expect(slots).toEqual([])
    expect(s.sheet.booked).not.toHaveBeenCalled()
  })

  test('while it went straight, its keep written in time but landing after the call was refused: taken off the phone by the sheet as it lands, and never drawn or sent', async () => {
    const { backend, convex } = await phone()
    const keeps = keepResults(backend)
    // Written at 1.4 s, before New Job stopped waiting; answered at 2.5 s.
    keepWrittenThenAnswered(backend, KEEP_WAIT_MS - 100, 1_100)
    const s = screen(convex)
    const { outcome, localId } = s.press()
    await flush()
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS)
    await flush()
    expect(convex.calls).toHaveLength(1)
    expect(backend.items.get(localId)?.state).toBe('waiting')
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    convex.calls[0].reject(refusal)
    await flush()
    expect(outcome.error).toBe(refusal)
    // FormAlert, ✕ asks, and the person discards: the sheet goes.
    const day = dayAlone()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    day.hook.rerender()
    expect(keeps).toEqual(['kept'])
    expect(backend.items.has(localId)).toBe(false)
    expect(localStorage.getItem(GIVEN_UP_KEY)).toBeNull()
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    day.hook.rerender()
    expect(convex.calls).toHaveLength(1)
    expect(backend.items.has(localId)).toBe(false)
    for (const slots of day.draws) expect(slots).toEqual([])
    expect(s.sheet.booked).not.toHaveBeenCalled()
  })
})

describe('what a day’s list draws of a booking (`useOutboxDay`)', () => {
  test('booked with signal: never a slot, from the press to the job in the list and the sheet gone', async () => {
    const { convex } = await phone()
    const s = screen(convex)
    const { outcome, requestId } = s.press()
    await flush()
    expect(convex.calls).toHaveLength(1)
    convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    s.setRows([
      { _id: 'job-1', clientRequestId: requestId } as unknown as JobRow,
    ])
    s.close()
    await flush()
    s.hook.rerender()
    expect(s.renders.length).toBeGreaterThan(4)
    for (const drawn of s.renders) {
      expect(drawn.slots).toEqual([])
      expect(drawn.hidden.size).toBe(0)
      expect(drawn.heading).toBeNull()
    }
  })

  test('kept with no signal, then sent: drawn as sent the moment its answer is heard, the phone’s storage still saying sending', async () => {
    const { backend, convex } = await phone()
    page.keeper.live = false
    const s = screen(convex)
    const { localId } = s.press()
    await flush()
    expect(s.sheet.close).toHaveBeenCalledTimes(1)
    s.close()
    await flush()
    expect(s.now().slots.map((slot) => slot.chip)).toEqual(['waiting'])
    page.keeper.live = true
    page.keeper.changed()
    await flush()
    expect(convex.calls).toHaveLength(1)
    expect(s.now().slots.map((slot) => slot.chip)).toEqual(['sending'])
    slowChanges(backend, 1_000)
    convex.calls[0].resolve('job-1')
    await flush()
    expect(backend.items.get(localId)?.state).toBe('sending')
    expect(s.now().slots.map((slot) => slot.chip)).toEqual(['sent'])
    expect(s.now().heading).toBe('Sent')
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(backend.items.get(localId)?.state).toBe('sent')
    expect(s.now().slots.map((slot) => slot.chip)).toEqual(['sent'])
  })
})

describe('New Job’s lock and what Book hears of the screen go in one commit (`useNewJobBooking`, `shown`)', () => {
  /**
   * New Job's hooks as its form calls them (`useNewJobBooking`), over a
   * sheet's lock registry: the locks held at each moment, by the registry's
   * own account, and each one's Discard, as the sheet calls it when
   * "Discard your changes?" is confirmed.
   */
  function newJobForm(convex: FakeConvex) {
    const locks = new Map<string, SheetLockEntry>()
    react.lockRegistry = (id: string, lock: SheetLockEntry | null) => {
      if (lock === null) locks.delete(id)
      else locks.set(id, lock)
    }
    const sheet = { booked: vi.fn(), close: vi.fn() }
    const call = (made: BookingCall) =>
      made.fn === 'jobs.create'
        ? convex.mutation(api.jobs.create, made.args)
        : convex.mutation(api.recurrences.create, made.args)
    const hook = hookHarness.mount(() => {
      const draft = useDraftRequestId()
      // Something typed, as by the time Book can be pressed.
      const booking = useNewJobBooking(true, sheet, call)
      return { draft, booking }
    })
    return {
      locks,
      sheet,
      hook,
      /** "Discard your changes?" confirmed, as the sheet tells its forms. */
      discard() {
        for (const lock of [...locks.values()]) lock.discarded()
      },
      press() {
        const { booking, draft } = hook.current()
        const outcome: { value?: unknown; error?: unknown } = {}
        void booking.session.book(ARGS, draft, WHO).then(
          (value) => {
            outcome.value = value
          },
          (error: unknown) => {
            outcome.error = error
          },
        )
        return { outcome, localId: draft.localId }
      },
    }
  }

  test('sent only once the sheet’s lock is off: a tap from the moment Book goes on as kept closes it without asking', async () => {
    const { backend, convex } = await phone()
    slowKeep(backend, KEEP_WAIT_MS / 2)
    const form = newJobForm(convex)
    expect(form.locks.size).toBe(1)
    const lockedAtSend: Array<number> = []
    const send = sender.sendHeld.bind(sender)
    const spy = vi.spyOn(sender, 'sendHeld').mockImplementation((...args) => {
      lockedAtSend.push(form.locks.size)
      return send(...args)
    })
    form.press()
    await flush()
    // From here what React runs after a commit waits, as a tap can land
    // before it does.
    react.holdPassive = true
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS / 2)
    await flush()
    expect(convex.calls).toHaveLength(1)
    expect(lockedAtSend).toEqual([0])
    spy.mockRestore()
  })

  test('a refusal taken off the phone only once the lock is back: a tap from the moment it goes asks first', async () => {
    const { backend, convex } = await phone()
    const form = newJobForm(convex)
    const { outcome, localId } = form.press()
    await flush()
    expect(form.locks.size).toBe(0)
    const lockedAtDelete: Array<number> = []
    const update = backend.update.bind(backend)
    backend.update = (epoch, id, change) => {
      const now = backend.items.get(id)
      if (now && change(structuredClone(now)) === 'delete') {
        lockedAtDelete.push(form.locks.size)
      }
      return update(epoch, id, change)
    }
    react.holdPassive = true
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    convex.calls[0].reject(refusal)
    await flush()
    expect(outcome.error).toBe(refusal)
    expect(backend.items.has(localId)).toBe(false)
    expect(lockedAtDelete).toEqual([1])
  })

  test('Discard confirmed over a Back before the keep lands, the move landing after it (the review’s mutation): discarded as it is confirmed, so booked is never said, and nothing is kept or sent', async () => {
    const { backend, convex } = await phone()
    page.keeper.live = false
    const keeps = keepResults(backend)
    slowKeep(backend, 1_000)
    const form = newJobForm(convex)
    const { outcome, localId } = form.press()
    // Back at 0.3 s: still being kept, so the sheet asks first.
    await vi.advanceTimersByTimeAsync(300)
    expect([...form.locks.values()].map((lock) => lock.changed)).toEqual([true])
    // Discard at 0.5 s; the keep reaches the store at 1 s; the move lands,
    // and the sheet goes, at 2 s.
    await vi.advanceTimersByTimeAsync(200)
    form.discard()
    await vi.advanceTimersByTimeAsync(1_500)
    await flush()
    form.hook.unmount()
    await flush()
    expect(outcome.value).toEqual({ outcome: 'discarded' })
    expect(keeps).toEqual(['refused'])
    expect(backend.items.has(localId)).toBe(false)
    expect(form.sheet.booked).not.toHaveBeenCalled()
    expect(form.sheet.close).not.toHaveBeenCalled()
    // The line back, and every hold and retry past: nothing goes.
    page.keeper.live = true
    page.keeper.changed()
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    expect(convex.calls).toHaveLength(0)
    expect(backend.items.has(localId)).toBe(false)
  })

  test('Discard over a Back whose move never lands, the keep written at 0.5 s and answering at 10 s, then Book again (the review’s PROBE-R7 B2): the draft keeps nothing more, so that press goes straight as the person’s own; the booking stays given up till it is off, and nothing of it is ever sent', async () => {
    const { backend, convex } = await phone()
    keepWrittenThenAnswered(backend, 500, 9_500)
    const form = newJobForm(convex)
    const first = form.press()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(backend.items.get(first.localId)?.state).toBe('waiting')
    // Discard at 1 s; the move never lands, so the sheet stays up.
    form.discard()
    await vi.advanceTimersByTimeAsync(600)
    await flush()
    expect(first.outcome.value).toEqual({ outcome: 'discarded' })
    expect(form.hook.current().draft.keepable).toBe(false)
    // Book again at 2 s, on the same draft.
    await vi.advanceTimersByTimeAsync(400)
    const second = form.press()
    await flush()
    expect(second.localId).toBe(first.localId)
    expect(convex.calls).toHaveLength(1)
    expect(convex.calls[0].args).toMatchObject({ asMembership: M1 })
    const refusal = new Error('Server Error')
    convex.calls[0].reject(refusal)
    await flush()
    expect(second.outcome.error).toBe(refusal)
    // Still the first press's to take off: given up, and shown by nothing.
    expect(JSON.parse(localStorage.getItem(GIVEN_UP_KEY) ?? '[]')).toEqual([
      first.localId,
    ])
    expect(outbox.get(first.localId)).toBeUndefined()
    form.hook.unmount()
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    expect(backend.items.has(first.localId)).toBe(false)
    expect(localStorage.getItem(GIVEN_UP_KEY) ?? '[]').toBe('[]')
    expect(convex.calls).toHaveLength(1)
    expect(form.sheet.booked).not.toHaveBeenCalled()
  })
})
