import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { signOutWithin } from './signOutWithin'

/**
 * Settings' Sign out gives the request ten seconds, and says so when it
 * didn't land. A request given up on still goes, though, and one that lands
 * after has signed the person out all the same, so the page has to hear of
 * it to finish the sign-out.
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A request the test answers when it likes. */
function request() {
  let answer!: (result: { error: unknown }) => void
  let fail!: (cause: unknown) => void
  const promise = new Promise<{ error: unknown }>((resolve, reject) => {
    answer = resolve
    fail = reject
  })
  return { promise, answer, fail }
}

describe('a sign-out', () => {
  test('that the server ends in time is in time', async () => {
    const r = request()
    const result = signOutWithin(r.promise, 10_000)
    r.answer({ error: null })
    const { inTime, landed } = await result
    expect(inTime).toBe(true)
    await expect(landed).resolves.toBe(true)
  })

  test('that the server answers with an error never lands', async () => {
    const r = request()
    const result = signOutWithin(r.promise, 10_000)
    r.answer({ error: { status: 503 } })
    const { inTime, landed } = await result
    expect(inTime).toBe(false)
    await expect(landed).resolves.toBe(false)
  })

  test('that never got there never lands', async () => {
    const r = request()
    const result = signOutWithin(r.promise, 10_000)
    r.fail(new TypeError('Failed to fetch'))
    const { inTime, landed } = await result
    expect(inTime).toBe(false)
    await expect(landed).resolves.toBe(false)
  })

  test('given up on, that lands after, is still heard of', async () => {
    const r = request()
    const result = signOutWithin(r.promise, 10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    const { inTime, landed } = await result
    expect(inTime).toBe(false)

    r.answer({ error: null })
    await expect(landed).resolves.toBe(true)
  })
})
