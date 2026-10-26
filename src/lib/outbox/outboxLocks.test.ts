import { afterEach, describe, expect, test, vi } from 'vitest'
import { FakeLockManager } from './fakeLocks.fixtures'
import { SEND_LOCK, itemLock, lockHeld, takeLock } from './outboxLocks'
import {
  duringSwitchStart,
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

describe('an account switch starting', () => {
  test('stops new sends in this tab at once, and in every tab while it asks for the send lock', async () => {
    const phone = new FakeLockManager()
    const told = vi.fn()
    const stop = onSwitchGate(told)
    let finish: (value: string) => void = () => {}
    const started = duringSwitchStart(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
      phone.forTab('a'),
    )
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
