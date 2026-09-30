import { useAccess, useViewMode } from '#/lib/access'
import { personLabel } from '#/lib/assignees'
import type { Role } from '../../../convex/lib/capabilities'

/**
 * Said before the job disappears, not after.
 *
 * In "Just my jobs" the schedule shows only the owner's own work, so booking
 * his subcontractor's next visit from there puts the job somewhere he is not
 * looking — and it vanishes from the screen the instant he saves. Nothing is
 * wrong, and without this it would look as though something was.
 *
 * Only in "Just my jobs". Inside someone's account, what that account shows
 * depends on what they may see — a contractor sees their team — so "it won't
 * show" would sometimes be false, and a note that is sometimes wrong teaches
 * people to ignore it.
 */
export function OffViewNote({
  assignee,
  people,
  alsoGoing = [],
}: {
  assignee: string
  people: ReadonlyArray<{ _id: string; name: string; role: Role }>
  /** Everyone going beside the lead: someone also going still sees it. */
  alsoGoing?: ReadonlyArray<string>
}) {
  const mode = useViewMode()
  const access = useAccess()

  if (
    mode !== 'mine' ||
    assignee === '' ||
    assignee === access.membershipId ||
    alsoGoing.includes(access.membershipId)
  ) {
    return null
  }

  const person = people.find((p) => p._id === assignee)
  if (!person) return null

  return (
    <p className="text-caption text-muted">
      This goes on {personLabel(person)}’s schedule, so it won’t show in your
      current view.
    </p>
  )
}
