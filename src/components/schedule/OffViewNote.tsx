import { useAccess, useActing, useViewMode } from '#/lib/access'
import { personLabel } from '#/lib/assignees'
import type { Role } from '../../../convex/lib/capabilities'

/**
 * Said before the job disappears, not after.
 *
 * In "Just my jobs" the schedule shows only the owner's own work, so booking
 * his subcontractor's next visit from there puts the job somewhere he is not
 * looking — and it vanishes from the screen the instant he saves. Nothing is
 * wrong, and without this it would look as though something was. The same
 * goes for booking outside the account he is working in.
 */
export function OffViewNote({
  assignee,
  people,
}: {
  assignee: string
  people: ReadonlyArray<{ _id: string; name: string; role: Role }>
}) {
  const mode = useViewMode()
  const access = useAccess()
  const acting = useActing()

  const inView =
    mode === 'mine'
      ? access.membershipId
      : mode === 'account'
        ? acting.membershipId
        : null
  if (inView === null || assignee === '' || assignee === inView) return null

  const person = people.find((p) => p._id === assignee)
  if (!person) return null

  return (
    <p className="text-caption text-muted">
      This goes on {personLabel(person)}’s schedule, so it won’t show in your
      current view.
    </p>
  )
}
