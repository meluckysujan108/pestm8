import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
  RETRY_DELAYS_MS,
  RETRY_WINDOW_MS,
  createRetryBudget,
  forgetRefusedQueries,
  isUnauthenticatedError,
} from './signInSettling'
import { MFA_ENROLMENT_REQUIRED } from './twoStep'

describe('which errors are a sign-in still settling', () => {
  test('the refusal requireAuthUser and getAuthUser throw', () => {
    expect(isUnauthenticatedError(new ConvexError('Unauthenticated'))).toBe(
      true,
    )
  })

  test('the same refusal with only its message left', () => {
    const error = new Error(
      '[CONVEX Q(reports:list)] [Request ID: 1a2b] Server Error\nUncaught ConvexError: Unauthenticated\n  Called by client',
    )
    expect(isUnauthenticatedError(error)).toBe(true)
  })

  test('not any other refusal, which keeps the screen it had', () => {
    for (const other of [
      new ConvexError(MFA_ENROLMENT_REQUIRED),
      new ConvexError('NO_ACCESS'),
      new ConvexError({ code: 'NOT_FOUND' }),
      new Error('Unauthenticated users cannot do that'),
      new Error('Something else broke'),
      'Unauthenticated',
      null,
      undefined,
    ]) {
      expect(isUnauthenticatedError(other)).toBe(false)
    }
  })
})

describe('how many times a refused page is retried', () => {
  test('at once, then after a pause, then a longer one, then no more', () => {
    const budget = createRetryBudget()
    let now = 1_000
    const delays: Array<number | null> = []
    for (let i = 0; i < 4; i++) {
      const delay = budget.next(now)
      delays.push(delay)
      if (delay === null) break
      // The retry goes, and the page is refused again a round trip later.
      now += delay
      budget.spend(now)
      now += 500
    }
    expect(delays).toEqual([...RETRY_DELAYS_MS, null])
  })

  test('however slowly each refusal comes back, three a minute is the limit', () => {
    // A slow server: every retried page takes 15 s to be refused again.
    const budget = createRetryBudget()
    let now = 0
    for (const delay of RETRY_DELAYS_MS) {
      expect(budget.next(now)).toBe(delay)
      budget.spend(now)
      now += 15_000
    }
    expect(budget.next(now)).toBeNull()
  })

  test('comes back as the retries age out of the last minute', () => {
    const budget = createRetryBudget()
    for (const at of [0, 1_000, 4_000]) budget.spend(at)
    expect(budget.next(5_000)).toBeNull()
    expect(budget.next(RETRY_WINDOW_MS)).toBe(RETRY_DELAYS_MS[2])
    expect(budget.next(RETRY_WINDOW_MS + 4_000)).toBe(RETRY_DELAYS_MS[0])
  })

  test('asking again without retrying spends nothing', () => {
    // Each re-render of the held page asks; only a retry that went counts.
    const budget = createRetryBudget()
    expect(budget.next(0)).toBe(RETRY_DELAYS_MS[0])
    expect(budget.next(10)).toBe(RETRY_DELAYS_MS[0])
  })
})

describe('what a retry clears from the cache first', () => {
  const refused = new ConvexError('Unauthenticated')

  function cacheWith() {
    const client = new QueryClient()
    const fail = (key: string, error: Error) =>
      client
        .getQueryCache()
        .build(client, { queryKey: [key] })
        .setState({ status: 'error', error, data: undefined })
    return { client, fail }
  }

  const has = (client: QueryClient, key: string) =>
    client.getQueryCache().find({ queryKey: [key] }) !== undefined

  test('a query refused before it had any data, which could never recover', () => {
    const { client, fail } = cacheWith()
    fail('never-answered', refused)
    forgetRefusedQueries(client)
    expect(has(client, 'never-answered')).toBe(false)
  })

  test('not one that has data: the next answer pushed to it heals it', () => {
    const { client } = cacheWith()
    client.setQueryData(['answered'], { rows: 3 })
    client
      .getQueryCache()
      .find({ queryKey: ['answered'] })!
      .setState({ status: 'error', error: refused })
    forgetRefusedQueries(client)
    expect(client.getQueryData(['answered'])).toEqual({ rows: 3 })
  })

  test('not one something on screen is watching', () => {
    const { client, fail } = cacheWith()
    fail('watched', refused)
    const observer = new QueryObserver(client, {
      queryKey: ['watched'],
      enabled: false,
    })
    const stop = observer.subscribe(() => {})
    forgetRefusedQueries(client)
    expect(has(client, 'watched')).toBe(true)
    stop()
  })

  test('not any other failure, which keeps its error', () => {
    const { client, fail } = cacheWith()
    fail('no-access', new ConvexError('NO_ACCESS'))
    forgetRefusedQueries(client)
    expect(has(client, 'no-access')).toBe(true)
  })
})
