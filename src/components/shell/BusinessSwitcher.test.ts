import { describe, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { rq } from '#/lib/routeQueries'
import { canSwitchWithoutSignal } from './BusinessSwitcher'
import type { Id } from '../../../convex/_generated/dataModel'

// The kept copy's keeper reads who is signed in (lib/rootState.ts), whose
// server function needs a deployment's address to load at all.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

/**
 * With the line down, a switch of business goes ahead only on what the
 * phone already holds: the business, its access and the business list, the
 * three answers `$businessSlug`'s guard waits on.
 */

const target = {
  slug: 'coastal',
  businessId: 'biz_coastal' as Id<'businesses'>,
}
const bySlug = convexQuery(api.businesses.getBySlug, { slug: 'coastal' })
const list = convexQuery(api.businesses.listForUser, {})

function holding(parts: {
  business?: unknown
  access?: boolean
  list?: boolean
}) {
  const queryClient = new QueryClient()
  if ('business' in parts) {
    queryClient.setQueryData(bySlug.queryKey, parts.business)
  }
  if (parts.access) {
    queryClient.setQueryData(rq.access(target.businessId).queryKey, {})
  }
  if (parts.list) queryClient.setQueryData(list.queryKey, [])
  return queryClient
}

describe('canSwitchWithoutSignal', () => {
  test('goes ahead with all three on the phone', () => {
    const queryClient = holding({ business: {}, access: true, list: true })
    expect(canSwitchWithoutSignal(queryClient, target)).toBe(true)
  })

  test('not without any one of them', () => {
    for (const parts of [
      { access: true, list: true },
      { business: {}, list: true },
      { business: {}, access: true },
    ]) {
      expect(canSwitchWithoutSignal(holding(parts), target)).toBe(false)
    }
  })

  test('not on a business answered as null, which the guard asks about again', () => {
    const queryClient = holding({ business: null, access: true, list: true })
    expect(canSwitchWithoutSignal(queryClient, target)).toBe(false)
  })

  test('not on another business’s answers', () => {
    const queryClient = holding({ business: {}, access: true, list: true })
    expect(
      canSwitchWithoutSignal(queryClient, {
        slug: 'inland',
        businessId: 'biz_inland' as Id<'businesses'>,
      }),
    ).toBe(false)
  })
})
