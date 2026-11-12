import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { authClient } from '#/lib/auth-client'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { registerLeaveGuard } from '#/lib/offline/leaveGuard'
import { LEAVE_SEND_WAIT_MS, leaveGuardFor } from '#/lib/outbox/leaveAsk'
import { B1, itemFor, memoryStorage } from '#/lib/outbox/outboxStore.fixtures'
import { beginSignOut, forgetCachedPages, signOutFailed } from '#/lib/rootState'
import { SIGN_OUT_COPY, SIGN_OUT_WAIT_MS, useSignOut } from './useSignOut'
import type { Mock } from 'vitest'
import type * as React from 'react'
import type { OutboxItem } from '#/lib/outbox/outboxItem'

/**
 * Every way to sign out (plan part 2c §11.3): with no signal it says so and
 * does nothing else, the person still signed in and nothing cleared (S20);
 * asked about the bookings on this phone not sent yet first; and one whose
 * request then fails says so, and that what the confirm discarded stays
 * discarded (D27). The six screens' buttons are pinned to it in
 * signOutWiring.test.ts.
 */

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))
vi.mock('#/lib/auth-client', () => ({ authClient: { signOut: vi.fn() } }))

/** The bookings on this phone, as this tab holds them. */
const phone = vi.hoisted(() => ({ items: [] as Array<OutboxItem> }))

// What a sign-out does first, as rootState's does it: the sign-out's
// tombstone (outboxStore.ts), which every reader of the phone's bookings
// honours from then on, whatever the wipe does.
vi.mock('#/lib/rootState', async () => {
  const { writeSignOutTombstone } = await import('#/lib/outbox/outboxStore')
  return {
    beginSignOut: vi.fn(() => writeSignOutTombstone('u1')),
    forgetCachedPages: vi.fn(async () => {}),
    signOutFailed: vi.fn(),
    signedInUserId: () => 'u1',
  }
})
vi.mock('#/lib/outbox/outbox', async () => {
  const { stillKept } = await import('#/lib/outbox/outboxStore')
  return { outbox: { all: () => phone.items.filter(stillKept) } }
})

const page = {
  replace: vi.fn(),
  reload: vi.fn(),
}

const stops: Array<() => void> = []

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('window', { location: page })
  page.replace.mockClear()
  page.reload.mockClear()
  vi.mocked(beginSignOut).mockClear()
  vi.mocked(signOutFailed).mockClear()
  vi.mocked(forgetCachedPages).mockClear()
  signOutMock().mockReset()
  phone.items = []
})

