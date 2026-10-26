import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { keptFor } from './offline/keptStore.fixtures'
import { beginSendChange } from './outbox/outboxStore'
import {
  MemoryOutboxBackend,
  SESSION,
  itemFor,
  memoryStorage,
  outboxOf,
} from './outbox/outboxStore.fixtures'
import { isStale } from './outbox/outboxSet'
import type { MemoryKeptBackend } from './offline/keptStore.fixtures'
import type * as KeptSet from './offline/keptSet'

/**
 * The copy of the schedule kept on this phone goes whenever the person
 * holding the phone may have changed: the moment a sign-out begins (before
 * any request, which may never land), at every sign-in and sign-out's full
 * load, and as soon as a page load knows who is signed in, if the copy is
 * someone else's or nobody is.
 */

vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))

function jwtFor(sub: string, name?: string, sessionId?: string): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${part({ alg: 'EdDSA' })}.${part({ sub, iat: 1, name, sessionId })}.signature`
}

/** Every operation queued so far has run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A new page load: this module, the kept copy's and the outbox's, afresh. */
async function freshPage(
  backend: MemoryKeptBackend,
  outbox: MemoryOutboxBackend = new MemoryOutboxBackend(),
) {
  vi.resetModules()
  const store = await import('./offline/keptStore')
  store.setKeptBackendForTests(backend)
  const outboxStore = await import('./outbox/outboxStore')
  outboxStore.setOutboxBackendForTests(outbox)
  const root = await import('./rootState')
  const { getInitialState } = await import('#/lib/initialState')
  const { logConnection } = await import('#/lib/connectionLog')
  vi.mocked(logConnection).mockClear()
  return {
    root,
    store,
    outboxStore,
    getInitialState: vi.mocked(getInitialState),
    logConnection,
  }
}

/** The wipes noted, by why. */
function wipesNoted(log: ReturnType<typeof vi.fn>): Array<unknown> {
  return log.mock.calls
    .filter(([event]) => event === 'kept-wipe')
    .map(([, details]) => (details as { why: string }).why)
}

beforeEach(() => {
  // One phone's: it outlives every page load in a test.
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('signing out', () => {
  test('wipes the kept copy the moment it begins', async () => {
    const backend = await keptFor('u1')
    const { root, store, logConnection } = await freshPage(backend)
    let told = false
    store.onKeptWiped(() => {
      told = true
    })

    root.beginSignOut()
    // Before Settings has asked the server anything.
    expect(told).toBe(true)
    expect(wipesNoted(vi.mocked(logConnection))).toEqual(['sign-out'])
    expect(root.signedInUserId()).toBeNull()

    await settled()
    expect(backend.owner).toBeNull()
    expect(backend.rows.size).toBe(0)
  })

  test('and the full load that follows every sign-in and sign-out wipes it too', async () => {
    const backend = await keptFor('u1')
    const { root, logConnection } = await freshPage(backend)
    const deleted: Array<string> = []
    vi.stubGlobal('caches', {
      delete: (name: string) => {
        deleted.push(name)
        return Promise.resolve(true)
      },
    })

    await root.forgetCachedPages()

    expect(backend.wipes).toBe(1)
    expect(wipesNoted(vi.mocked(logConnection))).toEqual(['person-change'])
    expect(deleted).toContain('pages')
  })

  test('even where the browser has no caches at all', async () => {
    const backend = await keptFor('u1')
    const { root } = await freshPage(backend)
    await root.forgetCachedPages()
    expect(backend.wipes).toBe(1)
  })

  test('the full load waits at most 2 s on a wipe that never answers', async () => {
    const backend = await keptFor('u1')
    // WebKit's IndexedDB can leave an open unanswered for good.
    backend.wipe = () => new Promise<void>(() => {})
    const { root, store } = await freshPage(backend)
    let told = false
    store.onKeptWiped(() => {
      told = true
    })
    vi.useFakeTimers()
    try {
      let done = false
      void root.forgetCachedPages().then(() => {
        done = true
      })
      // The copy in memory went at once, all the same.
      expect(told).toBe(true)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a sign-out that failed, or did not answer in time', () => {
  test('gets around on the cached sign-in again, but keeps nothing for them', async () => {
    const backend = await keptFor('u1')
    const { root, getInitialState } = await freshPage(backend)
    const token = jwtFor('u1')
    root.seedRootState({ token, theme: 'system' })

    root.beginSignOut()
    expect(root.hasRootState()).toBe(false)
    root.signOutFailed()

    // So a tap answers from here, with no signal too, and SessionWatch
    // watches again for the session ending.
    expect(root.signedInToken()).toBe(token)
    expect(root.hasRootState()).toBe(true)
    expect((await root.resolveRootState()).token).toBe(token)
    expect(getInitialState).not.toHaveBeenCalled()
    // Nothing is kept on the phone for the rest of this page load.
    expect(root.signedInUserId()).toBeNull()
  })

  test('takes a fresh answer again, which it never does while the sign-out is on its way', async () => {
    const backend = await keptFor('u1')
    const { root, getInitialState } = await freshPage(backend)
    root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    getInitialState.mockResolvedValue({
      token: jwtFor('u1'),
      theme: 'system',
    })

    root.beginSignOut()
    await root.resolveRootState()
    expect(root.hasRootState()).toBe(false)

    root.signOutFailed()
    root.forgetRootState()
    await root.resolveRootState()
    expect(root.hasRootState()).toBe(true)
    expect(root.signedInUserId()).toBeNull()
  })
})

describe('a session that ended under an open page', () => {
  test('drops the cached sign-in, the pages, their licences and the kept copy', async () => {
    const backend = await keptFor('u1')
    const { root, logConnection } = await freshPage(backend)
    root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    const deleted: Array<string> = []
    vi.stubGlobal('caches', {
      delete: (name: string) => {
        deleted.push(name)
        return Promise.resolve(true)
      },
    })

    root.forgetEndedSession()
    await settled()

    expect(root.hasRootState()).toBe(false)
    // The person's pages hold their schedule and token, and `/` would
    // still open them with no signal.
    expect(deleted).toContain('pages')
    expect(deleted).toContain('pestm8-kept-licence-v2')
    expect(wipesNoted(vi.mocked(logConnection))).toEqual(['session-ended'])
    expect(backend.wipes).toBe(1)
  })
})

describe('a page load', () => {
  test.each([
    ['the person who kept it', 'u1', 0],
    ['someone else', 'u2', 1],
    ['nobody', null, 1],
  ] as const)('signed in as %s (%s): %i wipes', async (_who, userId, wipes) => {
    const backend = await keptFor('u1')
    const { root, store } = await freshPage(backend)

    root.seedRootState({
      token: userId === null ? undefined : jwtFor(userId),
      theme: 'system',
    })
    await store.peekKept()
    await settled()

    expect(backend.wipes).toBe(wipes)
  })

  test('signing in on the join page, with no load between, wipes the last person’s', async () => {
    const backend = await keptFor('u1')
    const { root, store, getInitialState } = await freshPage(backend)
    // The join page loaded signed in as u1, who then signs in again as u2.
    root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    root.forgetRootState()
    getInitialState.mockResolvedValueOnce({
      token: jwtFor('u2'),
      theme: 'system',
    })

    await root.resolveRootState()
    await store.peekKept()
    await settled()

    expect(root.signedInUserId()).toBe('u2')
    expect(backend.wipes).toBe(1)
  })

  test('with the kill switch off, wipes the copy even for the person who kept it', async () => {
    const backend = await keptFor('u1')
    vi.doMock('./offline/keptSet', async (original) => ({
      ...(await original<typeof KeptSet>()),
      KEPT_ENABLED: false,
    }))
    try {
      const { root } = await freshPage(backend)
      root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
      await settled()
      expect(backend.wipes).toBe(1)
    } finally {
      vi.doUnmock('./offline/keptSet')
    }
  })
})

/**
 * The bookings kept on the phone and not sent yet (lib/outbox/) are cleared
 * on different terms from the kept copy: nobody can type them in again. A
 * sign-out discards them the moment it begins, by a tombstone that holds
 * whatever the wipe does; someone else's sign-in drops them; nothing else
 * does, not a sign-in's full load, not nobody being signed in, and not a
 * session that ended elsewhere, which only marks them.
 */
describe('the bookings kept on the phone, not sent yet', () => {
  /** Every queued operation, and the ones they queue, have run. */
  const allSettled = async () => {
    for (let i = 0; i < 6; i++) await settled()
  }

  test('signing out discards them before it returns, and wipes them', async () => {
    const item = itemFor('u1', {}, Date.now() - 1_000)
    const outbox = await outboxOf('u1', [item])
    const { root, outboxStore } = await freshPage(await keptFor('u1'), outbox)
    root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()

    root.beginSignOut()
    // Before Settings has asked the server anything, and before IndexedDB
    // has answered.
    expect(outboxStore.tombstoned(item)).toBe(true)
    expect(await outboxStore.peekOutbox()).toEqual({ owner: null, items: [] })

    await allSettled()
    expect(outbox.owner).toBeNull()
    expect(outbox.items.size).toBe(0)
  })

  test('a wipe lost before the reload, and the same person signs in again: neither shown nor sent, and the next load deletes them', async () => {
    const item = itemFor('u1', {}, Date.now() - 1_000)
    const outbox = await outboxOf('u1', [item])
    const epoch = outbox.owner?.epoch ?? ''
    const first = await freshPage(await keptFor('u1'), outbox)
    first.root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()

    // WebKit's IndexedDB never answers the wipe, and the page reloads.
    outbox.hung = true
    first.root.beginSignOut()
    outbox.hung = false
    expect(outbox.items.size).toBe(1)

    const next = await freshPage(await keptFor('u1'), outbox)
    // Not shown…
    expect(await next.outboxStore.peekOutbox()).toMatchObject({ items: [] })
    // …nor sent, whichever tab tries…
    expect(
      await outbox.update(epoch, item.localId, beginSendChange(Date.now())),
    ).toBe('refused')
    // …and gone, once the page load knows who is signed in.
    next.root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()
    expect(outbox.items.size).toBe(0)
    expect(localStorage.getItem('pestm8-outbox-discarded')).toBeNull()
  })

  test('a sign-in’s full load leaves them be', async () => {
    const outbox = await outboxOf('u1', [itemFor('u1')])
    const { root } = await freshPage(await keptFor('u1'), outbox)
    vi.stubGlobal('caches', { delete: () => Promise.resolve(true) })

    await root.forgetCachedPages()
    await allSettled()
    expect(outbox.wipes).toBe(0)
    expect(outbox.items.size).toBe(1)
  })

  test('a sign-out’s full load waits for their wipe, at most 2 s', async () => {
    const outbox = await outboxOf('u1', [itemFor('u1')])
    outbox.wipe = () => new Promise<number>(() => {})
    const { root } = await freshPage(await keptFor('u1'), outbox)
    root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()
    vi.useFakeTimers()

    root.beginSignOut()
    let done = false
    void root.forgetCachedPages().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  test('and goes on as soon as the wipe has landed', async () => {
    const outbox = await outboxOf('u1', [itemFor('u1')])
    let land = () => {}
    const wipe = outbox.wipe.bind(outbox)
    outbox.wipe = () =>
      new Promise<number | 'error'>((resolve) => {
        land = () => resolve(wipe())
      })
    const { root } = await freshPage(await keptFor('u1'), outbox)
    root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()

    root.beginSignOut()
    let done = false
    void root.forgetCachedPages().then(() => {
      done = true
    })
    await allSettled()
    expect(done).toBe(false)
    land()
    await allSettled()
    expect(done).toBe(true)
    expect(outbox.items.size).toBe(0)
  })

  test('a page load with nobody signed in deletes only what a sign-out discarded', async () => {
    const discarded = itemFor('u1', {}, 1_000)
    const kept = itemFor('u1', {}, 3_000)
    const outbox = await outboxOf('u1', [discarded, kept])
    localStorage.setItem(
      'pestm8-outbox-discarded',
      JSON.stringify([{ userId: 'u1', at: 2_000 }]),
    )
    const { root } = await freshPage(await keptFor('u1'), outbox)

    root.seedRootState({ token: undefined, theme: 'system' })
    await allSettled()
    expect([...outbox.items.keys()]).toEqual([kept.localId])
    expect(outbox.owner?.userId).toBe('u1')
    expect(outbox.done).not.toContain('claim')
  })

  test('someone else’s page load drops the last person’s', async () => {
    const outbox = await outboxOf('u1', [itemFor('u1')])
    const { root } = await freshPage(await keptFor('u1'), outbox)
    root.seedRootState({ token: jwtFor('u2', 'Sam Lee'), theme: 'system' })
    await allSettled()
    expect(outbox.items.size).toBe(0)
    expect(outbox.owner).toMatchObject({ userId: 'u2', firstName: 'Sam' })
  })

  test('so does someone else signing in on the join page, with no load between', async () => {
    const outbox = await outboxOf('u1', [itemFor('u1')])
    const { root, getInitialState } = await freshPage(
      await keptFor('u1'),
      outbox,
    )
    root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()
    expect(outbox.items.size).toBe(1)

    root.forgetRootState()
    getInitialState.mockResolvedValueOnce({
      token: jwtFor('u2'),
      theme: 'system',
    })
    await root.resolveRootState()
    await allSettled()
    expect(outbox.items.size).toBe(0)
    expect(outbox.owner?.userId).toBe('u2')
  })

  test('the same person’s page load keeps them, with the first name the sign-in screens will need', async () => {
    const item = itemFor('u1')
    const outbox = await outboxOf('u1', [item], '')
    const { root, outboxStore } = await freshPage(await keptFor('u1'), outbox)
    root.seedRootState({ token: jwtFor('u1', 'Kevin Tran'), theme: 'system' })
    await allSettled()
    expect([...outbox.items.keys()]).toEqual([item.localId])
    expect(outbox.owner).toMatchObject({ userId: 'u1', firstName: 'Kevin' })
    expect(outboxStore.outboxEpoch()).toBe(outbox.owner?.epoch)
  })

  test('a session that ended elsewhere keeps them, marked, so none goes before the person says so', async () => {
    const item = itemFor('u1')
    const outbox = await outboxOf('u1', [item])
    const { root } = await freshPage(await keptFor('u1'), outbox)
    root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()

    root.forgetEndedSession()
    await allSettled()
    expect(outbox.wipes).toBe(0)
    expect(outbox.items.get(item.localId)?.sessionEndedAt).toEqual(
      expect.any(Number),
    )
  })

  test('so does one that ended while PestM8 was closed: the same person signs back in, in a new session', async () => {
    const item = itemFor('u1', {}, Date.now() - 3_600_000)
    const outbox = await outboxOf('u1', [item])
    // The password changed on a laptop overnight: the morning's cold open
    // is the server's, signed out, so SessionWatch never sees it end.
    const cold = await freshPage(await keptFor('u1'), outbox)
    cold.root.seedRootState({ token: undefined, theme: 'system' })
    await allSettled()
    expect(outbox.items.get(item.localId)?.sessionEndedAt).toBeNull()

    // Signed in again (login.tsx reloads).
    const next = await freshPage(await keptFor('u1'), outbox)
    next.root.seedRootState({
      token: jwtFor('u1', 'Kevin Tran', 'session-2'),
      theme: 'system',
    })
    await allSettled()
    const after = outbox.items.get(item.localId)
    expect(after?.sessionEndedAt).toEqual(expect.any(Number))
    expect(after && isStale(after, Date.now())).toBe(true)
    expect(outbox.owner?.sessionId).toBe('session-2')
  })

  test('the same session’s next page load marks nothing', async () => {
    const item = itemFor('u1')
    const outbox = await outboxOf('u1', [item])
    const { root } = await freshPage(await keptFor('u1'), outbox)
    root.seedRootState({
      token: jwtFor('u1', 'Kevin Tran', SESSION),
      theme: 'system',
    })
    await allSettled()
    expect(outbox.items.get(item.localId)?.sessionEndedAt).toBeNull()
  })

  test('a claim that fails at the page load is made once storage answers, with no new sign-in', async () => {
    // Saved just now: one three days unsent never goes by itself.
    const outbox = await outboxOf('u1', [itemFor('u1', {}, Date.now())])
    const page = await freshPage(await keptFor('u1'), outbox)
    vi.useFakeTimers()
    outbox.unavailable = true
    page.root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await vi.advanceTimersByTimeAsync(10)
    expect(page.outboxStore.outboxEpoch()).toBeNull()

    outbox.unavailable = false
    // The person goes on navigating: nothing asks who is signed in again.
    await page.root.resolveRootState()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.outboxStore.outboxEpoch()).toBe(outbox.owner?.epoch)
    const [item] = [...outbox.items.values()]
    expect(
      await page.outboxStore.changeOutboxItem(
        'beginSend',
        item.localId,
        beginSendChange(Date.now()),
      ),
    ).toMatchObject({ state: 'sending' })
  })
})

/**
 * Every tab open on the phone shares the outbox, each with its own read
 * and claim: what one tab's sign-out discards stays discarded in the
 * others, and a tab that outlives it claims again once the person is back.
 */
describe('the bookings kept on the phone, across tabs', () => {
  const allSettled = async () => {
    for (let i = 0; i < 8; i++) await settled()
  }

  /** A page load that has read the outbox, signed in as `userId`. */
  async function tabFor(outbox: MemoryOutboxBackend, userId: string) {
    const tab = await freshPage(await keptFor(userId), outbox)
    tab.root.seedRootState({ token: jwtFor(userId), theme: 'system' })
    await allSettled()
    await tab.outboxStore.peekOutbox()
    return tab
  }

  test('another tab’s sign-out: never shown here again, once its wipe lands and its tombstone goes', async () => {
    const item = itemFor('u1', {}, Date.now() - 1_000)
    const outbox = await outboxOf('u1', [item])
    const tabB = await tabFor(outbox, 'u1')
    expect(await tabB.outboxStore.peekOutbox()).toMatchObject({
      items: [{ localId: item.localId }],
    })

    const tabA = await tabFor(outbox, 'u1')
    // Its wipe lands only after tab B has read the outbox again.
    let land = () => {}
    const wipe = outbox.wipe.bind(outbox)
    outbox.wipe = () =>
      new Promise<number | 'error'>((resolve) => {
        land = () => resolve(wipe())
      })
    tabA.root.beginSignOut()
    expect(await tabB.outboxStore.peekOutbox()).toMatchObject({ items: [] })
    land()
    await allSettled()
    expect(outbox.items.size).toBe(0)
    expect(localStorage.getItem('pestm8-outbox-discarded')).toBeNull()
    expect(await tabB.outboxStore.peekOutbox()).toMatchObject({ items: [] })
  })

  test('a wipe that never landed, finished by another page load’s sweep: still never shown here', async () => {
    const item = itemFor('u1', {}, Date.now() - 1_000)
    const outbox = await outboxOf('u1', [item])
    const tabB = await tabFor(outbox, 'u1')
    const tabA = await tabFor(outbox, 'u1')
    outbox.hung = true
    tabA.root.beginSignOut()
    outbox.hung = false
    // Tab B reads again while the tombstone covers it…
    expect(await tabB.outboxStore.peekOutbox()).toMatchObject({ items: [] })
    // …then the next page load deletes it, and lets the tombstone go.
    const next = await freshPage(await keptFor('u1'), outbox)
    next.root.seedRootState({ token: undefined, theme: 'system' })
    await allSettled()
    expect(outbox.items.size).toBe(0)
    expect(localStorage.getItem('pestm8-outbox-discarded')).toBeNull()
    expect(await tabB.outboxStore.peekOutbox()).toMatchObject({ items: [] })
  })

  test('someone else’s sign-in in another tab: the last person’s are never shown here again', async () => {
    const outbox = await outboxOf('u1', [itemFor('u1')])
    const tabB = await tabFor(outbox, 'u1')
    await tabFor(outbox, 'u2')
    expect(outbox.items.size).toBe(0)
    // Tab B hasn't noticed the person change yet.
    expect(await tabB.outboxStore.peekOutbox()).toMatchObject({ items: [] })
  })

  test('another tab’s sign-out ends this one’s claim; once the person is back, it claims again', async () => {
    const outbox = await outboxOf('u1')
    const tabB = await freshPage(await keptFor('u1'), outbox)
    tabB.root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()
    expect(tabB.outboxStore.outboxEpoch()).toBe(outbox.owner?.epoch)

    const tabA = await freshPage(await keptFor('u1'), outbox)
    tabA.root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()
    tabA.root.beginSignOut()
    await allSettled()
    // Tab B hasn't noticed yet: it keeps nothing for someone who left.
    expect(await tabB.outboxStore.keepOutboxItem(itemFor('u1'))).toBe('refused')

    // The same person signs in again in a tab of its own (a full load)…
    const tabC = await freshPage(await keptFor('u1'), outbox)
    tabC.root.seedRootState({ token: jwtFor('u1'), theme: 'system' })
    await allSettled()
    // …and tab B, told the session ended, asks who is signed in now.
    tabB.root.forgetRootState()
    tabB.getInitialState.mockResolvedValueOnce({
      token: jwtFor('u1'),
      theme: 'system',
    })
    await tabB.root.resolveRootState()
    await allSettled()
    expect(tabB.outboxStore.outboxEpoch()).toBe(outbox.owner?.epoch)
    expect(
      await tabB.outboxStore.keepOutboxItem(itemFor('u1', {}, Date.now())),
    ).toBe('kept')
  })
})
