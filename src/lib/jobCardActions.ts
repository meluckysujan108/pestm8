import { dayKeyOf } from '../../convex/lib/dates'
import type { JobStatus } from '#/components/primitives/StatusPill'

/**
 * What a job card offers besides opening the job.
 *
 * - `visit` — committed work: Call, Text or Email the client, Map the address.
 * - `book` — a projected visit whose day has come: due today, or overdue and
 *   carried onto today's Schedule. Nobody has agreed to it, so there is
 *   nowhere to drive yet and no Map. What there is to do is reach the client
 *   and book it — by whichever channel they answer — so Call, Text and Email
 *   stay, each named "… to book", because contacting them about it as though
 *   it were already arranged would be wrong.
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

/** The buttons each of those means on the card. One place, so the rule and
 * the buttons cannot disagree. */
export function cardButtonsFor(actions: CardActions): {
  /** Call, Text and Email, each shown where the client has the detail. */
  contact: boolean
  map: boolean
  toBook: boolean
} {
  switch (actions) {
    case 'visit':
      return { contact: true, map: true, toBook: false }
    case 'book':
      return { contact: true, map: false, toBook: true }
    case 'none':
      return { contact: false, map: false, toBook: false }
  }
}

/**
 * A projected visit whose day has passed with nobody acting on it: what the
 * card's "Overdue since" marker, the day header's overdue count and the nav
 * badge all mean by overdue. One definition, so the header can no longer call
 * a visit due later today "overdue" while its card says nothing of the kind.
 */
export function isOverdueProjection(
  job: { status: JobStatus; scheduledAt: number },
  timezone: string,
  now: number,
): boolean {
  return (
    job.status === 'recurring' &&
    dayKeyOf(job.scheduledAt, timezone) < dayKeyOf(now, timezone)
  )
}
