import { dayKeyOf } from '../../convex/lib/dates'
import type { JobStatus } from '#/components/primitives/StatusPill'

/**
 * What a job card offers besides opening the job.
 *
 * - `visit` — committed work: Call the client, Map the address.
 * - `book` — a projected visit whose day has come: due today, or overdue and
 *   carried onto today's Schedule. Nobody has agreed to it, so there is
 *   nowhere to drive yet and no Map. What there is to do is ring the client
 *   and book it, so Call stays — labelled "Call to book", because ringing
 *   about it as though it were already arranged would be wrong.
 * - `none` — a projection whose day is still ahead (booking it is a job for
 *   nearer the time, and it is not on any schedule yet), or a cancelled job,
 *   which is not work anyone is going to.
 *
 * The status decides, not the surface a card sits on, so the same visit offers
 * the same thing on the Schedule and on the Job tab. The one surface that
 * overrides it is the Recurring Job view, which shows no actions at all
 * (`hideActions` on JobCard).
 */
export type CardActions = 'visit' | 'book' | 'none'

export function cardActionsFor(
  job: { status: JobStatus; scheduledAt: number },
  timezone: string,
  now: number,
): CardActions {
  if (job.status === 'cancelled') return 'none'
  if (job.status === 'recurring') {
    return dayKeyOf(job.scheduledAt, timezone) <= dayKeyOf(now, timezone)
      ? 'book'
      : 'none'
  }
  return 'visit'
}
