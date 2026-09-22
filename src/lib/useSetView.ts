import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

export type ViewChoice =
  | { kind: 'everyone' }
  | { kind: 'mine' }
  | { kind: 'account'; membershipId: Id<'memberships'> }

/**
 * Choose a view, as one server transaction (`views.set`).
 *
 * Nothing to invalidate afterwards: every list reads its scope through
 * `requireActor`, which reads the rows this writes, so the whole app re-pushes
 * into the new view by itself — the same way a switch does.
 */
export function useSetView(businessId: Id<'businesses'>) {
  const convexSet = useConvexMutation(api.views.set)
  return useMutation({
    mutationFn: (view: ViewChoice) => convexSet({ businessId, view }),
  })
}
