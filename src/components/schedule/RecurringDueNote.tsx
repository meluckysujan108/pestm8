import { Link } from '@tanstack/react-router'
import { Repeat } from 'lucide-react'

/**
 * On a day still ahead: how many projected visits fall on it (Phase 4.4).
 *
 * They are not on the day's list — a projection stays off the schedule until
 * its day arrives — and not in its job count, since nobody has agreed to them.
 * But a day that looks clear is one somebody books into, so it says there
 * are visits expected, and where to see them.
 *
 * `kept`: the day has arrived, but what is on screen is a copy the phone
 * kept from before it had, which has none of them on it. The week's count
 * says how many there are, and the visits themselves come with the signal.
 */
export function RecurringDueNote({
  count,
  businessSlug,
  kept = false,
}: {
  count: number
  businessSlug: string
  kept?: boolean
}) {
  if (count <= 0) return null
  const visits = `${count} recurring ${count === 1 ? 'visit' : 'visits'}`
  if (kept) {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-ink-2">
        <Repeat size={12} strokeWidth={2.4} aria-hidden />
        {visits} due — {count === 1 ? 'it shows' : 'they show'} when you have
        signal.
      </p>
    )
  }
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-ink-2">
      <Repeat size={12} strokeWidth={2.4} aria-hidden />
      {visits} on this day, not booked yet ·
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
