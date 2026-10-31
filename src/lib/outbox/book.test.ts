import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, hashKey } from '@tanstack/react-query'
import { ConvexError } from 'convex/values'
import { getFunctionName } from 'convex/server'
import { api } from '../../../convex/_generated/api'
import { logConnection } from '#/lib/connectionLog'
import { rq } from '#/lib/routeQueries'
import { isTwoStepNeeded } from '#/lib/twoStep'
import {
  BookingSession,
  LEFT_ON_PHONE,
  bookOutcome,
  canKeepNow,
  leftOnPhoneChange,
  saysKept,
  takeOffChange,
} from './book'
import { FakeLockManager } from './fakeLocks.fixtures'
import { addRule, answeredView, latchSlots } from './latchSlots'
import { OutboxModel } from './outbox'
import { itemLock } from './outboxLocks'
import {
  ANSWER_WAIT_MS,
  FIRST_VISIT_GONE_MS,
  KEEP_WAIT_MS,
  STORE_OP_MS,
} from './outboxSet'
import {
  checkOutboxOwner,
  forgetGivenUp,
  giveUpKeep,
  localNotesWork,
  setOutboxBackendForTests,
} from './outboxStore'
import {
  B1,
  DISPLAY,
  bookingFor,
  memoryStorage,
  outboxOf,
  personOf,
} from './outboxStore.fixtures'
import { Sender } from './sender'
import { resetSwitchGateForTests } from './switchGate'
import type { QueryKey } from '@tanstack/react-query'
import type * as TwoStep from '#/lib/twoStep'
import type { Access } from '#/lib/access'
import type { Id } from '../../../convex/_generated/dataModel'
import type {
  BookFacts,
  BookingDeps,
  BookingDraft,
  BookingPath,
  BookingWho,
} from './book'
import type { LatchResult, LatchRow, SlotLatch } from './latchSlots'
import type { BookingCall, OutboxItem, SendableBooking } from './outboxItem'
import type { SenderDeps } from './sender'

/**
 * Book in New Job: the booking kept on the phone first, then sent, and what
 * the sheet does with each outcome (plan part 2c §3.2, §6.4).
 *
 * First the decisions, pure (`bookOutcome`), one per row of §3.2. Then a
 * press of Book as the sheet makes it (`BookingSession`), against the real
 * sender and outbox, in memory, as sender.test.ts runs them: Web Locks in
 * memory, a real QueryClient for access:me, and a Convex client and keeper
 * faked, each call answered by hand.
 */

vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))
const who = vi.hoisted((): { id: string | null } => ({ id: 'u1' }))
vi.mock('#/lib/rootState', () => ({
  signedInUserId: () => who.id,
  signedOutAfterAll: vi.fn(async () => false),
}))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))
vi.mock('#/lib/twoStep', async (importOriginal) => ({
  ...(await importOriginal<typeof TwoStep>()),
  flagIfTwoStepNeeded: vi.fn(),
  isTwoStepNeeded: vi.fn(() => false),
}))

const NOW = Date.UTC(2026, 9, 27, 0)
const M1 = 'm-u1' as Id<'memberships'>
const BUSINESS = { _id: B1, slug: 'pest-co', timezone: 'Australia/Perth' }
const REQUEST = '11111111-1111-4111-8111-111111111111'
const LOCAL = 'local-booking'

// ── The decisions ──────────────────────────────────────────────────────────

describe('bookOutcome: each step of a press of Book', () => {
  const kept = (extra: Partial<BookFacts> = {}): BookFacts => ({
    canKeep: true,
    keep: 'kept',
    lineLive: true,
    ...extra,
  })

  test('nothing can be kept: straight to the server, with no `asMembership`', () => {
    expect(bookOutcome({ canKeep: false })).toEqual({
      do: 'direct',
      asMembership: false,
      stopKeeping: false,
    })
  })

  test('a draft that went straight as the person’s own (a keep of it took too long): every press after says whose it is too', () => {
    expect(bookOutcome({ canKeep: false, asOwn: true })).toEqual({
      do: 'direct',
      asMembership: true,
      stopKeeping: false,
    })
    // Refused by the kill switch for saying so: again without, as the first.
    expect(
      bookOutcome({
        canKeep: false,
        asOwn: true,
        direct: {
          answer: { error: new ConvexError('OUTBOX_PAUSED') },
          asMembership: true,
        },
      }),
    ).toEqual({ do: 'direct', asMembership: false, stopKeeping: false })
  })

  test('it can: kept first', () => {
    expect(bookOutcome({ canKeep: true })).toEqual({ do: 'keep' })
  })

  test.each(['late', 'error', 'refused', 'exists'] as const)(
    'a keep that came to %s: straight, as the person’s own, and the draft keeps nothing more',
    (result) => {
      expect(bookOutcome({ canKeep: true, keep: result })).toEqual({
        do: 'direct',
        asMembership: true,
        stopKeeping: true,
      })
    },
  )

  test('kept with the line down: the sheet closes as soon as it is stored', () => {
    expect(bookOutcome(kept({ lineLive: false }))).toEqual({ done: 'kept' })
  })

  test('kept with the line live: the sender’s own send', () => {
    expect(bookOutcome(kept())).toEqual({ do: 'send' })
  })

  test('its answer: a job closes the sheet; a refusal is FormAlert’s; nothing in time, or anything else, kept', () => {
    expect(
      bookOutcome(kept({ sent: { outcome: 'sent', id: 'job-1' } })),
    ).toEqual({ done: 'sent', id: 'job-1' })
    const error = new ConvexError('INVALID_ASSIGNEE')
    expect(bookOutcome(kept({ sent: { outcome: 'refused', error } }))).toEqual({
      done: 'refused',
      error,
    })
    expect(bookOutcome(kept({ sent: { outcome: 'kept' } }))).toEqual({
      done: 'kept',
    })
  })

  test('OUTBOX_PAUSED inside the wait: gone from the phone, sent straight without `asMembership`', () => {
    const paused = new ConvexError('OUTBOX_PAUSED')
    expect(
      bookOutcome(kept({ sent: { outcome: 'paused', error: paused } })),
    ).toEqual({
      do: 'direct',
      asMembership: false,
      stopKeeping: false,
    })
  })

  test('a straight call: its job, or its refusal', () => {
    expect(
      bookOutcome({
        canKeep: false,
        direct: { answer: { ok: 'job-1' }, asMembership: false },
      }),
    ).toEqual({ done: 'sent', id: 'job-1' })
    const error = new Error('Server Error')
    expect(
      bookOutcome({
        canKeep: false,
        direct: { answer: { error }, asMembership: false },
      }),
    ).toEqual({ done: 'refused', error })
  })

  test('the fallback refused OUTBOX_PAUSED for saying whose it is: again without', () => {
    const paused = new ConvexError('OUTBOX_PAUSED')
    expect(
      bookOutcome({
        canKeep: true,
        keep: 'late',
        direct: { answer: { error: paused }, asMembership: true },
      }),
    ).toEqual({ do: 'direct', asMembership: false, stopKeeping: false })
    // Without it, the same refusal is only a refusal.
    expect(
      bookOutcome({
        canKeep: true,
        keep: 'late',
        direct: { answer: { error: paused }, asMembership: false },
      }),
    ).toEqual({ done: 'refused', error: paused })
  })

  test('a late keep never changes what the straight call came to: its refusal is FormAlert’s', () => {
    const error = new Error('Server Error')
    expect(
      bookOutcome({
        canKeep: true,
        keep: 'late',
        direct: { answer: { error }, asMembership: true },
      }),
    ).toEqual({ done: 'refused', error })
  })

  test('discarded as it was being kept: nothing goes, straight or from the phone; kept in time, it comes off again', () => {
    const discarded = { canKeep: true, closed: 'discarded' } as const
    expect(bookOutcome({ ...discarded, keep: 'kept', lineLive: true })).toEqual(
      { do: 'unkeep' },
    )
    expect(
      bookOutcome({ ...discarded, keep: 'kept', lineLive: true, unkept: true }),
    ).toEqual({ done: 'discarded' })
    // Not kept in time: given up as the press stopped waiting, and whatever
    // of it lands comes off then (`settle`). Never straight.
    for (const keep of ['late', 'exists', 'refused', 'error'] as const) {
      expect(bookOutcome({ ...discarded, keep })).toEqual({
        done: 'discarded',
      })
    }
  })

  test('a refusal’s booking the sheet couldn’t take off the phone: kept, the sheet open; discarded, taken off again', () => {
    const error = new ConvexError('INVALID_ASSIGNEE')
    const left = { state: 'needsLook', updatedAt: 1 } as OutboxItem
    const refused = (extra: Partial<BookFacts>) =>
      bookOutcome(kept({ sent: { outcome: 'refused', error, left }, ...extra }))
    expect(refused({})).toEqual({ do: 'drop', left, paused: false })
    expect(refused({ dropped: 'gone' })).toEqual({ done: 'refused', error })
    expect(refused({ dropped: 'kept' })).toEqual({ done: 'kept' })
    expect(refused({ dropped: 'kept', closed: 'discarded' })).toEqual({
      do: 'unkeep',
    })
    expect(
      refused({ dropped: 'kept', closed: 'discarded', unkept: true }),
    ).toEqual({ done: 'discarded' })
    // The kill switch's: straight only once it is off the phone.
    const paused = new ConvexError('OUTBOX_PAUSED')
    const held = (extra: Partial<BookFacts>) =>
      bookOutcome(
        kept({ sent: { outcome: 'paused', error: paused, left }, ...extra }),
      )
    expect(held({})).toEqual({ do: 'drop', left, paused: true })
    expect(held({ dropped: 'kept' })).toEqual({ done: 'kept' })
    expect(held({ dropped: 'gone' })).toEqual({
      do: 'direct',
      asMembership: false,
      stopKeeping: false,
    })
  })

  test('a booking nothing is to send leaves the phone whatever an answer made of it, unless its job was made', () => {
    const off = takeOffChange()
    for (const state of ['waiting', 'sending', 'needsLook'] as const) {
      expect(off({ state, attempts: 1 } as OutboxItem)).toBe('delete')
    }
    expect(off({ state: 'sent' } as OutboxItem)).toBe('abort')
  })

  test('one the phone couldn’t take off is left needing a look, so it shows and never goes by itself; never one that went', () => {
    const left = leftOnPhoneChange(NOW)
    for (const state of ['waiting', 'needsLook'] as const) {
      expect(
        left({
          state,
          problem: null,
          holdUntil: NOW + 60_000,
          retryAt: NOW + 60_000,
          updatedAt: 1,
        } as OutboxItem),
      ).toMatchObject({
        state: 'needsLook',
        problem: { code: LEFT_ON_PHONE },
        holdUntil: null,
        retryAt: null,
        updatedAt: NOW,
      })
    }
    for (const state of ['sending', 'sent'] as const) {
      expect(left({ state } as OutboxItem)).toBe('abort')
    }
  })

  test('can it be kept: every condition, each alone enough to say no', () => {
    const yes = {
      enabled: true,
      locks: true,
      readable: true,
      notes: true,
      keepable: true,
      lens: 'lens',
      userId: 'u1',
    }
    expect(canKeepNow(yes)).toBe(true)
    for (const no of [
      { enabled: false },
      { locks: false },
      { readable: false },
      { notes: false },
      { keepable: false },
      { lens: null },
      { userId: null },
    ]) {
      expect(canKeepNow({ ...yes, ...no })).toBe(false)
    }
  })
})

