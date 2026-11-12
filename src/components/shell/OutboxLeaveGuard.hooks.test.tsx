import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { FIX_ARM_MS } from '#/components/forms/saveWarningRules'
import { confirmLeave } from '#/lib/offline/leaveGuard'
import { SEND_LOCK, takeLock } from '#/lib/outbox/outboxLocks'
import { noteKeptBefore } from '#/lib/outbox/outboxStore'
import { B1, itemFor, memoryStorage } from '#/lib/outbox/outboxStore.fixtures'
import {
  resetSwitchGateForTests,
  switchStarting,
} from '#/lib/outbox/switchGate'
import { OutboxLeaveGuard } from './OutboxLeaveGuard'
import type * as React from 'react'
import type * as Locks from '#/lib/outbox/outboxLocks'
import type { FakeLockManager } from '#/lib/outbox/fakeLocks.fixtures'
import type { ReactElement } from 'react'
import type { OutboxItem } from '#/lib/outbox/outboxItem'

/**
 * The question a sign-out asks of the bookings on this phone, as the person
 * meets it: it comes up a moment after the tap that asked, or, asked again,
 * just where the last one's Discard and sign out was. So each question is
 * held for FIX_ARM_MS (`ConfirmDialog`'s `held`), and a double tap is no
 * answer.
 *
 * OutboxLeaveGuard runs here by the hook harness, called as React would call
 * it: there is no document to render into, so what it hands ConfirmDialog
 * is read from the element it returns.
 */

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))
vi.mock('#/lib/rootState', () => ({ signedInUserId: () => 'u1' }))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))
// A phone with Web Locks, as the guard asks (`storage`), this page its tab
// 'a'; the test asks for the send lock as another tab would.
const locks = vi.hoisted(() => ({ phone: null as FakeLockManager | null }))
vi.mock('#/lib/outbox/outboxLocks', async (importOriginal) => {
  const { FakeLockManager: Manager } =
    await import('#/lib/outbox/fakeLocks.fixtures')
  const phone = new Manager()
  locks.phone = phone
  return {
    ...(await importOriginal<typeof Locks>()),
    browserLocks: () => phone.forTab('a'),
  }
})

/** Whether another tab could start a send now, letting go at once. */
async function otherTabSends(): Promise<boolean> {
  const held = await takeLock(locks.phone!.forTab('b'), SEND_LOCK, {
    mode: 'shared',
    ifAvailable: true,
  })
  held?.release()
  return held !== null
}

type Dialog = ReactElement<{
  open: boolean
  held: boolean
  body: string
  onConfirm: () => void
  labelInset?: boolean
}>

let unmount: (() => void) | null = null

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('indexedDB', {})
})

afterEach(() => {
  unmount?.()
  unmount = null
  resetSwitchGateForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the sign-out’s question (`OutboxLeaveGuard`)', () => {
  test('comes up held for FIX_ARM_MS, and so does each it asks again (F8)', async () => {
    vi.useFakeTimers()
    let items: Array<OutboxItem> = [itemFor('u1')]
    // As the page's read of them notes, whatever the build (D14).
    noteKeptBefore()
    // Made once, as the root hands them in.
    const props: Parameters<typeof OutboxLeaveGuard>[0] = {
      outbox: {
        readable: () => true,
        all: () => items,
        subscribe: () => () => {},
        refreshed: () => Promise.resolve(true),
      },
      sender: { inflight: () => 0 },
      keeper: {
        enteredBusiness: () =>
          ({ _id: B1 }) as ReturnType<
            Parameters<typeof OutboxLeaveGuard>[0]['keeper']['enteredBusiness']
          >,
      },
    }
    const view = hookHarness.mount(() => OutboxLeaveGuard(props))
    unmount = view.unmount
    const dialog = () => view.current() as Dialog
    // Its words may take two lines ("Discard and sign out", "Stay in
    // {business name}"), so they sit clear of the buttons' rounded corners:
    // asked of this dialog alone, every other keeping its full width.
    expect(dialog().props.labelInset).toBe(true)

    const leaving = confirmLeave('signOut')
    await vi.advanceTimersByTimeAsync(0)
    expect(dialog().props.open).toBe(true)
    expect(dialog().props.held).toBe(true)
    // None of this tab's starts going while it is up (F0); another tab's
    // may, as the question's lifetime is the person's to choose, and a yes
    // counts again from a fresh read.
    expect(switchStarting()).toBe(true)
    expect(await otherTabSends()).toBe(true)
    await vi.advanceTimersByTimeAsync(FIX_ARM_MS - 1)
    expect(dialog().props.held).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(dialog().props.held).toBe(false)

    // Another tab began sending it while the question was up: confirmed, it
    // is asked again, right where Discard and sign out was, held again.
    items = [{ ...items[0], state: 'sending' }]
    dialog().props.onConfirm()
    await vi.advanceTimersByTimeAsync(0)
    expect(dialog().props.open).toBe(true)
    expect(dialog().props.body).toMatch(/may already have gone/)
    expect(dialog().props.held).toBe(true)
    await vi.advanceTimersByTimeAsync(FIX_ARM_MS)
    expect(dialog().props.held).toBe(false)
    expect(await otherTabSends()).toBe(true)
    dialog().props.onConfirm()
    expect(await leaving).toBe(true)
    expect(dialog().props.open).toBe(false)
    // From the yes, no tab starts one…
    expect(switchStarting()).toBe(true)
    expect(await otherTabSends()).toBe(false)
    // …until the sign-out has had its turn to discard them.
    await vi.advanceTimersByTimeAsync(0)
    expect(switchStarting()).toBe(false)
    expect(await otherTabSends()).toBe(true)
  })
})
