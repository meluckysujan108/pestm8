import { createContext, useContext } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'
import type { ReactNode } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import type { Capability } from '../../convex/lib/capabilities'

/**
 * What the caller may do, live.
 *
 * Every gate in the app reads this, and it must not be read from route
 * context. `$businessSlug/route.tsx` resolves the membership once in
 * `beforeLoad`, and that snapshot cannot follow a switch: `ensureQueryData`
 * returns the cache rather than refetching (`convexQuery` sets
 * `staleTime: Infinity`), and `businesses.getBySlug` resolves through the
 * legacy `requireMembership`, which never reads `accountSwitches` — so Convex
 * has no reason to re-push it either. `router.invalidate()` does re-run
 * `beforeLoad`, and would hand back a byte-identical snapshot.
 *
 * `api.access.me` resolves through `requireActor`, which does read that row.
 * So the socket re-pushes this the instant a switch starts or stops, and every
 * gate follows without anyone remembering to refresh anything. That is why an
 * owner's administration UI disappears the moment they step into someone
 * else's account — the server stopped honouring it at the same instant.
 */
export type Access = {
  membershipId: Id<'memberships'>
  role: 'owner' | 'contractor' | 'subcontractor'
  caps: Record<Capability, boolean>
  actingAs: { membershipId: Id<'memberships'>; name: string } | null
  expiresAt: number | null
  degraded: string | null
  viewingAs: { membershipId: Id<'memberships'>; name: string } | null
  /**
   * The owner's view dropdown: which of his views is showing, or null for
   * anyone who does not get one. Optional because this build can meet a
   * backend from before the field existed (CLAUDE.md: the two deploy
   * separately) — and absent must read exactly like null, so nothing renders.
   */
  view?: { mode: ViewMode } | null
}

/** God view, just my jobs, or working in someone else's account. */
export type ViewMode = 'everyone' | 'mine' | 'account'

const AccessContext = createContext<Access | null>(null)

export function AccessProvider({
  businessId,
  children,
}: {
  businessId: Id<'businesses'>
  children: ReactNode
}) {
  const { data } = useSuspenseQuery(convexQuery(api.access.me, { businessId }))
  return <AccessContext value={data}>{children}</AccessContext>
}

export function useAccess(): Access {
  const value = useContext(AccessContext)
  if (!value) throw new Error('useAccess outside AccessProvider')
  return value
}

/**
 * The only way the UI should ask whether something is allowed.
 *
 * A `role === 'owner'` comparison cannot express "an owner, but currently
 * working inside someone else's account" — and that is exactly the state where
 * showing the button would be wrong, because the server has already stopped
 * accepting it. Twenty-one of those comparisons were the reason the report
 * templates screen rendered an "Owners only" wall over data the server handed
 * to any member.
 */
export function useCan(capability: Capability): boolean {
  return useAccess().caps[capability]
}

/**
 * The account being worked in — whose jobs these are, and whose name goes on
 * what is written. The same as the real person unless a switch is open.
 */
export function useActing(): {
  membershipId: Id<'memberships'>
  name: string | null
  isSwitched: boolean
} {
  const access = useAccess()
  return {
    membershipId: access.actingAs?.membershipId ?? access.membershipId,
    name: access.actingAs?.name ?? null,
    isSwitched: access.actingAs !== null,
  }
}

/**
 * Which of the owner's views is showing — null for everyone who has no
 * dropdown. Screens that simplify in "Just my jobs" read this and nothing
 * else, so there is one answer to "is he in his own view" across the app.
 */
export function useViewMode(): ViewMode | null {
  return useAccess().view?.mode ?? null
}
