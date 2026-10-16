import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attemptLimitMs,
  browserRefreshRetry,
  readSessionAnswer,
  retryDelayMs,
  withRefreshRetry,
} from './tokenRefresh'
import type { RefreshRetry } from './tokenRefresh'

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

describe('attemptLimitMs', () => {
  it('gives each attempt longer, up to 30 seconds', () => {
    expect([0, 1, 2, 3, 10].map(attemptLimitMs)).toEqual([
      10_000, 20_000, 30_000, 30_000, 30_000,
    ])
  })
})

/** A request that never answers: one sent into a dead VPN tunnel. */
const never = () => new Promise<never>(() => {})

describe('withRefreshRetry', () => {
  /** A retry whose `bound` gives up on a request when the test says so. */
  function retrying(...answers: Array<'signedIn' | 'signedOut' | 'unknown'>) {
    const givingUp: Array<() => void> = []
    const retry: RefreshRetry = {
      askSession: async () => answers.shift() ?? 'signedIn',
      pause: async () => {},
      bound: (request, fallback) =>
        Promise.race([
          request,
          new Promise<typeof fallback>((resolve) =>
            givingUp.push(() => resolve(fallback)),
          ),
        ]),
    }
    return {
      retry,
      giveUp: () => givingUp.splice(0).forEach((stop) => stop()),
    }
  }

  it('gives up on a refresh that never answers, and fetches again', async () => {
    const { retry, giveUp } = retrying('signedIn')
    const fetchToken = vi
      .fn()
      .mockImplementationOnce(never)
      .mockResolvedValueOnce('fresh')
    const fetch = withRefreshRetry(fetchToken, retry, () => true)

    const token = fetch({ forceRefreshToken: true })
    await vi.waitFor(() => expect(fetchToken).toHaveBeenCalledTimes(1))
    giveUp()

    expect(await token).toBe('fresh')
    expect(fetchToken).toHaveBeenCalledTimes(2)
  })

  it('gives up on asking Better Auth when it never answers, and carries on', async () => {
    const givingUp: Array<() => void> = []
    const retry: RefreshRetry = {
      askSession: never,
      pause: async () => {},
      bound: (request, fallback) =>
        Promise.race([
          request,
          new Promise<typeof fallback>((resolve) =>
            givingUp.push(() => resolve(fallback)),
          ),
        ]),
    }
    const fetchToken = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('fresh')
    const fetch = withRefreshRetry(fetchToken, retry, () => true)

    const token = fetch({ forceRefreshToken: true })
    await vi.waitFor(() => expect(givingUp).toHaveLength(2))
    givingUp.splice(0).forEach((stop) => stop())

    expect(await token).toBe('fresh')
  })

  it('a forced refresh asked for while one is in flight waits for it', async () => {
    const { retry } = retrying()
    let answer!: (token: string) => void
    const fetchToken = vi.fn(
      () => new Promise<string>((resolve) => (answer = resolve)),
    )
    const fetch = withRefreshRetry(fetchToken, retry, () => true)

    const first = fetch({ forceRefreshToken: true })
    const second = fetch({ forceRefreshToken: true })
    await vi.waitFor(() => expect(fetchToken).toHaveBeenCalledTimes(1))
    answer('fresh')

    expect(await Promise.all([first, second])).toEqual(['fresh', 'fresh'])
    expect(fetchToken).toHaveBeenCalledTimes(1)
  })

  it('hands back null for a token the page holds whose request never answers', async () => {
    // The Convex client then asks again with a forced refresh, which retries.
    const { retry, giveUp } = retrying()
    const fetch = withRefreshRetry(vi.fn(never), retry, () => true)

    const token = fetch({ forceRefreshToken: false })
    await Promise.resolve()
    giveUp()

    expect(await token).toBeNull()
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

  it('gives a request until its limit, then the fallback', async () => {
    vi.useFakeTimers()
    page({ onLine: true })
    const retry = browserRefreshRetry(vi.fn())
    let settled: string | undefined
    void retry.bound!(never(), 'gave up', 1).then((value) => (settled = value))

    await vi.advanceTimersByTimeAsync(19_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe('gave up')
  })

  it('answers with the request when it lands in time', async () => {
    vi.useFakeTimers()
    page({ onLine: true })
    const retry = browserRefreshRetry(vi.fn())

    expect(await retry.bound!(Promise.resolve('token'), null, 0)).toBe('token')
    expect(await retry.bound!(Promise.reject(new Error('x')), null, 0)).toBe(
      null,
    )
  })

  it('gives up on a request in flight when the phone wakes, and goes again at once', async () => {
    vi.useFakeTimers()
    const { document } = page({ onLine: true })
    const retry = browserRefreshRetry(vi.fn())
    let settled: string | undefined
    void retry.bound!(never(), 'gave up', 0).then((value) => (settled = value))

    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe('gave up')

    // The pause after it is skipped…
    let over = false
    void retry.pause(5).then(() => (over = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(over).toBe(true)

    // …and only that one.
    over = false
    void retry.pause(0).then(() => (over = true))
    await vi.advanceTimersByTimeAsync(999)
    expect(over).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(over).toBe(true)
  })

  it('gives up on a request in flight when the network comes back', async () => {
    vi.useFakeTimers()
    const { window } = page({ onLine: true })
    const retry = browserRefreshRetry(vi.fn())
    let settled: string | undefined
    void retry.bound!(never(), 'gave up', 0).then((value) => (settled = value))

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe('gave up')
  })
})
