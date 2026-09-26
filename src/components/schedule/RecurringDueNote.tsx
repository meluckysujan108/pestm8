import { Link } from '@tanstack/react-router'
import { Repeat } from 'lucide-react'

/**
 * On a day still ahead: how many projected visits fall on it (Phase 4.4).
 *
 * They are not on the day's list — a projection stays off the schedule until
 * its day arrives — and not in its job count, since nobody has agreed to them.
 * But a day that looks clear is one somebody books into, so it says there
 * are visits expected, and where to see them.
 */
export function RecurringDueNote({
  count,
  businessSlug,
}: {
  count: number
  businessSlug: string
}) {
  if (count <= 0) return null
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-ink-2">
      <Repeat size={12} strokeWidth={2.4} aria-hidden />
      {count} recurring {count === 1 ? 'visit' : 'visits'} on this day, not
      booked yet ·
      <Link
        to="/$businessSlug/job/recurring"
        params={{ businessSlug }}
        className="font-semibold text-blue"
      >
        Recurring Jobs
      </Link>
    </p>
  )
}
