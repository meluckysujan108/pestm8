import { afterEach, describe, expect, test, vi } from 'vitest'
import { FakeLockManager } from './fakeLocks.fixtures'
import {
  SEND_LOCK,
  holdTabLock,
  itemLock,
  lockHeld,
  retakeTabLock,
  tabLock,
  takeLock,
} from './outboxLocks'
import {
  duringSwitchStart,
  holdSends,
  holdSendsHere,
  onSwitchGate,
  resetSwitchGateForTests,
  switchStarting,
} from './switchGate'
import { SWITCH_WAIT_MS } from './outboxSet'

/**
 * The Web Locks that keep two tabs off one booking, and every send off an
 * account switch as it starts. What matters: a lock is held until it is let
 * go, whoever took it, so it can be handed on with the call it covers; a
 * booking's lock is never waited for; and a switch starting stops new sends
 * everywhere, waits for one already out, and never waits for it forever.
 */

afterEach(() => {
  resetSwitchGateForTests()
  vi.useRealTimers()
})

describe('a lock', () => {
  test('is held until it is let go, not when the one who took it is done', async () => {
    const phone = new FakeLockManager()
    const tab = phone.forTab('a')
    const held = await takeLock(tab, itemLock('x'))
    expect(held?.name).toBe('pestm8-outbox:item:x')
    expect(phone.isHeld(itemLock('x'), 'a')).toBe(true)
    expect(await lockHeld(tab, itemLock('x'))).toBe(true)
    held?.release()
    // Once counts, however often.
    held?.release()
    await Promise.resolve()
    expect(phone.isHeld(itemLock('x'))).toBe(false)
  })

  test('a booking’s is taken only if it is free: another tab’s holding it is null at once', async () => {
    const phone = new FakeLockManager()
    const mine = await takeLock(phone.forTab('a'), itemLock('x'), {
      ifAvailable: true,
    })
    expect(mine).not.toBeNull()
    expect(
      await takeLock(phone.forTab('b'), itemLock('x'), { ifAvailable: true }),
    ).toBeNull()
    // Another booking's is free all the while.
    expect(
      await takeLock(phone.forTab('b'), itemLock('y'), { ifAvailable: true }),
    ).not.toBeNull()
  })

  test('a wait given up is null, and holds nothing', async () => {
    const phone = new FakeLockManager()
    const first = await takeLock(phone.forTab('a'), SEND_LOCK, {
      mode: 'shared',
    })
    const controller = new AbortController()
    const waiting = takeLock(phone.forTab('b'), SEND_LOCK, {
      mode: 'exclusive',
      signal: controller.signal,
    })
    controller.abort()
    expect(await waiting).toBeNull()
    first?.release()
    await Promise.resolve()
    expect(phone.held).toEqual([])
  })

  test('a request that throws is null', async () => {
    const broken = {
      request: () => {
        throw new Error('no locks here')
      },
      query: () => Promise.reject(new Error('no locks here')),
    } as unknown as Parameters<typeof takeLock>[0]
    expect(await takeLock(broken, SEND_LOCK)).toBeNull()
    expect(await lockHeld(broken, SEND_LOCK)).toBe(false)
  })
})

describe('a tab’s own lock, back from the back/forward cache', () => {
  test('let go of as the page went in, it is taken again, and held only the once', async () => {
    const phone = new FakeLockManager()
    const tab = phone.forTab('a')
    expect(await holdTabLock(tab, 'restored')).toBe(true)
    phone.closeTab('a')
    expect(phone.isHeld(tabLock('restored'))).toBe(false)
    await retakeTabLock(tab, 'restored')
    expect(phone.isHeld(tabLock('restored'), 'a')).toBe(true)
    expect(await holdTabLock(tab, 'restored')).toBe(true)
    expect(phone.held).toHaveLength(1)
  })

  test('where the browser kept it, nothing waits on itself, and it is still held', async () => {
    const phone = new FakeLockManager()
    const tab = phone.forTab('a')
    await holdTabLock(tab, 'kept')
    await retakeTabLock(tab, 'kept')
    expect(phone.waiting).toEqual([])
    expect(phone.held).toHaveLength(1)
    expect(await holdTabLock(tab, 'kept')).toBe(true)
  })

  test('a tab that never took it takes nothing', async () => {
    const phone = new FakeLockManager()
    await retakeTabLock(phone.forTab('a'), 'never')
    expect(phone.held).toEqual([])
  })
})

