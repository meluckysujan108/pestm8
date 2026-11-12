import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { outbox } from './outbox'
import {
  answeredChange,
  beginSendChange,
  checkOutboxOwner,
  discardChange,
  forgetSentChange,
  markSessionEnded,
  setOutboxBackendForTests,
} from './outboxStore'
import { STALE_AFTER_MS } from './outboxSet'
import {
  B1,
  itemFor,
  memoryStorage,
  outboxOf,
  personOf,
} from './outboxStore.fixtures'
import { useOnPhoneLine, useUnsentByBusiness } from './useOnPhone'
import type * as React from 'react'
import type { OutboxItem } from './outboxItem'

/**
 * The sign-in screens' line (`useOnPhoneLine`, plan §11.4, S13) as a page
 * reads it over this page load's outbox. A session ended elsewhere (revoked,
 * expired, offboarded) takes the page to /login without a reload, so the
 * line is read by a tab that may have sent or discarded bookings since the
 * page load read the phone: it says only what is on the phone now, never a
 * job that has gone.
 *
 * The hook runs here by the hook harness: there is no document to render
 * into.
 */

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))
const who = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('#/lib/rootState', () => ({ signedInUserId: () => who.id }))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))

const KEVINS_LINE =
  'Kevin has 1 job on this phone not sent yet. It’s kept until Kevin signs in again and sends it. Signing in as anyone else discards it.'

const stops: Array<() => void> = []

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  hookHarness.mount(() => null)
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  who.id = null
  vi.unstubAllGlobals()
})

/** Every read and write under way, answered. */
async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Kevin's phone with `item` on it, signed in: the page load's read of the
 * phone, and this tab's outbox following it. */
async function kevinsPhone(item: OutboxItem) {
  const backend = await outboxOf('u1', [item], 'Kevin')
  setOutboxBackendForTests(backend)
  checkOutboxOwner(personOf('u1', 'Kevin'))
  stops.push(outbox.start(() => null))
  await outbox.refresh()
  await settle()
  return backend
}

/** /login, reached without a reload: its line, read as it mounts. */
async function loginLine() {
  const view = hookHarness.mount(() => useOnPhoneLine())
  await settle()
  return view.current()
}

describe('the sign-in screens’ line (`useOnPhoneLine`)', () => {
  test('says whose booking is on the phone', async () => {
    await kevinsPhone(itemFor('u1'))
    expect(await loginLine()).toBe(KEVINS_LINE)
  })

  test('nothing for a booking discarded since the page load read the phone, once the session ends elsewhere', async () => {
    const kevins = itemFor('u1')
    const backend = await kevinsPhone(kevins)
    const before = hookHarness.mount(() => useOnPhoneLine())
    await settle()
    expect(before.current()).toBe(KEVINS_LINE)

    // Discarded on its sheet: off the phone.
    expect(
      await outbox.change('discard', kevins.localId, discardChange()),
    ).toBe('deleted')
    expect(backend.items.size).toBe(0)
    await settle()
    expect(before.current()).toBeNull()

    // The session then ends elsewhere: nothing of Kevin's is left to mark,
    // so nothing tells the page to read the phone again.
    await markSessionEnded('u1')
    expect(await loginLine()).toBeNull()
  })

  test('nothing for one sent and swept since, once the session ends elsewhere', async () => {
    const kevins = itemFor('u1')
    const backend = await kevinsPhone(kevins)

    // The signal back: sent, PestM8 answered, and the sweep takes it off.
    expect(
      await outbox.change('send', kevins.localId, beginSendChange(2_000)),
    ).toMatchObject({ state: 'sending' })
    expect(
      await outbox.change(
        'answered',
        kevins.localId,
        answeredChange((item) => ({
          ...item,
          state: 'sent',
          result: { id: 'job-1' },
          sentAt: 2_000,
          updatedAt: 2_000,
        })),
      ),
    ).toMatchObject({ state: 'sent' })
    expect(
      await outbox.change('forget-sent', kevins.localId, forgetSentChange()),
    ).toBe('deleted')
    expect(backend.items.size).toBe(0)

    await markSessionEnded('u1')
    expect(await loginLine()).toBeNull()
  })

  test('a booking still on the phone as the session ends: still said', async () => {
    await kevinsPhone(itemFor('u1'))
    await markSessionEnded('u1')
    expect(await loginLine()).toBe(KEVINS_LINE)
  })
})

describe('how many of the person’s wait in each business (`useUnsentByBusiness`)', () => {
  test('one kept too long to go by itself is said as needing a look once its three days are up, though nothing on the phone changed (D23)', async () => {
    // The clock and the minute's look again faked; the store's reads not.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const saved = Date.now()
    who.id = 'u1'
    await kevinsPhone(itemFor('u1', {}, saved))
    const view = hookHarness.mount(() => useUnsentByBusiness())
    await settle()
    expect(view.current()?.get(B1)).toEqual({ count: 1, needsLook: 0 })
    // Three days on, with the line down all that time: still waiting on the
    // phone, which the sender won't send by itself (SwitchBanner's line
    // would have said it goes when the person switches back).
    vi.setSystemTime(saved + STALE_AFTER_MS + 1)
    vi.advanceTimersByTime(60_000)
    expect(view.current()?.get(B1)).toEqual({ count: 0, needsLook: 1 })
  })
})
