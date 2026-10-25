import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  browserOnly,
  joinWindowStart,
  keptOutOfHtml,
  loaderWaitMs,
  rq,
  settleInBrowser,
} from './routeQueries'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * A person's licences never go into a page's HTML, which the service worker
 * keeps and serves back offline as though it were current (routeQueries.ts
 * has the whole of why). Everything else still does, as it always has.
 */

const businessId = 'b1' as Id<'businesses'>
const membershipId = 'm1' as Id<'memberships'>

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('keptOutOfHtml', () => {
  test('a person’s licences stay out', () => {
    expect(
      keptOutOfHtml(rq.memberLicences(businessId, membershipId).queryKey),
    ).toBe(true)
  })

  test('everything else goes in', () => {
    for (const query of [
      rq.currentUser(),
      rq.access(businessId),
      rq.team(businessId),
      rq.products(businessId),
    ]) {
      expect(keptOutOfHtml(query.queryKey)).toBe(false)
    }
    expect(keptOutOfHtml(['memberLicences:list'])).toBe(false)
  })
})

describe('browserOnly', () => {
  test('warms nothing on the server', () => {
    vi.stubGlobal('window', undefined)
    expect(browserOnly(rq.memberLicences(businessId, membershipId))).toEqual([])
  })

  test('warms what it is given in the browser', () => {
    vi.stubGlobal('window', {})
    const query = rq.memberLicences(businessId, membershipId)
    expect(browserOnly(query)).toEqual([query])
  })
})

describe('the join notices’ window', () => {
  test('starts a fortnight back, at a UTC midnight', () => {
    expect(joinWindowStart(Date.UTC(2026, 9, 25, 23, 59))).toBe(
      Date.UTC(2026, 9, 11),
    )
    // 8am in Perth: the window moves on mid-morning.
    expect(joinWindowStart(Date.UTC(2026, 9, 26))).toBe(Date.UTC(2026, 9, 12))
  })

  test('asks with the window it is given', () => {
    expect(rq.teamJoins(businessId, 123).queryKey).toEqual([
      'convexQuery',
      'teamJoins:recent',
      { businessId, since: 123 },
    ])
  })

  test('or with the current one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 25, 3))
    expect(rq.teamJoins(businessId).queryKey).toEqual(
      rq.teamJoins(businessId, Date.UTC(2026, 9, 11)).queryKey,
    )
  })
})

/** Whether `promise` has settled once `ms` of fake time has passed. */
async function settledAfter(promise: Promise<void>, ms: number) {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  return settled
}

describe('settleInBrowser', () => {
  const never = () => new Promise<void>(() => {})
  const after = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))

  test('waits to the end on the server', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', undefined)
    const wait = settleInBrowser(100, after(20_000))
    expect(await settledAfter(wait, 19_999)).toBe(false)
    expect(await settledAfter(wait, 1)).toBe(true)
  })

  test('gives up after `ms` in the browser', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {})
    const wait = settleInBrowser(100, never())
    expect(await settledAfter(wait, 99)).toBe(false)
    expect(await settledAfter(wait, 1)).toBe(true)
  })

  test('and is done as soon as the work is', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {})
    const wait = settleInBrowser(8_000, after(50))
    expect(await settledAfter(wait, 50)).toBe(true)
  })
})

describe('loaderWaitMs', () => {
  test('no wait at all when the phone says it has no signal', () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(loaderWaitMs()).toBe(0)
  })

  test('a while otherwise: “online” can be one bar', () => {
    vi.stubGlobal('navigator', { onLine: true })
    expect(loaderWaitMs()).toBe(8_000)
  })
})
