import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserRefreshRetry,
  readSessionAnswer,
  retryDelayMs,
} from './tokenRefresh'

describe('readSessionAnswer', () => {
  it('is signed out only when the server said so', () => {
    expect(readSessionAnswer({ data: null, error: null })).toBe('signedOut')
    expect(readSessionAnswer({ data: null, error: { status: 401 } })).toBe(
      'signedOut',
    )
  })

  it('is signed in with a session', () => {
    const session = { session: { id: 's' }, user: { id: 'u' } }
    expect(readSessionAnswer({ data: session, error: null })).toBe('signedIn')
  })

  it('does not know when the request failed', () => {
    for (const status of [500, 502, 503, 429, 0]) {
      expect(readSessionAnswer({ data: null, error: { status } })).toBe(
        'unknown',
      )
    }
  })
})

describe('retryDelayMs', () => {
  it('doubles from a second, and settles at every 30 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(retryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ])
  })
})

describe('browserRefreshRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function page({ onLine }: { onLine: boolean }) {
    const window = new EventTarget()
    const document = Object.assign(new EventTarget(), {
      visibilityState: 'hidden',
    })
    vi.stubGlobal('navigator', { onLine })
    vi.stubGlobal('window', window)
    vi.stubGlobal('document', document)
    return { window, document }
  }

  it('does not ask Better Auth with no network at all', async () => {
    page({ onLine: false })
    const getSession = vi.fn()
    const retry = browserRefreshRetry(getSession)

    expect(await retry.askSession()).toBe('unknown')
    expect(getSession).not.toHaveBeenCalled()
  })

  it('does not know when asking Better Auth fails', async () => {
    page({ onLine: true })
    const retry = browserRefreshRetry(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    )

    // withRefreshRetry reads a rejection as "unknown".
    await expect(retry.askSession()).rejects.toThrow('Failed to fetch')
  })

  it('reads the session Better Auth answers with', async () => {
    page({ onLine: true })
    const retry = browserRefreshRetry(async () => ({ data: null, error: null }))

    expect(await retry.askSession()).toBe('signedOut')
  })

  it('waits out its delay', async () => {
    vi.useFakeTimers()
    page({ onLine: false })
    let over = false
    void browserRefreshRetry(vi.fn())
      .pause(2)
      .then(() => (over = true))

    await vi.advanceTimersByTimeAsync(3_999)
    expect(over).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(over).toBe(true)
  })

  it('stops waiting when the network comes back', async () => {
    vi.useFakeTimers()
    const { window } = page({ onLine: false })
    let over = false
    void browserRefreshRetry(vi.fn())
      .pause(5)
      .then(() => (over = true))

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(over).toBe(true)
  })

  it('stops waiting when the page is looked at again', async () => {
    vi.useFakeTimers()
    const { document } = page({ onLine: false })
    let over = false
    void browserRefreshRetry(vi.fn())
      .pause(5)
      .then(() => (over = true))

    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(over).toBe(false)

    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(over).toBe(true)
  })
})