describe('an account switch starting', () => {
  test('stops new sends in this tab at once, and in every tab while it asks for the send lock', async () => {
    const phone = new FakeLockManager()
    const told = vi.fn()
    const stop = onSwitchGate(told)
    // Answered whenever the start is made: it waits on the lock first.
    let finish: (value: string) => void = () => {}
    const answer = new Promise<string>((resolve) => {
      finish = resolve
    })
    const started = duringSwitchStart(() => answer, phone.forTab('a'))
    expect(switchStarting()).toBe(true)
    expect(told).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    // Held exclusively while the start is out: no tab gets a send lock.
    expect(
      await takeLock(phone.forTab('b'), SEND_LOCK, {
        mode: 'shared',
        ifAvailable: true,
      }),
    ).toBeNull()
    finish('switched')
    expect(await started).toBe('switched')
    expect(switchStarting()).toBe(false)
    expect(told).toHaveBeenCalledTimes(2)
    expect(phone.held).toEqual([])
    stop()
  })

  test('waits for a send another tab already has out, and starts once it is done', async () => {
    const phone = new FakeLockManager()
    const sending = await takeLock(phone.forTab('b'), SEND_LOCK, {
      mode: 'shared',
    })
    const start = vi.fn(async () => 'switched')
    const started = duringSwitchStart(start, phone.forTab('a'))
    await Promise.resolve()
    expect(start).not.toHaveBeenCalled()
    // Waiting for it, it keeps a new send out, here as anywhere.
    expect(
      await takeLock(phone.forTab('c'), SEND_LOCK, {
        mode: 'shared',
        ifAvailable: true,
      }),
    ).toBeNull()
    sending?.release()
    expect(await started).toBe('switched')
    expect(start).toHaveBeenCalledTimes(1)
  })

  test(`gives up waiting for a frozen tab’s send after ${SWITCH_WAIT_MS / 1000} s, and starts anyway`, async () => {
    vi.useFakeTimers()
    const phone = new FakeLockManager()
    await takeLock(phone.forTab('frozen'), SEND_LOCK, { mode: 'shared' })
    const start = vi.fn(async () => 'switched')
    const started = duringSwitchStart(start, phone.forTab('a'))
    await vi.advanceTimersByTimeAsync(SWITCH_WAIT_MS - 1)
    expect(start).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await started).toBe('switched')
    expect(phone.waiting).toEqual([])
    expect(switchStarting()).toBe(false)
  })

  test('started past its wait, it still keeps every other tab’s new sends out until the start is done', async () => {
    vi.useFakeTimers()
    const phone = new FakeLockManager()
    await takeLock(phone.forTab('frozen'), SEND_LOCK, { mode: 'shared' })
    let finish: (value: string) => void = () => {}
    const answer = new Promise<string>((resolve) => {
      finish = resolve
    })
    const start = vi.fn(() => answer)
    const started = duringSwitchStart(start, phone.forTab('a'))
    await vi.advanceTimersByTimeAsync(SWITCH_WAIT_MS)
    expect(start).toHaveBeenCalledTimes(1)
    expect(
      await takeLock(phone.forTab('b'), SEND_LOCK, {
        mode: 'shared',
        ifAvailable: true,
      }),
    ).toBeNull()
    finish('switched')
    expect(await started).toBe('switched')
    expect(phone.waiting).toEqual([])
  })

  test('without Web Locks, says so in this tab alone', async () => {
    let during = false
    await duringSwitchStart(async () => {
      during = switchStarting()
    }, null)
    expect(during).toBe(true)
    expect(switchStarting()).toBe(false)
  })

  test('a start that fails still lets sends go again', async () => {
    const phone = new FakeLockManager()
    await expect(
      duringSwitchStart(async () => {
        throw new Error('SWITCH_NOT_PERMITTED')
      }, phone.forTab('a')),
    ).rejects.toThrow('SWITCH_NOT_PERMITTED')
    expect(switchStarting()).toBe(false)
    expect(phone.held).toEqual([])
  })
})