// ── A press of Book ────────────────────────────────────────────────────────

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

type Call = {
  fn: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

class FakeConvex {
  readonly calls: Array<Call> = []
  /** What `clientRequests.find` answers: nothing ever, until set. */
  findAnswer: unknown = undefined
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
    const answer = this.findAnswer
    return {
      onUpdate: (update: () => void) => {
        if (answer !== undefined) queueMicrotask(update)
        return () => {}
      },
      localQueryResult: () => answer,
    }
  }
}

class FakeKeeper {
  live = true
  conn = 1
  readonly liveKeys = new Set<string>()
  private readonly listeners = new Set<() => void>()
  lineLive = () => this.live
  isLive = (key: QueryKey) => this.liveKeys.has(hashKey(key))
  enteredBusiness = () => BUSINESS
  socketUserId = () => 'u1'
  connection = () => this.conn
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

const stops: Array<() => void> = []

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0)
}

/** A phone signed in as u1, in B1, with access:me live and nothing kept. */
async function phone(opts: { enabled?: boolean; locks?: boolean } = {}) {
  const backend = await outboxOf('u1', [])
  setOutboxBackendForTests(backend)
  checkOutboxOwner(personOf('u1'))
  await flush(3)
  const lockManager = new FakeLockManager()
  const locks = lockManager.forTab('tab-a')
  const convex = new FakeConvex()
  const keeper = new FakeKeeper()
  const qc = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  })
  const accessKey = rq.access(B1).queryKey as QueryKey
  qc.setQueryData(accessKey, own)
  keeper.liveKeys.add(hashKey(accessKey))
  const model = new OutboxModel()
  stops.push(model.start(() => null))
  const sender = new Sender()
  stops.push(
    sender.attach({
      convex: convex as unknown as SenderDeps['convex'],
      qc,
      keeper,
      locks,
      outbox: model,
    }),
  )
  await model.refresh()
  await flush()
  const sheet = newSheet()
  const call = (made: BookingCall) =>
    made.fn === 'jobs.create'
      ? convex.mutation(api.jobs.create, made.args)
      : convex.mutation(api.recurrences.create, made.args)
  const deps: BookingDeps = {
    enabled: opts.enabled ?? true,
    locks: opts.locks === false ? null : locks,
    readable: () => true,
    notes: localNotesWork,
    lineLive: () => keeper.live,
    call,
    keep: (item, landed) => model.keep(item, landed),
    giveUp: giveUpKeep,
    forgetGivenUp,
    change: (op, localId, change) => model.changeLanded(op, localId, change),
    deciding: (localId, on) => model.deciding(localId, on),
    answeredOnScreen: (localId) => model.answeredOnScreen(localId),
    sender,
  }
  const { session } = sessionOn(deps, sheet)
  return {
    backend,
    lockManager,
    convex,
    keeper,
    qc,
    model,
    sender,
    sheet,
    deps,
    session,
  }
}

type Phone = Awaited<ReturnType<typeof phone>>

/**
 * What the sheet is told, as the hook's state has it, and what its screen
 * then shows, told back to the session as the commit that draws it tells it
 * (`shown`): at once, unless `lag` holds the screen a render behind, until
 * `draw`.
 */
function newSheet() {
  const sheet = {
    booked: vi.fn(),
    close: vi.fn(),
    path: vi.fn((path: BookingPath) => {
      sheet.now = path
      if (!sheet.lag) sheet.draw()
    }),
    /** Where the booking is, as last told: `kept` lifts the sheet lock. */
    now: null as BookingPath,
    /** The screen a render behind what the sheet was told. */
    lag: false,
    session: null as BookingSession | null,
    /** The screen catches up with `now`. */
    draw: () => sheet.session?.shown(sheet.now === 'kept'),
  }
  return sheet
}

/** A New Job sheet's session, its screen telling it what it shows. */
function sessionOn(deps: BookingDeps, sheet = newSheet()) {
  const session = new BookingSession(deps, sheet)
  sheet.session = session
  return { session, sheet }
}

function draft() {
  return {
    requestId: REQUEST,
    localId: LOCAL,
    keepable: true as boolean,
    stopKeeping: vi.fn<() => void>(),
    renew: vi.fn<() => void>(),
  } satisfies BookingDraft
}

const WHO: BookingWho = {
  userId: 'u1',
  lens: 'lens',
  membershipId: M1,
  business: { slug: 'pest-co', name: 'Pest Co' },
  display: () => DISPLAY,
}

const ARGS = bookingFor() as SendableBooking

const stored = (p: Phone) => p.backend.items.get(LOCAL)

