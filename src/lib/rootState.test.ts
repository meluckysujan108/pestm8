import { afterEach, describe, expect, test, vi } from 'vitest'
import { keptFor } from './offline/keptStore.fixtures'
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

function jwtFor(sub: string): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${part({ alg: 'EdDSA' })}.${part({ sub, iat: 1 })}.signature`
}

/** Every operation queued so far has run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A new page load: this module and the kept copy's, afresh. */
async function freshPage(backend: MemoryKeptBackend) {
  vi.resetModules()
  const store = await import('./offline/keptStore')
  store.setKeptBackendForTests(backend)
  const root = await import('./rootState')
  const { getInitialState } = await import('#/lib/initialState')
  const { logConnection } = await import('#/lib/connectionLog')
  vi.mocked(logConnection).mockClear()
  return {
    root,
    store,
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

afterEach(() => {
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
