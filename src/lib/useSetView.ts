import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'
import { duringSwitchStart } from './outbox/switchGate'
import type { Locks } from './outbox/outboxLocks'
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
    mutationFn: (view: ViewChoice) => chooseView(convexSet, businessId, view),
  })
}

/**
 * `views.set` for `view`. Someone's account, from the View menu, opens a
 * switch just as Settings' switch does, so no booking kept on the phone goes
 * while it starts, from this tab or another (lib/outbox/switchGate.ts): a
 * switch belongs to the sign-in session every tab shares, and would apply to
 * a send already queued. Everyone and Just my jobs only close one, back to
 * the person's own account, which every send waits for anyway.
 */
export function chooseView<T>(
  set: (args: { businessId: Id<'businesses'>; view: ViewChoice }) => Promise<T>,
  businessId: Id<'businesses'>,
  view: ViewChoice,
  locks?: Locks | null,
): Promise<T> {
  const call = () => set({ businessId, view })
  return view.kind === 'account' ? duringSwitchStart(call, locks) : call()
}
