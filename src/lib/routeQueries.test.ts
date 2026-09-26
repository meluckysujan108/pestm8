import { afterEach, describe, expect, test, vi } from 'vitest'
import { browserOnly, keptOutOfHtml, rq } from './routeQueries'
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