describe('a sign-out’s question holding sends (`holdSends`)', () => {
  test('holds every send, here and in every tab, until let go, once however often', async () => {
    const phone = new FakeLockManager()
    const release = await holdSends(4_000, phone.forTab('a'))
    expect(switchStarting()).toBe(true)
    expect(
      await takeLock(phone.forTab('b'), SEND_LOCK, {
        mode: 'shared',
        ifAvailable: true,
      }),
    ).toBeNull()
    release()
    release()
    await Promise.resolve()
    expect(switchStarting()).toBe(false)
    expect(phone.held).toEqual([])
  })

  test('waits for a send already out up to its wait, then holds this tab’s anyway', async () => {
    vi.useFakeTimers()
    const phone = new FakeLockManager()
    await takeLock(phone.forTab('frozen'), SEND_LOCK, { mode: 'shared' })
    const holding = holdSends(4_000, phone.forTab('a'))
    let held = false
    void holding.then(() => {
      held = true
    })
    await vi.advanceTimersByTimeAsync(3_999)
    expect(held).toBe(false)
    expect(switchStarting()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    const release = await holding
    expect(switchStarting()).toBe(true)
    release()
    expect(switchStarting()).toBe(false)
  })

  test('past its wait, it still keeps every other tab’s new sends out, until it is let go', async () => {
    vi.useFakeTimers()
    const phone = new FakeLockManager()
    const frozen = await takeLock(phone.forTab('frozen'), SEND_LOCK, {
      mode: 'shared',
    })
    const holding = holdSends(4_000, phone.forTab('a'))
    await vi.advanceTimersByTimeAsync(4_000)
    const release = await holding
    const sendFrom = (tab: string) =>
      takeLock(phone.forTab(tab), SEND_LOCK, {
        mode: 'shared',
        ifAvailable: true,
      })
    // Still asked for: no other tab starts a send behind the frozen one.
    expect(await sendFrom('b')).toBeNull()
    // The frozen tab's send done at last: the hold has the lock now.
    frozen?.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(phone.isHeld(SEND_LOCK, 'a')).toBe(true)
    expect(await sendFrom('b')).toBeNull()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(phone.held).toEqual([])
    const after = await sendFrom('b')
    expect(after).not.toBeNull()
    after?.release()
  })

  test('let go before it had the lock: asked for no longer, and never held', async () => {
    vi.useFakeTimers()
    const phone = new FakeLockManager()
    const frozen = await takeLock(phone.forTab('frozen'), SEND_LOCK, {
      mode: 'shared',
    })
    const holding = holdSends(4_000, phone.forTab('a'))
    await vi.advanceTimersByTimeAsync(4_000)
    ;(await holding)()
    expect(switchStarting()).toBe(false)
    expect(phone.waiting).toEqual([])
    frozen?.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(phone.held).toEqual([])
  })

  test('this tab’s alone (`holdSendsHere`): every other tab sends on', async () => {
    const phone = new FakeLockManager()
    const release = holdSendsHere()
    expect(switchStarting()).toBe(true)
    const other = await takeLock(phone.forTab('b'), SEND_LOCK, {
      mode: 'shared',
      ifAvailable: true,
    })
    expect(other).not.toBeNull()
    other?.release()
    release()
    release()
    expect(switchStarting()).toBe(false)
  })
})