/** A press of Book, its outcome caught. */
function press(
  p: Phone,
  d = draft(),
  session = p.session,
  args: SendableBooking = ARGS,
) {
  const outcome: { value?: unknown; error?: unknown; done: boolean } = {
    done: false,
  }
  void session.book(args, d, WHO).then(
    (value) => {
      outcome.value = value
      outcome.done = true
    },
    (error: unknown) => {
      outcome.error = error
      outcome.done = true
    },
  )
  return { outcome, draft: d }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubGlobal('localStorage', memoryStorage())
  who.id = 'u1'
  vi.mocked(logConnection).mockClear()
  vi.mocked(isTwoStepNeeded).mockReturnValue(false)
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  resetSwitchGateForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('with keeping switched off', () => {
  test('straight to the server, with the draft’s request id and nothing else new; nothing kept; the sheet closes on the job', async () => {
    const p = await phone({ enabled: false })
    const { outcome, draft: d } = press(p)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    expect(p.convex.calls[0].fn).toBe('jobs:create')
    expect(p.convex.calls[0].args).toMatchObject({
      propertyId: 'p1',
      clientRequestId: REQUEST,
    })
    expect(p.convex.calls[0].args).not.toHaveProperty('asMembership')
    expect(p.backend.done).not.toContain('keep')
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    expect(d.renew).toHaveBeenCalledTimes(1)
  })

  test('as it always was: the job back after the sheet closed still closes it, and says booked', async () => {
    const p = await phone({ enabled: false })
    const { outcome } = press(p)
    await flush()
    p.session.dispose()
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.done).toBe(true)
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
  })

  test('a refusal is thrown for FormAlert, and the draft keeps its ids for the retry', async () => {
    const p = await phone({ enabled: false })
    const { outcome, draft: d } = press(p)
    await flush()
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    p.convex.calls[0].reject(refusal)
    await flush()
    expect(outcome.error).toBe(refusal)
    expect(p.sheet.close).not.toHaveBeenCalled()
    expect(d.renew).not.toHaveBeenCalled()
    const retry = press(p, d)
    await flush()
    expect(p.convex.calls[1].args.clientRequestId).toBe(REQUEST)
    p.convex.calls[1].resolve('job-1')
    await flush()
    expect(retry.outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
  })
})

describe('kept on the phone', () => {
  test('with the line down: stored, the sheet told it is safe, and closed at once with no call', async () => {
    const p = await phone()
    p.keeper.live = false
    const { outcome } = press(p)
    await flush()
    expect(outcome.value).toEqual({ outcome: 'kept' })
    expect(p.sheet.path.mock.calls).toEqual([['keeping'], ['kept']])
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    expect(p.convex.calls).toEqual([])
    expect(stored(p)).toMatchObject({
      state: 'waiting',
      requestId: REQUEST,
      membershipId: M1,
      userId: 'u1',
    })
    // Let go, so the sender can send it once the line is back.
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
    expect(notes('outbox-keep')).toEqual([
      expect.objectContaining({ result: 'kept' }),
    ])
  })

  test('with the line live: sent at once by the sender, with its key and whose it is; the job closes the sheet', async () => {
    const p = await phone()
    const { outcome, draft: d } = press(p)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    expect(p.convex.calls[0].args).toMatchObject({
      clientRequestId: REQUEST,
      asMembership: M1,
    })
    expect(stored(p)?.state).toBe('sending')
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    expect(d.renew).toHaveBeenCalledTimes(1)
    expect(stored(p)?.state).toBe('sent')
  })

  test('while its sheet waits on it, a day’s list draws none of it: booked with signal, it lands in the list as it always did', async () => {
    const p = await phone()
    press(p)
    await flush()
    expect(p.model.isDeciding(LOCAL)).toBe(true)
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(p.model.isDeciding(LOCAL)).toBe(false)
  })

  test('closed on the booking kept: drawn from then', async () => {
    const p = await phone()
    p.keeper.live = false
    press(p)
    await flush()
    expect(p.sheet.close).toHaveBeenCalled()
    expect(p.model.isDeciding(LOCAL)).toBe(false)
    expect(p.model.keptHere.has(LOCAL)).toBe(true)
  })

  test('the sheet runs no wait of its own: nothing in time, it closes with the booking kept, once the sender says so', async () => {
    const p = await phone()
    const { outcome } = press(p)
    await flush()
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1)
    expect(outcome.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(outcome.value).toEqual({ outcome: 'kept' })
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    // The call is still out, under the lock, which goes with it.
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
    expect(stored(p)?.state).toBe('sending')
  })

  test('a refusal that made nothing, the sheet still open: FormAlert’s, gone from the phone, and nothing booked if the person then closes it', async () => {
    const p = await phone()
    const { outcome, draft: d } = press(p)
    await flush()
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    p.convex.calls[0].reject(refusal)
    await flush()
    expect(outcome.error).toBe(refusal)
    expect(stored(p)).toBeUndefined()
    expect(p.sheet.close).not.toHaveBeenCalled()
    expect(d.renew).not.toHaveBeenCalled()
    p.session.dispose()
    expect(p.sheet.booked).not.toHaveBeenCalled()
  })

  test('the sheet closed, then a refusal: the item ends up needing a look, never deleted (F1); booked said once, when it closed', async () => {
    const p = await phone()
    const { outcome } = press(p)
    await flush()
    p.session.dispose()
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await flush()
    expect(stored(p)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
    expect(outcome.value).toEqual({ outcome: 'kept' })
    // Nothing on screen changes: the person closed it.
    expect(p.sheet.close).not.toHaveBeenCalled()
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
  })

  test('the answer arrives after a second New Job has opened: the first’s close isn’t called (S10)', async () => {
    const p = await phone()
    const first = press(p)
    await flush()
    // The person closes it, and books another.
    p.session.dispose()
    const { session: second, sheet: secondSheet } = sessionOn(p.deps)
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(first.outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    expect(p.sheet.close).not.toHaveBeenCalled()
    expect(secondSheet.close).not.toHaveBeenCalled()
    second.dispose()
  })

  test('a refusal inside the wait that crossed a reconnect: kept and locked, and the sheet closes (F13)', async () => {
    const p = await phone()
    const { outcome } = press(p)
    await flush()
    p.keeper.conn++
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await flush()
    expect(outcome.value).toEqual({ outcome: 'kept' })
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    expect(stored(p)?.state).toBe('sending')
  })

  test('OUTBOX_PAUSED inside the wait: the item deleted, sent straight without `asMembership`, with the same id', async () => {
    const p = await phone()
    const { outcome } = press(p)
    await flush()
    p.convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
    await flush()
    expect(stored(p)).toBeUndefined()
    expect(p.convex.calls).toHaveLength(2)
    expect(p.convex.calls[1].args.clientRequestId).toBe(REQUEST)
    expect(p.convex.calls[1].args).not.toHaveProperty('asMembership')
    p.convex.calls[1].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
  })

  test('closed while its send is out, kept: drawn in its day’s list from the moment it closes', async () => {
    const p = await phone()
    press(p)
    await flush()
    expect(p.model.isDeciding(LOCAL)).toBe(true)
    p.session.dispose()
    expect(p.model.isDeciding(LOCAL)).toBe(false)
    expect(p.model.mayDraw(LOCAL)).toBe(true)
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    // Its answer, later, is the slot's to draw (the swap).
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(p.model.mayDraw(LOCAL)).toBe(true)
  })

  test('closed on its job, with signal: never drawn as itself, this page load', async () => {
    const p = await phone()
    press(p)
    await flush()
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    p.session.dispose()
    expect(p.model.mayDraw(LOCAL)).toBe(false)
  })

  test('kept, then refused inside the wait: the sheet hears it isn’t on the phone any more, so closing it asks again', async () => {
    const p = await phone()
    press(p)
    await flush()
    expect(p.sheet.now).toBe('kept')
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await flush()
    expect(stored(p)).toBeUndefined()
    expect(p.sheet.now).toBeNull()
  })

  test('kept, then OUTBOX_PAUSED: sent straight with nothing on the phone, so the sheet asks before it closes, and closing it books nothing it says', async () => {
    const p = await phone()
    press(p)
    await flush()
    expect(p.sheet.now).toBe('kept')
    p.convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
    await flush()
    expect(p.convex.calls).toHaveLength(2)
    expect(p.sheet.now).toBe('direct')
    // Discarded while the straight call waits on the line.
    p.session.dispose()
    expect(p.sheet.booked).not.toHaveBeenCalled()
  })

  test('the sheet gone before its keep lands, which asked first: discarded, so the keep is refused, never written, and nothing is sent', async () => {
    const p = await phone()
    slowKeep(p, KEEP_WAIT_MS / 2)
    const { outcome } = press(p)
    await flush()
    // Still being kept: closing it asks "Discard your changes?".
    expect(p.sheet.now).toBe('keeping')
    p.session.dispose()
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS / 2)
    await flush()
    expect(p.backend.items.size).toBe(0)
    expect(p.convex.calls).toHaveLength(0)
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
    expect(p.model.isDeciding(LOCAL)).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(p.convex.calls).toHaveLength(0)
    expect(p.sheet.booked).not.toHaveBeenCalled()
    expect(outcome.value).toEqual({ outcome: 'discarded' })
  })

  test('booked is said once: the sheet closed on the booking kept, then unmounted', async () => {
    const p = await phone()
    p.keeper.live = false
    press(p)
    await flush()
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    p.session.dispose()
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
  })

  test('a keep that throws: straight, saying whose it is, and the draft keeps nothing more', async () => {
    const p = await phone()
    p.deps.keep = () => Promise.reject(new Error('storage'))
    const { draft: d } = press(p)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    expect(p.convex.calls[0].args).toMatchObject({
      clientRequestId: REQUEST,
      asMembership: M1,
    })
    expect(d.stopKeeping).toHaveBeenCalledTimes(1)
    expect(p.sheet.now).toBe('direct')
  })

  test('a Recurring Job booked with signal, its first visit 23 hours and more back: booked as online books it, the server saying whether that visit has gone', async () => {
    const p = await phone()
    const args = bookingFor({
      scheduledAt: NOW - FIRST_VISIT_GONE_MS - 30 * 60_000,
      repeat: { count: 3, unit: 'month' },
    }) as SendableBooking
    const { outcome } = press(p, draft(), p.session, args)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    expect(p.convex.calls[0].fn).toBe('recurrences:create')
    expect(p.convex.calls[0].args).toMatchObject({ refuseBackfill: true })
    p.convex.calls[0].resolve('series-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'series-1' })
  })

  test('without Web Locks nothing is kept: straight, as before', async () => {
    const p = await phone({ locks: false })
    press(p)
    await flush()
    expect(p.backend.done).not.toContain('keep')
    expect(p.convex.calls[0].args).not.toHaveProperty('asMembership')
    expect(p.sheet.path.mock.calls).toEqual([['direct']])
  })

  test('without localStorage taking the page’s notes nothing is kept: straight, as before, so no keep the page couldn’t note as given up is ever on the phone', async () => {
    const p = await phone()
    // As a full or blocked localStorage refuses a write.
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const { outcome, draft: d } = press(p)
    await flush()
    expect(p.backend.done).not.toContain('keep')
    expect(p.backend.items.size).toBe(0)
    expect(p.convex.calls).toHaveLength(1)
    expect(p.convex.calls[0].args).toMatchObject({ clientRequestId: REQUEST })
    expect(p.convex.calls[0].args).not.toHaveProperty('asMembership')
    expect(p.sheet.path.mock.calls).toEqual([['direct']])
    expect(d.stopKeeping).not.toHaveBeenCalled()
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
  })
})

describe('the words above Book job (`saysKept`)', () => {
  test('as a press now would, until one is under way; then as that press goes, never kept once it went straight', () => {
    expect(saysKept({ pending: false, path: null, canKeep: true })).toBe(true)
    expect(saysKept({ pending: false, path: null, canKeep: false })).toBe(false)
    // Pressed, its path not told yet: as predicted.
    expect(saysKept({ pending: true, path: null, canKeep: true })).toBe(true)
    expect(saysKept({ pending: true, path: 'keeping', canKeep: false })).toBe(
      true,
    )
    expect(saysKept({ pending: true, path: 'kept', canKeep: false })).toBe(true)
    // Gone straight (the outbox not read yet at the press, read since; or
    // the kill switch): it lives in the Convex client's memory alone.
    expect(saysKept({ pending: true, path: 'direct', canKeep: true })).toBe(
      false,
    )
  })
})

// ── What the day's list draws of it ────────────────────────────────────────

/** The day booked: 9am Perth on 27 Oct (`bookingFor`). */
const DAY = '2026-10-27'

/**
 * A day's list as `useOutboxDay` draws it from this phone, drawn again at
 * each change to the bookings in memory and to the day's rows, as React may
 * paint any of them: each draw kept, with the rows it had.
 */
function drawDay(p: Phone, at: { dayLive: boolean }) {
  let latch: SlotLatch | null = null
  let rows: Array<LatchRow> = []
  const draws: Array<LatchResult & { rows: Array<string> }> = []
  const draw = () => {
    const now = Date.now()
    const result = latchSlots(latch, {
      items: p.model.readable()
        ? p.model
            .all()
            .map((item) =>
              answeredView(item, p.model.answeredWith(item.localId)),
            )
        : null,
      drawing: true,
      rows,
      redrawKey: 'day',
      dayShown: DAY,
      timezone: BUSINESS.timezone,
      dayLive: at.dayLive,
      now,
      // The day has other jobs: the group goes under them.
      mayAdd: addRule(p.model, { drawsCards: true, now }),
    })
    latch = result.latch
    draws.push({ ...result, rows: rows.map((row) => row._id) })
  }
  stops.push(p.model.subscribe(draw))
  draw()
  return {
    draws,
    setRows: (next: Array<LatchRow>) => {
      rows = next
      draw()
    },
  }
}

describe('as the day’s list draws it (§9.3, §9.4)', () => {
  const JOB: LatchRow = { _id: 'job-1', clientRequestId: REQUEST }

  test.each(['the list first', 'the answer first'] as const)(
    'booked with signal, the sheet closing on its job: the list draws the job alone, never the booking, %s',
    async (order) => {
      const p = await phone()
      const day = drawDay(p, { dayLive: true })
      const { outcome } = press(p)
      await flush()
      if (order === 'the list first') day.setRows([JOB])
      p.convex.calls[0].resolve('job-1')
      await flush()
      if (order === 'the answer first') day.setRows([JOB])
      p.session.dispose()
      await flush()
      expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
      expect(stored(p)?.state).toBe('sent')
      expect(day.draws.length).toBeGreaterThan(4)
      for (const drawn of day.draws) {
        expect(drawn.slots).toEqual([])
        expect(drawn.hidden.size).toBe(0)
        expect(drawn.heading).toBeNull()
      }
    },
  )

  test('…even on a day not live here yet, which would draw a booking sent as "Sent"', async () => {
    const p = await phone()
    const day = drawDay(p, { dayLive: false })
    press(p)
    await flush()
    p.convex.calls[0].resolve('job-1')
    await flush()
    p.session.dispose()
    await flush()
    expect(stored(p)?.state).toBe('sent')
    for (const drawn of day.draws) expect(drawn.slots).toEqual([])
  })

  test.each(['the list first', 'the answer first'] as const)(
    'kept with no signal, then sent: its slot draws the job where it was, never beside it, %s',
    async (order) => {
      const p = await phone()
      p.keeper.live = false
      const day = drawDay(p, { dayLive: true })
      press(p)
      await flush()
      p.session.dispose()
      await flush()
      const before = day.draws.at(-1)
      expect(before?.slots.map((slot) => slot.chip)).toEqual(['waiting'])
      const key = before?.slots[0].key
      const from = day.draws.length - 1
      p.keeper.live = true
      p.sender.kick()
      await flush()
      expect(p.convex.calls).toHaveLength(1)
      if (order === 'the list first') day.setRows([JOB])
      p.convex.calls[0].resolve('job-1')
      await flush()
      if (order === 'the answer first') day.setRows([JOB])
      await flush()
      expect(stored(p)?.state).toBe('sent')
      for (const drawn of day.draws.slice(from)) {
        expect(drawn.slots.map((slot) => slot.key)).toEqual([key])
        if (drawn.rows.includes('job-1')) {
          expect([...drawn.hidden]).toEqual(['job-1'])
          expect(drawn.slots[0].real?._id).toBe('job-1')
        }
      }
      expect(day.draws.at(-1)?.heading).toBe('Sent')
    },
  )

  test('a Recurring Job: its answer counts from the moment it is heard, the phone’s storage slow to say sent and the list between', async () => {
    const p = await phone()
    p.keeper.live = false
    const day = drawDay(p, { dayLive: true })
    const series = bookingFor({
      repeat: { count: 3, unit: 'month' },
    }) as SendableBooking
    press(p, draft(), p.session, series)
    await flush()
    p.session.dispose()
    await flush()
    const from = day.draws.length - 1
    p.keeper.live = true
    p.sender.kick()
    await flush()
    expect(p.convex.calls[0].fn).toBe('recurrences:create')
    // From here the phone's storage takes a second over each change.
    const realUpdate = p.backend.update.bind(p.backend)
    p.backend.update = (epoch, localId, change) =>
      sleep(1_000).then(() => realUpdate(epoch, localId, change))
    p.convex.calls[0].resolve('series-1')
    await flush()
    // The series' first visit (which carries no request id) in the list.
    day.setRows([{ _id: 'visit-1', recurrenceId: 'series-1' }])
    expect(stored(p)?.state).toBe('sending')
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(stored(p)?.state).toBe('sent')
    for (const drawn of day.draws.slice(from)) {
      expect(drawn.slots).toHaveLength(1)
      if (drawn.rows.includes('visit-1')) {
        expect([...drawn.hidden]).toEqual(['visit-1'])
      }
    }
  })
})

/**
 * The phone's storage keeps this one LATE_MS after it is asked: after New
 * Job has given up waiting (KEEP_WAIT_MS), before the store gives up itself
 * (STORE_OP_MS).
 */
const LATE_MS = KEEP_WAIT_MS + 1_000

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The phone's storage reaches each keep `ms` after it is asked. Past
 * KEEP_WAIT_MS, that is after New Job has given the keep up: refused.
 */
function slowKeep(p: Phone, ms = LATE_MS) {
  const real = p.backend.keep.bind(p.backend)
  p.backend.keep = (epoch, item, wanted) =>
    sleep(ms).then(() => real(epoch, item, wanted))
}

/** A keep the phone's storage writes `writeAt` after it is asked, and
 * answers for `answerAfter` later. */
function keepWrittenThenAnswered(
  p: Phone,
  writeAt: number,
  answerAfter: number,
) {
  const real = p.backend.keep.bind(p.backend)
  p.backend.keep = (epoch, item, wanted) =>
    sleep(writeAt)
      .then(() => real(epoch, item, wanted))
      .then((result) => sleep(answerAfter).then(() => result))
}

/** When the keep a late one is written: just before New Job stops waiting,
 * so before it gives the keep up. */
const WRITTEN_AT = KEEP_WAIT_MS - 100

/** A keep written in time (WRITTEN_AT) that answers only `landsAt` after
 * the press: kept, late. */
function keptLate(p: Phone, landsAt = LATE_MS) {
  keepWrittenThenAnswered(p, WRITTEN_AT, landsAt - WRITTEN_AT)
}

/** From here the phone's storage takes `ms` over each change; the way
 * back to its own speed. */
function slowChanges(p: Phone, ms: number): () => void {
  const real = p.backend.update.bind(p.backend)
  p.backend.update = (epoch, localId, change) =>
    sleep(ms).then(() => real(epoch, localId, change))
  return () => {
    p.backend.update = real
  }
}

/**
 * From here each change the phone's storage makes that would delete a
 * booking fails, as an aborted transaction does: nothing written, and its
 * real answer `'error'`, at once or after `ms`. The first `times` only.
 */
function failDeletes(p: Phone, opts: { ms?: number; times?: number } = {}) {
  const real = p.backend.update.bind(p.backend)
  let left = opts.times ?? Infinity
  p.backend.update = (epoch, localId, change) => {
    const now = p.backend.items.get(localId)
    if (left > 0 && now && change(structuredClone(now)) === 'delete') {
      left--
      return opts.ms === undefined
        ? Promise.resolve('error' as const)
        : sleep(opts.ms).then(() => 'error' as const)
    }
    return real(epoch, localId, change)
  }
}

/** …and each of those that does delete one takes `ms` to. */
function slowDeletes(p: Phone, ms: number) {
  const real = p.backend.update.bind(p.backend)
  p.backend.update = (epoch, localId, change) => {
    const now = p.backend.items.get(localId)
    return now && change(structuredClone(now)) === 'delete'
      ? sleep(ms).then(() => real(epoch, localId, change))
      : real(epoch, localId, change)
  }
}

/** From here no change to a booking ever lands: the page is going. The way
 * back, for the page load after. */
function hangChanges(p: Phone): () => void {
  const real = p.backend.update.bind(p.backend)
  p.backend.update = () => new Promise(() => {})
  return () => {
    p.backend.update = real
  }
}

/**
 * The page closed and opened again over the same phone: its storage and
 * its localStorage, a fresh outbox, sender and Web Locks, and the same
 * server. The page before does nothing more.
 */
async function reload(p: Phone) {
  for (const stop of stops.splice(0)) stop()
  setOutboxBackendForTests(p.backend)
  checkOutboxOwner(personOf('u1'))
  await flush(3)
  const lockManager = new FakeLockManager()
  const model = new OutboxModel()
  stops.push(model.start(() => null))
  const sender = new Sender()
  stops.push(
    sender.attach({
      convex: p.convex as unknown as SenderDeps['convex'],
      qc: p.qc,
      keeper: p.keeper,
      locks: lockManager.forTab('tab-b'),
      outbox: model,
    }),
  )
  await model.refresh()
  await flush()
  return { model, sender }
}

/** On to `ms` after the press (made at NOW). */
async function onTo(ms: number) {
  await vi.advanceTimersByTimeAsync(NOW + ms - Date.now())
  await flush()
}

const refuse = (error: unknown) => (p: Phone) => p.convex.calls[0].reject(error)

const SERVER_ERROR = new Error(
  '[CONVEX M(jobs:create)] [Request ID: 1a2b3c] Server Error',
)

/** Every answer but a job: what the sender keeps a booking for, a refusal
 * that made nothing, and the kill switch. */
const ANSWERS: Array<{
  what: string
  answer: (p: Phone) => void
  paused?: true
}> = [
  { what: 'a plain Server Error', answer: refuse(SERVER_ERROR) },
  {
    what: 'Unauthenticated (SIGNED_OUT)',
    answer: refuse(new ConvexError('Unauthenticated')),
  },
  {
    what: 'two-step set-up wanted (TWO_STEP)',
    answer: (p) => {
      // As `flagIfTwoStepNeeded` would have it (G9).
      vi.mocked(isTwoStepNeeded).mockReturnValue(true)
      p.convex.calls[0].reject(new ConvexError('MFA_ENROLMENT_REQUIRED'))
    },
  },
  {
    what: 'NOT_OWN_ACCOUNT (SWITCHED)',
    answer: refuse(new ConvexError('NOT_OWN_ACCOUNT')),
  },
  {
    what: 'NO_ACCESS with access:me not live (ACCESS)',
    answer: (p) => {
      p.keeper.liveKeys.clear()
      p.convex.calls[0].reject(new ConvexError('NO_ACCESS'))
    },
  },
  {
    what: 'a refusal heard across a reconnect',
    answer: (p) => {
      p.keeper.conn++
      p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    },
  },
  {
    what: 'INVALID_REQUEST_ID (NEW_ID)',
    answer: refuse(new ConvexError('INVALID_REQUEST_ID')),
  },
  {
    what: 'INVALID_ASSIGNEE',
    answer: refuse(new ConvexError('INVALID_ASSIGNEE')),
  },
  {
    what: 'OUTBOX_PAUSED',
    answer: refuse(new ConvexError('OUTBOX_PAUSED')),
    paused: true,
  },
]

/** Every jobs:create made with the press's own request id. */
const ownCalls = (p: Phone) =>
  p.convex.calls.filter((c) => c.args.clientRequestId === REQUEST)

const GIVEN_UP_KEY = 'pestm8-outbox-given-up'

/** The bookings noted as given up (`giveUpKeep`), as localStorage has them. */
const givenUpNote = (): unknown =>
  JSON.parse(localStorage.getItem(GIVEN_UP_KEY) ?? '[]')

/**
 * Nothing of the booking anywhere on the phone, ever: not stored, not in
 * memory, not drawn, its lock let go and nothing noted, and no call of it
 * made by the phone from now, past every hold and retry (the kill switch's
 * 15 minutes included).
 */
async function nothingAfter(p: Phone) {
  expect(stored(p)).toBeUndefined()
  expect(p.model.get(LOCAL)).toBeUndefined()
  expect(p.model.isDeciding(LOCAL)).toBe(false)
  expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
  expect(givenUpNote()).toEqual([])
  const made = ownCalls(p).length
  await vi.advanceTimersByTimeAsync(16 * 60_000)
  await flush()
  expect(ownCalls(p)).toHaveLength(made)
  expect(stored(p)).toBeUndefined()
}

describe('a keep that takes too long (§6.4, as decided 27 Oct): the press goes straight and stays straight; nothing the keep comes to is ever sent', () => {
  test('the fallback goes straight, saying whose it is; the draft keeps nothing more, and the keep is given up on at once', async () => {
    const p = await phone()
    slowKeep(p)
    const { draft: d } = press(p)
    await flush()
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    expect(p.convex.calls[0].args).toMatchObject({
      clientRequestId: REQUEST,
      asMembership: M1,
    })
    expect(d.stopKeeping).toHaveBeenCalledTimes(1)
    expect(p.sheet.now).toBe('direct')
    // Given up, here and for every tab and the next page load, before the
    // keep has said anything; and the lock still held, till it has.
    expect(givenUpNote()).toEqual([LOCAL])
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
    await vi.advanceTimersByTimeAsync(LATE_MS - KEEP_WAIT_MS)
    await flush()
    // Reached the store after that: refused, never written.
    expect(p.backend.items.size).toBe(0)
    expect(notes('outbox-keep')).toContainEqual(
      expect.objectContaining({ result: 'late', landed: 'refused' }),
    )
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
    expect(p.model.isDeciding(LOCAL)).toBe(false)
    expect(givenUpNote()).toEqual([])
  })

  test('pressed again after it went straight (the review’s PROBE5-A): still saying whose it is, so one refused NOT_OWN_ACCOUNT is refused again, never booked in the other account', async () => {
    const p = await phone()
    slowKeep(p)
    // The draft as New Job holds it (`useDraftRequestId`): kept nothing more
    // once a keep took too long.
    const d = draft()
    d.stopKeeping.mockImplementation(() => {
      d.keepable = false
    })
    const first = press(p, d)
    await flush()
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    expect(p.convex.calls[0].args).toMatchObject({
      clientRequestId: REQUEST,
      asMembership: M1,
    })
    // Another tab has moved PestM8 into someone else's account.
    const refusal = new ConvexError('NOT_OWN_ACCOUNT')
    p.convex.calls[0].reject(refusal)
    await flush()
    expect(first.outcome.error).toBe(refusal)
    // Book again, without switching back.
    const second = press(p, d)
    await flush()
    expect(p.convex.calls).toHaveLength(2)
    expect(p.convex.calls[1].args).toMatchObject({
      clientRequestId: REQUEST,
      asMembership: M1,
    })
    const again = new ConvexError('NOT_OWN_ACCOUNT')
    p.convex.calls[1].reject(again)
    await flush()
    expect(second.outcome.error).toBe(again)
    expect(p.sheet.now).toBeNull()
    // Switched back: the same draft, still straight and still the person's.
    const third = press(p, d)
    await flush()
    expect(p.convex.calls).toHaveLength(3)
    expect(p.convex.calls[2].args).toMatchObject({
      clientRequestId: REQUEST,
      asMembership: M1,
    })
    p.convex.calls[2].resolve('job-1')
    await flush()
    expect(third.outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LATE_MS)
    await nothingAfter(p)
    expect(p.convex.calls).toHaveLength(3)
  })

  test('a late keep that lands while the straight call is out: off the phone as it lands, shown by nothing meanwhile, and the call’s answer the sheet’s alone', async () => {
    const p = await phone()
    const day = drawDay(p, { dayLive: true })
    keptLate(p)
    const { outcome } = press(p)
    await onTo(KEEP_WAIT_MS)
    expect(p.convex.calls).toHaveLength(1)
    // Written before New Job stopped waiting, still answering: on the
    // phone, and nothing shows or sends it.
    expect(stored(p)).toMatchObject({ state: 'waiting', attempts: 0 })
    expect(p.model.get(LOCAL)).toBeUndefined()
    await onTo(LATE_MS)
    expect(stored(p)).toBeUndefined()
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
    expect(givenUpNote()).toEqual([])
    expect(outcome.done).toBe(false)
    // Never sent a second time, and the call is the sheet's.
    expect(p.convex.calls).toHaveLength(1)
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    await nothingAfter(p)
    for (const drawn of day.draws) expect(drawn.slots).toEqual([])
  })

  const answered = [
    ['answered with a job', (c: Call) => c.resolve('job-1')],
    ['refused', (c: Call) => c.reject(new ConvexError('INVALID_ASSIGNEE'))],
  ] as const

  test.each(answered)(
    'a late keep written before the straight call was %s, landing after: the sheet shows the answer at once, and the row comes off as it lands, the lock held till then',
    async (how, answer) => {
      const p = await phone()
      keepWrittenThenAnswered(p, WRITTEN_AT, 1_000)
      const { outcome } = press(p)
      await onTo(KEEP_WAIT_MS + 100)
      expect(stored(p)?.state).toBe('waiting')
      answer(p.convex.calls[0])
      await flush()
      if (how === 'refused') expect(outcome.error).toBeInstanceOf(ConvexError)
      else expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
      expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
      // Not drawn while it is decided: no card comes and goes.
      expect(p.model.isDeciding(LOCAL)).toBe(true)
      expect(p.model.get(LOCAL)).toBeUndefined()
      await onTo(WRITTEN_AT + 1_000)
      expect(notes('outbox-keep')).toContainEqual(
        expect.objectContaining({ result: 'late', landed: 'kept' }),
      )
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(1)
    },
  )

  test.each(answered)(
    'a late keep that reaches the store after the straight call was %s: given up on, never written, and the lock let go',
    async (_how, answer) => {
      const p = await phone()
      slowKeep(p)
      press(p)
      await flush()
      await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS)
      await flush()
      answer(p.convex.calls[0])
      await flush()
      expect(p.model.isDeciding(LOCAL)).toBe(true)
      await vi.advanceTimersByTimeAsync(LATE_MS - KEEP_WAIT_MS)
      await flush()
      expect(p.backend.items.size).toBe(0)
      expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
      expect(p.model.isDeciding(LOCAL)).toBe(false)
      expect(notes('outbox-keep')).toContainEqual(
        expect.objectContaining({ result: 'late', landed: 'refused' }),
      )
    },
  )

  test('a keep still on its way past the store’s own limit, the straight call out or answered: given up on, never written, however late it gets there', async () => {
    const p = await phone()
    // Reached after the store's own limit, which says 'error' first.
    slowKeep(p, STORE_OP_MS + 1_000)
    const { outcome } = press(p)
    await onTo(KEEP_WAIT_MS)
    await onTo(STORE_OP_MS + 1_000)
    expect(p.backend.items.size).toBe(0)
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    await nothingAfter(p)
  })

  test('a keep written before New Job went straight, answering only after the store’s own limit: off the phone once it really lands, the lock held till then', async () => {
    const p = await phone()
    keepWrittenThenAnswered(p, WRITTEN_AT, STORE_OP_MS + 2_000)
    press(p)
    await onTo(KEEP_WAIT_MS)
    p.convex.calls[0].resolve('job-1')
    await onTo(STORE_OP_MS + 500)
    // The store's limit is up and it said 'error': the row is still held,
    // and still shown by nothing.
    expect(stored(p)?.state).toBe('waiting')
    expect(p.model.get(LOCAL)).toBeUndefined()
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
    await onTo(WRITTEN_AT + STORE_OP_MS + 2_000)
    await nothingAfter(p)
  })

  test('a keep that never lands: the lock held for good, so nothing can ever send what it may write; the straight call’s answer is the sheet’s', async () => {
    const p = await phone()
    // Never answered, not even by the store's own limit.
    p.deps.keep = () => new Promise(() => {})
    const { outcome } = press(p)
    await onTo(KEEP_WAIT_MS)
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await flush()
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
    expect(p.convex.calls).toHaveLength(1)
  })

  test('the review’s case (PROBE-1, as decided): kept at 1.8 s, a plain Server Error at 2 s: FormAlert, the booking off the phone as it landed, and nothing sent a minute on', async () => {
    const p = await phone()
    keptLate(p, 1_800)
    const { outcome } = press(p)
    await onTo(1_800)
    expect(stored(p)).toBeUndefined()
    await onTo(2_000)
    p.convex.calls[0].reject(SERVER_ERROR)
    await flush()
    expect(outcome.error).toBe(SERVER_ERROR)
    expect(p.sheet.now).toBeNull()
    expect(p.sheet.close).not.toHaveBeenCalled()
    await onTo(62_000)
    expect(p.convex.calls).toHaveLength(1)
    await nothingAfter(p)
  })

  test('a late keep the phone fails to delete: left needing a look, shown, and never sent by itself', async () => {
    const p = await phone()
    keptLate(p)
    failDeletes(p)
    const { outcome } = press(p)
    await onTo(KEEP_WAIT_MS)
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await onTo(LATE_MS)
    expect(outcome.error).toBeInstanceOf(ConvexError)
    expect(stored(p)).toMatchObject({
      state: 'needsLook',
      problem: { code: LEFT_ON_PHONE },
    })
    // Shown, once it needs a look: the phone holds it, and says so.
    expect(p.model.get(LOCAL)).toMatchObject({ state: 'needsLook' })
    expect(p.model.isDeciding(LOCAL)).toBe(false)
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
    expect(givenUpNote()).toEqual([])
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
  })

  test('…nor marked needing a look: still given up, so shown and sent by nothing, and the next page load deletes it', async () => {
    const p = await phone()
    keptLate(p)
    // From here every change fails at once, as a storage that refuses them
    // does.
    const real = p.backend.update.bind(p.backend)
    p.backend.update = () => Promise.resolve('error' as const)
    press(p)
    await onTo(KEEP_WAIT_MS)
    p.convex.calls[0].resolve('job-1')
    await onTo(LATE_MS)
    expect(stored(p)).toMatchObject({ state: 'waiting' })
    expect(p.model.get(LOCAL)).toBeUndefined()
    expect(givenUpNote()).toEqual([LOCAL])
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    // Still on the phone as it was, so its lock is never let go this page
    // load, as for a keep that never lands: no tab can send it, the note
    // aside.
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
    expect(p.model.isDeciding(LOCAL)).toBe(true)
    p.backend.update = real
    const after = await reload(p)
    expect(p.backend.items.size).toBe(0)
    expect(after.model.all()).toEqual([])
    expect(givenUpNote()).toEqual([])
  })

  test('…nor marked, nor noted as given up, localStorage full by then: still never sent this page load, its lock held', async () => {
    const p = await phone()
    keptLate(p)
    p.backend.update = () => Promise.resolve('error' as const)
    press(p)
    await flush()
    // Full from just after the press found it taking notes.
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    await onTo(KEEP_WAIT_MS)
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await onTo(LATE_MS)
    expect(stored(p)).toMatchObject({ state: 'waiting', attempts: 0 })
    expect(givenUpNote()).toEqual([])
    p.sender.kick()
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    // The refused booking is never sent by the phone: nothing can take its
    // lock.
    expect(p.convex.calls).toHaveLength(1)
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
  })

  test('a late keep, the page closed before the phone took it off: the next page load deletes it, and nothing ever sends it', async () => {
    const p = await phone()
    keptLate(p)
    press(p)
    await onTo(KEEP_WAIT_MS)
    // From the keep landing, nothing the page asks of the phone's storage
    // lands: it is closing.
    const back = hangChanges(p)
    await onTo(LATE_MS)
    expect(stored(p)).toMatchObject({ state: 'waiting', attempts: 0 })
    back()
    const after = await reload(p)
    expect(p.backend.items.size).toBe(0)
    expect(after.model.all()).toEqual([])
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    // The straight call alone, never answered: the page that made it went.
    expect(p.convex.calls).toHaveLength(1)
  })
})

/** Pressed with the line live; kept in time, and sent by the sender. */
async function keptAndSent() {
  const p = await phone()
  const pressed = press(p)
  await flush()
  expect(p.sheet.now).toBe('kept')
  expect(p.convex.calls).toHaveLength(1)
  expect(stored(p)).toMatchObject({ state: 'sending', attempts: 1 })
  return { p, ...pressed }
}

describe('closed while the phone writes what a refusal says: the sheet said kept, so the phone keeps it (§3.2 step 6, F1)', () => {
  const PATHS = [['kept in time and sent', keptAndSent]] as const

  test.each(PATHS)(
    '%s, refused INVALID_ASSIGNEE, swiped away while the phone marks it: booked said, and it needs a look on the phone, never deleted and never sent',
    async (_path, pressed) => {
      const { p, outcome } = await pressed()
      slowChanges(p, 1_000)
      p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
      await flush()
      // The answer is in, the phone still writing what it says: the sheet
      // still says kept, so it closes without asking.
      expect(p.sheet.now).toBe('kept')
      p.session.dispose()
      expect(p.sheet.booked).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      expect(outcome.value).toEqual({ outcome: 'kept' })
      expect(stored(p)).toMatchObject({
        state: 'needsLook',
        problem: { code: 'INVALID_ASSIGNEE' },
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()
      expect(stored(p)).toMatchObject({ state: 'needsLook' })
      expect(p.model.mayDraw(LOCAL)).toBe(true)
      expect(p.convex.calls).toHaveLength(1)
      expect(p.sheet.booked).toHaveBeenCalledTimes(1)
      expect(p.sheet.close).not.toHaveBeenCalled()
    },
  )

  test.each(PATHS)(
    '%s, OUTBOX_PAUSED, swiped away while the phone holds it: booked said, held on the phone, and nothing sent straight with no sheet',
    async (_path, pressed) => {
      const { p, outcome } = await pressed()
      slowChanges(p, 1_000)
      p.convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
      await flush()
      expect(p.sheet.now).toBe('kept')
      p.session.dispose()
      expect(p.sheet.booked).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      expect(outcome.value).toEqual({ outcome: 'kept' })
      expect(stored(p)).toMatchObject({ state: 'waiting' })
      expect(stored(p)?.holdUntil).toBeGreaterThan(Date.now())
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()
      expect(stored(p)).toMatchObject({ state: 'waiting' })
      expect(p.convex.calls).toHaveLength(1)
    },
  )

  test.each(PATHS)(
    '%s, refused with the sheet open: taken off the phone before FormAlert says so; discarded meanwhile, it asked first, and nothing is booked or kept',
    async (_path, pressed) => {
      const { p, outcome, draft: d } = await pressed()
      slowChanges(p, 1_000)
      const refusal = new ConvexError('INVALID_ASSIGNEE')
      p.convex.calls[0].reject(refusal)
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      // Needing a look on the phone, and the sheet taking it off: not kept
      // any more, so closing it asks first.
      expect(stored(p)).toMatchObject({ state: 'needsLook' })
      expect(p.sheet.now).toBeNull()
      expect(outcome.done).toBe(false)
      p.session.dispose()
      expect(p.sheet.booked).not.toHaveBeenCalled()
      // Discarded: shown and sent by nothing while it comes off.
      expect(givenUpNote()).toEqual([LOCAL])
      expect(p.model.get(LOCAL)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      expect(outcome.error).toBe(refusal)
      expect(p.backend.items.size).toBe(0)
      expect(givenUpNote()).toEqual([])
      expect(d.renew).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()
      expect(p.convex.calls).toHaveLength(1)
      expect(p.backend.items.size).toBe(0)
      expect(p.sheet.booked).not.toHaveBeenCalled()
    },
  )

  test.each(PATHS)(
    '%s, OUTBOX_PAUSED with the sheet open: taken off the phone, then straight; discarded meanwhile, nothing goes',
    async (_path, pressed) => {
      const { p, outcome } = await pressed()
      slowChanges(p, 1_000)
      const paused = new ConvexError('OUTBOX_PAUSED')
      p.convex.calls[0].reject(paused)
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      expect(stored(p)).toMatchObject({ state: 'waiting' })
      expect(p.sheet.now).toBe('direct')
      p.session.dispose()
      expect(p.sheet.booked).not.toHaveBeenCalled()
      expect(givenUpNote()).toEqual([LOCAL])
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      expect(outcome.error).toBe(paused)
      expect(p.backend.items.size).toBe(0)
      expect(givenUpNote()).toEqual([])
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()
      expect(p.convex.calls).toHaveLength(1)
      expect(p.sheet.booked).not.toHaveBeenCalled()
    },
  )

  test.each(PATHS)(
    '%s, OUTBOX_PAUSED with the sheet open and left open: taken off the phone, then sent straight with the same id',
    async (_path, pressed) => {
      const { p, outcome } = await pressed()
      slowChanges(p, 1_000)
      p.convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
      await vi.advanceTimersByTimeAsync(2_000)
      await flush()
      expect(p.backend.items.size).toBe(0)
      expect(p.convex.calls).toHaveLength(2)
      expect(p.convex.calls[1].args.clientRequestId).toBe(REQUEST)
      expect(p.convex.calls[1].args).not.toHaveProperty('asMembership')
      p.convex.calls[1].resolve('job-1')
      await flush()
      expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    },
  )

  /** Every answer, and what the phone makes of it while the sheet is
   * closed (and, but for INVALID_ASSIGNEE, while it is open). */
  const EVERY: Array<{
    what: string
    answer: (p: Phone) => void
    row: Partial<OutboxItem>
  }> = [
    {
      what: 'a plain Server Error',
      answer: (p) =>
        p.convex.calls[0].reject(
          new Error(
            '[CONVEX M(jobs:create)] [Request ID: 1a2b3c] Server Error',
          ),
        ),
      row: { state: 'waiting', serverFailures: 1 },
    },
    {
      what: 'Unauthenticated (SIGNED_OUT)',
      answer: (p) =>
        p.convex.calls[0].reject(new ConvexError('Unauthenticated')),
      row: { state: 'waiting' },
    },
    {
      what: 'two-step set-up wanted (TWO_STEP)',
      answer: (p) => {
        vi.mocked(isTwoStepNeeded).mockReturnValue(true)
        p.convex.calls[0].reject(new ConvexError('MFA_ENROLMENT_REQUIRED'))
      },
      row: { state: 'waiting' },
    },
    {
      what: 'NOT_OWN_ACCOUNT (SWITCHED)',
      answer: (p) =>
        p.convex.calls[0].reject(new ConvexError('NOT_OWN_ACCOUNT')),
      row: { state: 'waiting' },
    },
    {
      what: 'NO_ACCESS with access:me not live (ACCESS)',
      answer: (p) => {
        p.keeper.liveKeys.clear()
        p.convex.calls[0].reject(new ConvexError('NO_ACCESS'))
      },
      row: { state: 'waiting' },
    },
    {
      what: 'a refusal heard across a reconnect',
      answer: (p) => {
        p.keeper.conn++
        p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
      },
      row: { state: 'sending' },
    },
    {
      what: 'INVALID_ASSIGNEE',
      answer: (p) =>
        p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE')),
      row: { state: 'needsLook', problem: { code: 'INVALID_ASSIGNEE' } },
    },
  ]
  const EACH = PATHS.flatMap(([path, pressed]) =>
    EVERY.map((answer) => ({ path, pressed, ...answer })),
  )

  test.each(EACH)(
    '$path, $what, the phone slow to write it, the sheet open: it closes as kept with the booking on the phone, or, for a refusal that made nothing, FormAlert with nothing on it',
    async ({ pressed, answer, row, what }) => {
      const { p, outcome } = await pressed()
      slowChanges(p, 1_000)
      answer(p)
      await vi.advanceTimersByTimeAsync(2_000)
      await flush()
      if (what === 'INVALID_ASSIGNEE') {
        expect(outcome.error).toBeInstanceOf(ConvexError)
        expect(p.backend.items.size).toBe(0)
        expect(p.sheet.close).not.toHaveBeenCalled()
        p.session.dispose()
        expect(p.sheet.booked).not.toHaveBeenCalled()
      } else {
        expect(outcome.error).toBeUndefined()
        expect(outcome.value).toEqual({ outcome: 'kept' })
        expect(p.sheet.close).toHaveBeenCalledTimes(1)
        expect(p.sheet.booked).toHaveBeenCalledTimes(1)
        expect(stored(p)).toMatchObject(row)
      }
      expect(p.convex.calls).toHaveLength(1)
    },
  )

  test.each(EACH)(
    '$path, $what, the sheet swiped away while the phone writes it: booked said, and the booking on the phone as the phone wrote it',
    async ({ pressed, answer, row }) => {
      const { p, outcome } = await pressed()
      slowChanges(p, 1_000)
      answer(p)
      await flush()
      expect(p.sheet.now).toBe('kept')
      p.session.dispose()
      expect(p.sheet.booked).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2_000)
      await flush()
      expect(outcome.error).toBeUndefined()
      expect(outcome.value).toEqual({ outcome: 'kept' })
      expect(stored(p)).toMatchObject(row)
      // Said once, whether the swipe or the outcome closed it first (one
      // heard across a reconnect writes nothing, and closes it at once).
      expect(p.sheet.booked).toHaveBeenCalledTimes(1)
      expect(p.convex.calls).toHaveLength(1)
    },
  )

  test('refused with the sheet open, changed by someone else before the sheet could take it off: on the phone, so the sheet closes as kept', async () => {
    const { p, outcome } = await keptAndSent()
    slowChanges(p, 1_000)
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(p.sheet.now).toBeNull()
    // Sent on from another tab's sheet for it, say, while the sheet's own
    // delete is on its way.
    const row = stored(p)
    expect(row).toMatchObject({ state: 'needsLook' })
    p.backend.items.set(LOCAL, {
      ...row!,
      state: 'waiting',
      problem: null,
      updatedAt: row!.updatedAt + 1,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(outcome.error).toBeUndefined()
    expect(outcome.value).toEqual({ outcome: 'kept' })
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    expect(stored(p)).toMatchObject({ state: 'waiting' })
  })

  test('kept in time and sent, refused INVALID_ASSIGNEE, the phone failing to delete it (PROBE-3): the sheet closes as kept, the booking needing a look where it says, never FormAlert', async () => {
    const { p, outcome, draft: d } = await keptAndSent()
    failDeletes(p)
    p.convex.calls[0].reject(new ConvexError('INVALID_ASSIGNEE'))
    await flush()
    expect(outcome.error).toBeUndefined()
    expect(outcome.value).toEqual({ outcome: 'kept' })
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    expect(d.renew).toHaveBeenCalledTimes(1)
    expect(stored(p)).toMatchObject({
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
    expect(p.model.mayDraw(LOCAL)).toBe(true)
    expect(p.model.isDeciding(LOCAL)).toBe(false)
    p.session.dispose()
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    expect(stored(p)).toMatchObject({ state: 'needsLook' })
  })

  test('kept in time and sent, OUTBOX_PAUSED, the phone failing to delete the held booking (PROBE-4): never sent straight; the sheet closes as kept, and the phone sends it once, when the hold is up', async () => {
    const { p, outcome } = await keptAndSent()
    failDeletes(p)
    p.convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
    await flush()
    expect(outcome.error).toBeUndefined()
    expect(outcome.value).toEqual({ outcome: 'kept' })
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    // No straight call: the held booking is the phone's.
    expect(p.convex.calls).toHaveLength(1)
    expect(stored(p)).toMatchObject({ state: 'waiting' })
    expect(stored(p)?.holdUntil).toBeGreaterThan(Date.now())
    p.session.dispose()
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    expect(p.convex.calls).toHaveLength(2)
    expect(p.convex.calls[1].args).toMatchObject({
      clientRequestId: REQUEST,
      asMembership: M1,
    })
    p.convex.calls[1].resolve('job-1')
    await flush()
    expect(stored(p)).toMatchObject({ state: 'sent', result: { id: 'job-1' } })
  })

  test('refused, the sheet open, its delete slower than the store’s own limit: "Booking…" until it really lands, then FormAlert with nothing on the phone', async () => {
    const { p, outcome } = await keptAndSent()
    slowDeletes(p, STORE_OP_MS + 1_000)
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    p.convex.calls[0].reject(refusal)
    await flush()
    expect(p.sheet.now).toBeNull()
    await vi.advanceTimersByTimeAsync(STORE_OP_MS + 500)
    await flush()
    // The store said 'error' for taking too long: not an answer.
    expect(outcome.done).toBe(false)
    expect(stored(p)).toMatchObject({ state: 'needsLook' })
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(outcome.error).toBe(refusal)
    expect(p.backend.items.size).toBe(0)
    expect(p.sheet.booked).not.toHaveBeenCalled()
  })

  test('OUTBOX_PAUSED, the sheet open, its delete slower than the store’s own limit: never straight until it really lands, then straight', async () => {
    const { p, outcome } = await keptAndSent()
    slowDeletes(p, STORE_OP_MS + 1_000)
    p.convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
    await vi.advanceTimersByTimeAsync(STORE_OP_MS + 500)
    await flush()
    expect(outcome.done).toBe(false)
    expect(p.convex.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(p.backend.items.size).toBe(0)
    expect(p.convex.calls).toHaveLength(2)
    expect(p.convex.calls[1].args.clientRequestId).toBe(REQUEST)
    expect(p.convex.calls[1].args).not.toHaveProperty('asMembership')
    p.convex.calls[1].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
  })

  test.each([
    ['taken off again', 1],
    ['left needing a look', Infinity],
  ] as const)(
    'OUTBOX_PAUSED, discarded while the sheet took the held booking off, the phone failing to: %s, and never sent at 16 minutes',
    async (how, failures) => {
      const { p, outcome } = await keptAndSent()
      failDeletes(p, { ms: 1_000, times: failures })
      p.convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
      await flush()
      // Not kept any more, as far as the sheet says: ✕ asks, and the
      // person discards.
      expect(p.sheet.now).toBe('direct')
      p.session.dispose()
      expect(p.sheet.booked).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)
      await flush()
      expect(outcome.value).toEqual({ outcome: 'discarded' })
      if (how === 'taken off again') {
        await nothingAfter(p)
      } else {
        expect(stored(p)).toMatchObject({
          state: 'needsLook',
          problem: { code: LEFT_ON_PHONE },
        })
        expect(p.model.get(LOCAL)).toMatchObject({ state: 'needsLook' })
      }
      await vi.advanceTimersByTimeAsync(16 * 60_000)
      await flush()
      expect(p.convex.calls).toHaveLength(1)
      expect(p.sheet.booked).not.toHaveBeenCalled()
    },
  )
})

describe('discarded ("Discard your changes?") before the sheet said kept: nothing of it goes, and nothing of it is left on the phone (step 5)', () => {
  test('the review’s case (PROBE-1, as decided): straight at 1.5 s, kept at 1.8 s, a plain Server Error at 2 s, each change 2 s: FormAlert; discarded at 3 s; never booked, and a second New Job makes the only job', async () => {
    const p = await phone()
    keptLate(p, 1_800)
    slowChanges(p, 2_000)
    const { outcome } = press(p)
    await onTo(1_500)
    expect(p.convex.calls).toHaveLength(1)
    await onTo(1_800)
    expect(stored(p)).toMatchObject({ state: 'waiting', attempts: 0 })
    expect(p.model.get(LOCAL)).toBeUndefined()
    await onTo(2_000)
    p.convex.calls[0].reject(SERVER_ERROR)
    await flush()
    expect(outcome.error).toBe(SERVER_ERROR)
    await onTo(3_000)
    // Nothing of it kept, as far as the sheet says: ✕ asks, and the person
    // discards, the phone still taking it off.
    expect(p.sheet.now).toBeNull()
    expect(stored(p)).toBeDefined()
    p.session.dispose()
    expect(p.sheet.booked).not.toHaveBeenCalled()
    await onTo(10_000)
    // The person books it again, from a fresh New Job.
    const { session: again } = sessionOn(p.deps)
    const second = press(
      p,
      {
        ...draft(),
        requestId: '22222222-2222-4222-8222-222222222222',
        localId: 'local-2',
      },
      again,
    )
    await onTo(14_000)
    expect(p.convex.calls).toHaveLength(2)
    p.convex.calls[1].resolve('job-2')
    await onTo(20_000)
    expect(second.outcome.value).toEqual({ outcome: 'sent', id: 'job-2' })
    again.dispose()
    await nothingAfter(p)
    expect(p.convex.calls).toHaveLength(2)
  })

  test('…and the page closed at 3 s, the phone not yet done taking it off: the next page load deletes it, and nothing is ever sent', async () => {
    const p = await phone()
    keptLate(p, 1_800)
    press(p)
    await onTo(1_500)
    // From before the keep lands, nothing the page asks of the phone's
    // storage lands: it is going.
    const back = hangChanges(p)
    await onTo(2_000)
    p.convex.calls[0].reject(SERVER_ERROR)
    await onTo(3_000)
    expect(stored(p)).toMatchObject({ state: 'waiting', attempts: 0 })
    p.session.dispose()
    back()
    const after = await reload(p)
    expect(p.backend.items.size).toBe(0)
    expect(after.model.all()).toEqual([])
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    expect(p.convex.calls).toHaveLength(1)
  })

  test('…and OUTBOX_PAUSED (PROBE-2): straight again without saying whose, never on the phone, never sent at 15 minutes', async () => {
    const p = await phone()
    keptLate(p, 1_800)
    slowChanges(p, 2_000)
    const { outcome } = press(p)
    await onTo(2_000)
    p.convex.calls[0].reject(new ConvexError('OUTBOX_PAUSED'))
    await flush()
    expect(p.convex.calls).toHaveLength(2)
    expect(p.convex.calls[1].args).not.toHaveProperty('asMembership')
    await onTo(3_000)
    expect(p.sheet.now).toBe('direct')
    p.session.dispose()
    await onTo(10_000)
    expect(outcome.done).toBe(false)
    await nothingAfter(p)
    // The straight calls alone, the second still the Convex client's.
    expect(p.convex.calls).toHaveLength(2)
  })

  test.each(ANSWERS)(
    'a late keep, the straight call answered $what with the sheet open: the sheet shows that answer (FormAlert, or straight again for the kill switch), and the phone sends nothing of it',
    async ({ answer, paused }) => {
      const p = await phone()
      keptLate(p, 1_800)
      slowChanges(p, 2_000)
      const { outcome } = press(p)
      await onTo(2_000)
      answer(p)
      await flush()
      if (paused) {
        expect(p.convex.calls).toHaveLength(2)
        expect(p.convex.calls[1].args.clientRequestId).toBe(REQUEST)
        expect(p.convex.calls[1].args).not.toHaveProperty('asMembership')
        p.convex.calls[1].resolve('job-1')
        await flush()
        expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
      } else {
        expect(outcome.error).toBeDefined()
        expect(p.sheet.close).not.toHaveBeenCalled()
        expect(p.sheet.now).toBeNull()
      }
      await onTo(6_000)
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(paused ? 2 : 1)
      expect(p.sheet.booked).toHaveBeenCalledTimes(paused ? 1 : 0)
    },
  )

  test.each(ANSWERS)(
    'a late keep, the straight call answered $what, then discarded: off the phone, and never sent again',
    async ({ answer, paused }) => {
      const p = await phone()
      keptLate(p, 1_800)
      slowChanges(p, 2_000)
      press(p)
      await onTo(2_000)
      answer(p)
      await onTo(3_000)
      expect(p.sheet.now).toBe(paused ? 'direct' : null)
      p.session.dispose()
      await onTo(15_000)
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(paused ? 2 : 1)
      expect(p.sheet.booked).not.toHaveBeenCalled()
    },
  )

  test.each(ANSWERS)(
    'discarded while the straight call is out, its late keep landed: never told kept, off the phone, and whatever the call then says ($what), nothing more goes',
    async ({ answer }) => {
      const p = await phone()
      keptLate(p, 1_800)
      slowChanges(p, 2_000)
      const { outcome } = press(p)
      await onTo(3_000)
      expect(p.sheet.now).toBe('direct')
      p.session.dispose()
      await onTo(4_000)
      expect(p.sheet.now).toBe('direct')
      answer(p)
      await onTo(15_000)
      expect(outcome.done).toBe(true)
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(1)
      expect(p.sheet.booked).not.toHaveBeenCalled()
    },
  )

  test('a keep that reaches the store long after the discard: refused, and the lock held till it has', async () => {
    const p = await phone()
    const reaches = 40_000
    slowKeep(p, reaches)
    const { outcome } = press(p)
    await flush()
    p.session.dispose()
    await onTo(KEEP_WAIT_MS)
    expect(outcome.value).toEqual({ outcome: 'discarded' })
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
    await onTo(reaches - 1)
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
    await onTo(reaches + 1_000)
    expect(p.backend.items.has(LOCAL)).toBe(false)
    await nothingAfter(p)
    expect(p.convex.calls).toHaveLength(0)
  })

  test('discarded while the straight call is out, its late keep landed: its job back is made, as a straight call already out always could, and nothing of it is on the phone', async () => {
    const p = await phone()
    keptLate(p, 1_800)
    slowChanges(p, 2_000)
    const { outcome } = press(p)
    await onTo(3_000)
    p.session.dispose()
    await onTo(4_000)
    p.convex.calls[0].resolve('job-1')
    await onTo(15_000)
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    expect(p.sheet.booked).not.toHaveBeenCalled()
    expect(p.sheet.close).not.toHaveBeenCalled()
    await nothingAfter(p)
  })

  test.each([
    ['a plain Server Error', (c: Call) => c.reject(SERVER_ERROR)],
    ['OUTBOX_PAUSED', (c: Call) => c.reject(new ConvexError('OUTBOX_PAUSED'))],
    [
      'INVALID_ASSIGNEE',
      (c: Call) => c.reject(new ConvexError('INVALID_ASSIGNEE')),
    ],
  ] as const)(
    'discarded while the straight call is out, its late keep written but not yet answered: deleted as it lands, the lock let go then; then %s: nothing goes again',
    async (_what, answer) => {
      const p = await phone()
      // Written at 1.4 s, just before New Job went straight; answered at
      // 2.4 s.
      keepWrittenThenAnswered(p, WRITTEN_AT, 1_000)
      const { outcome } = press(p)
      await onTo(2_000)
      expect(p.convex.calls).toHaveLength(1)
      expect(stored(p)).toMatchObject({ state: 'waiting', attempts: 0 })
      expect(p.sheet.now).toBe('direct')
      p.session.dispose()
      await onTo(2_600)
      expect(stored(p)).toBeUndefined()
      expect(p.sender.inflight()).toBe(0)
      expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
      answer(p.convex.calls[0])
      await flush()
      expect(outcome.done).toBe(true)
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(1)
      expect(p.sheet.booked).not.toHaveBeenCalled()
    },
  )

  test.each([
    ['reaching the store after the discard: refused, never written', 'after'],
    ['written before the discard, answering after: deleted', 'before'],
  ] as const)(
    'the main path (K5), discarded while kept in time, %s; nothing ever sent',
    async (_what, when) => {
      const p = await phone()
      if (when === 'after') slowKeep(p, 1_200)
      else keepWrittenThenAnswered(p, 900, 300)
      const { outcome } = press(p)
      await flush()
      await onTo(1_000)
      expect(p.sheet.now).toBe('keeping')
      p.session.dispose()
      await onTo(1_300)
      expect(p.convex.calls).toHaveLength(0)
      expect(outcome.value).toEqual({ outcome: 'discarded' })
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(0)
    },
  )

  test('the main path, discarded while kept in time, the phone failing to delete it: left needing a look, never sent', async () => {
    const p = await phone()
    keepWrittenThenAnswered(p, 900, 300)
    failDeletes(p)
    const { outcome } = press(p)
    await onTo(1_000)
    p.session.dispose()
    await onTo(1_300)
    expect(outcome.value).toEqual({ outcome: 'discarded' })
    expect(stored(p)).toMatchObject({
      state: 'needsLook',
      problem: { code: LEFT_ON_PHONE },
    })
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    await flush()
    expect(p.convex.calls).toHaveLength(0)
  })

  test.each([
    ['reaching the store after the discard: refused, never written', 'after'],
    ['written before the discard, landing late: deleted as it lands', 'before'],
  ] as const)(
    'discarded while being kept, the keep late, %s; never sent straight after',
    async (_what, when) => {
      const p = await phone()
      if (when === 'after') slowKeep(p, LATE_MS)
      else keepWrittenThenAnswered(p, 900, LATE_MS - 900)
      const { outcome } = press(p)
      await flush()
      await onTo(1_000)
      p.session.dispose()
      await onTo(KEEP_WAIT_MS)
      // Past the keep's wait, and nothing goes straight: the person
      // discarded it.
      expect(p.convex.calls).toHaveLength(0)
      expect(outcome.value).toEqual({ outcome: 'discarded' })
      // The lock held till the late keep is in.
      expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
      await onTo(LATE_MS)
      expect(notes('outbox-keep')).toContainEqual(
        expect.objectContaining({
          result: 'late',
          landed: when === 'after' ? 'refused' : 'kept',
        }),
      )
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(0)
    },
  )

  test.each(['left open', 'reloaded at 3 s'] as const)(
    'the review’s PROBE-R7 B2: written at 0.5 s and answering at 10 s, discarded at 1 s over a Back whose move never lands, then Book again on the same draft at 2 s: straight as the person’s own, and FormAlert; the booking still given up till the first press has it off, drawn by nothing, and never sent (the page %s)',
    async (how) => {
      const p = await phone()
      const day = drawDay(p, { dayLive: true })
      keepWrittenThenAnswered(p, 500, 9_500)
      // The draft as New Job holds it (`useDraftRequestId`).
      const d = draft()
      d.stopKeeping.mockImplementation(() => {
        d.keepable = false
      })
      const first = press(p, d)
      await onTo(1_000)
      expect(stored(p)).toMatchObject({ state: 'waiting', attempts: 0 })
      // Back asks; Discard. The move never lands, so the sheet stays up.
      p.session.discard()
      await onTo(1_600)
      expect(first.outcome.value).toEqual({ outcome: 'discarded' })
      expect(givenUpNote()).toEqual([LOCAL])
      // Book again, on the sheet still open, with the same draft.
      await onTo(2_000)
      const second = press(p, d)
      await flush()
      expect(p.convex.calls).toHaveLength(1)
      expect(p.convex.calls[0].args).toMatchObject({
        clientRequestId: REQUEST,
        asMembership: M1,
      })
      p.convex.calls[0].reject(SERVER_ERROR)
      await flush()
      expect(second.outcome.error).toBe(SERVER_ERROR)
      // The first press's still: given up, under its lock, and drawn by
      // nothing.
      expect(givenUpNote()).toEqual([LOCAL])
      expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
      expect(p.model.isDeciding(LOCAL)).toBe(true)
      expect(p.model.get(LOCAL)).toBeUndefined()
      await onTo(2_500)
      p.session.dispose()
      expect(p.sheet.booked).not.toHaveBeenCalled()
      await onTo(3_000)
      if (how === 'reloaded at 3 s') {
        const after = await reload(p)
        expect(p.backend.items.size).toBe(0)
        expect(after.model.all()).toEqual([])
        await vi.advanceTimersByTimeAsync(16 * 60_000)
        await flush()
        expect(p.convex.calls).toHaveLength(1)
        return
      }
      expect(givenUpNote()).toEqual([LOCAL])
      await onTo(10_000)
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(1)
      for (const drawn of day.draws) expect(drawn.slots).toEqual([])
    },
  )

  test.each(['left open', 'reloaded at 3 s'] as const)(
    'the main path (PROBE-R7 C): kept in time, discarded before the screen draws it kept, its delete taking 5 s; Book again on the same draft: straight as the person’s own; the booking still given up till it is off, drawn by nothing, and never sent (the page %s)',
    async (how) => {
      const p = await phone()
      const day = drawDay(p, { dayLive: true })
      const real = p.backend.update
      slowDeletes(p, 5_000)
      const d = draft()
      d.stopKeeping.mockImplementation(() => {
        d.keepable = false
      })
      // The screen a render behind: kept, not yet drawn so.
      p.sheet.lag = true
      const first = press(p, d)
      await flush()
      expect(p.sheet.now).toBe('kept')
      expect(stored(p)).toMatchObject({ state: 'waiting', attempts: 0 })
      // Discard, over a Back whose move never lands.
      p.session.discard()
      await flush()
      expect(first.outcome.value).toEqual({ outcome: 'discarded' })
      expect(givenUpNote()).toEqual([LOCAL])
      p.sheet.lag = false
      await onTo(1_000)
      const second = press(p, d)
      await flush()
      expect(p.convex.calls).toHaveLength(1)
      expect(p.convex.calls[0].args).toMatchObject({
        clientRequestId: REQUEST,
        asMembership: M1,
      })
      p.convex.calls[0].reject(SERVER_ERROR)
      await flush()
      expect(second.outcome.error).toBe(SERVER_ERROR)
      await onTo(2_000)
      expect(stored(p)).toMatchObject({ state: 'waiting', attempts: 0 })
      expect(givenUpNote()).toEqual([LOCAL])
      expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
      expect(p.model.isDeciding(LOCAL)).toBe(true)
      expect(p.model.get(LOCAL)).toBeUndefined()
      p.session.dispose()
      expect(p.sheet.booked).not.toHaveBeenCalled()
      await onTo(3_000)
      if (how === 'reloaded at 3 s') {
        p.backend.update = real
        const after = await reload(p)
        expect(p.backend.items.size).toBe(0)
        expect(after.model.all()).toEqual([])
        await vi.advanceTimersByTimeAsync(16 * 60_000)
        await flush()
        expect(p.convex.calls).toHaveLength(1)
        return
      }
      await onTo(6_000)
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(1)
      for (const drawn of day.draws) expect(drawn.slots).toEqual([])
    },
  )

  test('a keep that never lands, discarded: nothing sent, and the lock held for good', async () => {
    const p = await phone()
    p.deps.keep = () => new Promise(() => {})
    const { outcome } = press(p)
    await flush()
    p.session.dispose()
    await onTo(KEEP_WAIT_MS)
    expect(outcome.value).toEqual({ outcome: 'discarded' })
    await onTo(10 * 60_000)
    expect(p.convex.calls).toHaveLength(0)
    expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(true)
  })
})

describe('a close decided on what the screen showed, never on where the press had got to a render before (`shown`)', () => {
  test.each([
    ['down', false],
    ['up', true],
  ] as const)(
    'W1, the line %s: kept at 1 s with "Discard your changes?" open since 0.5 s, and Discard tapped before the screen has drawn it kept: discarded, never booked, nothing left on the phone, and nothing ever sent',
    async (_line, live) => {
      const p = await phone()
      p.keeper.live = live
      slowKeep(p, 1_000)
      const { outcome } = press(p)
      await onTo(500)
      // ✕ at 0.5 s: still being kept, so it asks.
      expect(p.sheet.now).toBe('keeping')
      // From here the screen is a render behind what the sheet is told.
      p.sheet.lag = true
      await onTo(1_000)
      expect(p.sheet.now).toBe('kept')
      expect(stored(p)).toMatchObject({ state: 'waiting' })
      // Neither closed on as kept nor sent while the screen still asks.
      expect(p.sheet.close).not.toHaveBeenCalled()
      expect(p.convex.calls).toHaveLength(0)
      // Discard, on the dialog the screen still shows; then the sheet goes.
      p.session.discard()
      p.session.dispose()
      await flush()
      expect(outcome.value).toEqual({ outcome: 'discarded' })
      expect(p.sheet.booked).not.toHaveBeenCalled()
      // The line back, or up all along: nothing of it goes.
      p.keeper.live = true
      p.sender.kick()
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(0)
      expect(p.sheet.booked).not.toHaveBeenCalled()
    },
  )

  test('…kept on editing instead: once the screen draws it kept, it is sent, and the job closes the sheet', async () => {
    const p = await phone()
    p.sheet.lag = true
    const { outcome } = press(p)
    await flush()
    expect(p.sheet.now).toBe('kept')
    expect(p.convex.calls).toHaveLength(0)
    p.sheet.draw()
    await flush()
    expect(p.convex.calls).toHaveLength(1)
    p.convex.calls[0].resolve('job-1')
    await flush()
    expect(outcome.value).toEqual({ outcome: 'sent', id: 'job-1' })
    expect(p.sheet.close).toHaveBeenCalledTimes(1)
    expect(p.sheet.booked).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['INVALID_ASSIGNEE', 'needsLook'],
    ['OUTBOX_PAUSED', 'waiting'],
  ] as const)(
    'W2: kept in time and sent, %s, the phone’s mark landed, and ✕ before the screen has drawn it not kept: closed as kept, so booked is said, nothing is thrown, and it stays on the phone as the answer left it',
    async (code, state) => {
      const { p, outcome } = await keptAndSent()
      p.sheet.lag = true
      p.convex.calls[0].reject(new ConvexError(code))
      await flush()
      // Told it isn't kept any more; the screen still shows it kept, with
      // no lock, and the phone takes nothing off until it shows otherwise.
      expect(p.sheet.now).toBe(code === 'OUTBOX_PAUSED' ? 'direct' : null)
      expect(stored(p)).toMatchObject({ state })
      expect(outcome.done).toBe(false)
      // ✕, or Back: it closes without asking.
      p.session.dispose()
      await flush()
      expect(p.sheet.booked).toHaveBeenCalledTimes(1)
      expect(outcome.value).toEqual({ outcome: 'kept' })
      expect(stored(p)).toMatchObject({ state })
      expect(p.model.mayDraw(LOCAL)).toBe(true)
      expect(p.lockManager.isHeld(itemLock(LOCAL))).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      await flush()
      expect(stored(p)).toBeDefined()
      // Nothing sent straight with no sheet; the kill switch's booking is
      // the sender's once its hold is up.
      expect(p.convex.calls).toHaveLength(1)
      expect(p.sheet.booked).toHaveBeenCalledTimes(1)
    },
  )

  test('…and once the screen draws it not kept: taken off the phone, and the refusal is FormAlert’s', async () => {
    const { p, outcome } = await keptAndSent()
    p.sheet.lag = true
    const refusal = new ConvexError('INVALID_ASSIGNEE')
    p.convex.calls[0].reject(refusal)
    await flush()
    expect(stored(p)).toMatchObject({ state: 'needsLook' })
    p.sheet.draw()
    await flush()
    expect(outcome.error).toBe(refusal)
    expect(stored(p)).toBeUndefined()
    expect(p.sheet.booked).not.toHaveBeenCalled()
  })

  test.each([
    ['reaching the phone after it', (p: Phone) => slowKeep(p, 1_000)],
    [
      'written before it, answering after',
      (p: Phone) => keepWrittenThenAnswered(p, 400, 600),
    ],
  ] as const)(
    'Discard over a Back at 0.5 s, the keep %s and the move landing at 1.2 s: discarded as it was confirmed, whatever the sheet drew meanwhile, and nothing of it goes',
    async (_keep, slow) => {
      const p = await phone()
      slow(p)
      const { outcome } = press(p)
      await onTo(500)
      // Back asks; Discard. The move goes on, the sheet still up over it.
      p.session.discard()
      await onTo(1_200)
      expect(p.convex.calls).toHaveLength(0)
      expect(p.sheet.close).not.toHaveBeenCalled()
      expect(outcome.value).toEqual({ outcome: 'discarded' })
      // The move lands, and the sheet goes.
      p.session.dispose()
      expect(p.sheet.booked).not.toHaveBeenCalled()
      await nothingAfter(p)
      expect(p.convex.calls).toHaveLength(0)
      expect(p.sheet.booked).not.toHaveBeenCalled()
    },
  )
})

function notes(event: string): Array<unknown> {
  return vi
    .mocked(logConnection)
    .mock.calls.filter(([what]) => what === event)
    .map(([, details]) => details)
}
