import { EmptyState } from '#/components/primitives/EmptyState'
import { useActing } from '#/lib/access'

/**
 * What the Team pages show someone who opens them by their address without
 * `team.manage` — a subcontractor, or an owner working inside someone else's
 * account, whom the server has stopped taking team changes from. Read-only,
 * not a broken page: the header's back link is the way out.
 */
export function TeamOwnerOnly() {
  const { isSwitched } = useActing()
  return (
    <EmptyState
      title="Only the business owner can change these."
      body={
        isSwitched
          ? 'Switch back to your own account to manage the team.'
          : undefined
      }
    />
  )
}