afterEach(() => {
  hookHarness.mount(() => null)
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The person's answer to the question about bookings not sent yet. */
function answering(go: boolean) {
  const asked = vi.fn(() => go)
  stops.push(registerLeaveGuard(asked))
  return asked
}

const signOutMock = () =>
  authClient.signOut as unknown as Mock<() => Promise<{ error: unknown }>>

describe('signing out with no signal (S20)', () => {
  test.each(['login', 'reload'] as const)(
    'then %s: says “Signing out needs signal.” and clears nothing',
    async (then) => {
      vi.stubGlobal('navigator', { onLine: false })
      phone.items = [itemFor('u1')]
      const asked = answering(true)
      const hook = hookHarness.mount(() => useSignOut({ then }))
      await hook.current().signOut()
      expect(hook.current().problem).toBe('Signing out needs signal.')
      expect(SIGN_OUT_COPY.offline).toBe('Signing out needs signal.')
      expect(hook.current().signingOut).toBe(false)
      // Not asked, nothing discarded, no request, still here.
      expect(asked).not.toHaveBeenCalled()
      expect(beginSignOut).not.toHaveBeenCalled()
      expect(authClient.signOut).not.toHaveBeenCalled()
      expect(page.replace).not.toHaveBeenCalled()
      expect(page.reload).not.toHaveBeenCalled()
      const { outbox } = await import('#/lib/outbox/outbox')
      expect(outbox.all()).toHaveLength(1)
    },
  )

  test('the signal gone while the question was up: still nothing', async () => {
    phone.items = [itemFor('u1')]
    stops.push(
      registerLeaveGuard(() => {
        vi.stubGlobal('navigator', { onLine: false })
        return true
      }),
    )
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    await hook.current().signOut()
    expect(hook.current().problem).toBe('Signing out needs signal.')
    expect(beginSignOut).not.toHaveBeenCalled()
    expect(authClient.signOut).not.toHaveBeenCalled()
  })
})

describe('signing out with signal', () => {
  test('Stay signed in: nothing happens', async () => {
    phone.items = [itemFor('u1')]
    answering(false)
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    await hook.current().signOut()
    expect(hook.current().problem).toBeNull()
    expect(beginSignOut).not.toHaveBeenCalled()
    expect(authClient.signOut).not.toHaveBeenCalled()
  })

  test('answered in time: the sign-in page, in place of this one; or the same link again', async () => {
    signOutMock().mockResolvedValue({ error: null })
    const login = hookHarness.mount(() => useSignOut({ then: 'login' }))
    await login.current().signOut()
    expect(beginSignOut).toHaveBeenCalledOnce()
    expect(forgetCachedPages).toHaveBeenCalledOnce()
    expect(page.replace).toHaveBeenCalledWith('/login')

    const reload = hookHarness.mount(() => useSignOut({ then: 'reload' }))
    await reload.current().signOut()
    expect(page.reload).toHaveBeenCalledOnce()
  })

  test('a request that fails after the confirm discarded 2: says so, and they stay discarded (D27)', async () => {
    phone.items = [itemFor('u1', {}, 1_000), itemFor('u1', {}, 1_000)]
    answering(true)
    signOutMock().mockResolvedValue({ error: { status: 500 } })
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    await hook.current().signOut()
    expect(hook.current().problem).toBe(
      'Could not sign out. Check your signal and try again. The 2 jobs not sent yet were discarded.',
    )
    expect(hook.current().signingOut).toBe(false)
    expect(signOutFailed).toHaveBeenCalledOnce()
    expect(page.replace).not.toHaveBeenCalled()
    const { outbox } = await import('#/lib/outbox/outbox')
    expect(outbox.all()).toEqual([])
  })

  test('a request that fails with a booking being sent: never says that one was discarded, as its call is still out and may yet book it', async () => {
    // Bars showing, the line black-holed: this tab's send of it went out
    // and has no answer, past the 4 s the sign-out waits for it.
    vi.useFakeTimers({ now: 2_000 })
    phone.items = [itemFor('u1', { state: 'sending', lastAttemptAt: 900 }, 800)]
    const asked: Array<string> = []
    stops.push(
      registerLeaveGuard(
        leaveGuardFor(
          {
            storage: true,
            enabled: true,
            keptBefore: () => true,
            readable: () => true,
            readFresh: () => Promise.resolve(true),
            subscribe: () => () => {},
            items: () => phone.items,
            inflight: () => 1,
            holdSends: () => Promise.resolve(() => {}),
            holdHere: () => () => {},
            userId: () => 'u1',
            businessId: () => B1,
          },
          async (question) => {
            asked.push(question.body)
            return true
          },
        ),
      ),
    )
    signOutMock().mockResolvedValue({ error: { status: 500 } })
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    const going = hook.current().signOut()
    await vi.advanceTimersByTimeAsync(LEAVE_SEND_WAIT_MS)
    await going
    expect(asked).toEqual([
      'It’s only on this phone. It may already have gone — check the schedule when you’re back.',
    ])
    expect(signOutFailed).toHaveBeenCalledOnce()
    expect(hook.current().problem).toBe(
      'Could not sign out. Check your signal and try again. The job being sent may still be booked — check the schedule before booking it again.',
    )
  })

  test('one waiting and one being sent: the one waiting was discarded, the one being sent may still be booked', async () => {
    phone.items = [
      itemFor('u1', {}, 1_000),
      itemFor('u1', { state: 'sending', lastAttemptAt: 1_100 }, 1_000),
    ]
    answering(true)
    signOutMock().mockResolvedValue({ error: { status: 500 } })
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    await hook.current().signOut()
    expect(hook.current().problem).toBe(
      'Could not sign out. Check your signal and try again. The job not sent yet was discarded. 1 being sent may still be booked — check the schedule before booking it again.',
    )
  })

  test('one with nothing to discard says only that it failed', async () => {
    signOutMock().mockRejectedValue(new Error('offline'))
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    await hook.current().signOut()
    expect(hook.current().problem).toBe(
      'Could not sign out. Check your signal and try again.',
    )
  })

  test('no answer in ten seconds: says so; landing later, it finishes then', async () => {
    vi.useFakeTimers()
    let land: (value: { error: unknown }) => void = () => {}
    signOutMock().mockReturnValue(
      new Promise((resolve) => {
        land = resolve
      }),
    )
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    const going = hook.current().signOut()
    await vi.advanceTimersByTimeAsync(SIGN_OUT_WAIT_MS)
    await going
    expect(hook.current().problem).toBe(SIGN_OUT_COPY.failed)
    expect(page.replace).not.toHaveBeenCalled()
    land({ error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(page.replace).toHaveBeenCalledWith('/login')
  })

  test('after the question asked of a phone that couldn’t be read, it can’t say how many were discarded (F22)', async () => {
    // Two on the phone this tab holds, from an earlier read; the fresh read
    // the question asked for failed, so it asked the generic question.
    phone.items = [itemFor('u1', {}, 1_000), itemFor('u1', {}, 1_000)]
    stops.push(
      registerLeaveGuard(
        leaveGuardFor(
          {
            storage: true,
            enabled: true,
            keptBefore: () => true,
            readable: () => true,
            readFresh: () => Promise.resolve(false),
            subscribe: () => () => {},
            items: () => phone.items,
            inflight: () => 0,
            holdSends: () => Promise.resolve(() => {}),
            holdHere: () => () => {},
            userId: () => 'u1',
            businessId: () => B1,
          },
          async () => true,
        ),
      ),
    )
    signOutMock().mockResolvedValue({ error: { status: 500 } })
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    await hook.current().signOut()
    expect(hook.current().problem).toBe(
      'Could not sign out. Check your signal and try again. Any jobs not sent yet on this phone were discarded.',
    )
  })

  test('says it is signing out from the tap, while the question is worked out and up (F6)', async () => {
    let answer: (go: boolean) => void = () => {}
    stops.push(
      registerLeaveGuard(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          }),
      ),
    )
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    expect(hook.current().checking).toBe(false)
    const first = hook.current().signOut()
    expect(hook.current().checking).toBe(true)
    expect(hook.current().signingOut).toBe(false)
    answer(false)
    await first
    expect(hook.current().checking).toBe(false)
    expect(beginSignOut).not.toHaveBeenCalled()
  })

  test('a second tap while the first is asking is the same tap', async () => {
    let answer: (go: boolean) => void = () => {}
    stops.push(
      registerLeaveGuard(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          }),
      ),
    )
    signOutMock().mockResolvedValue({ error: null })
    const hook = hookHarness.mount(() => useSignOut({ then: 'login' }))
    const first = hook.current().signOut()
    await hook.current().signOut()
    answer(true)
    await first
    expect(beginSignOut).toHaveBeenCalledOnce()
    expect(authClient.signOut).toHaveBeenCalledOnce()
  })
})
