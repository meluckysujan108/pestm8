/**
 * Which list the Job tab reads, and what it shows while it reads it.
 *
 * Kept free of React, like lib/signInSettling.ts: the Job tab's loader and
 * the Recurring Job view's read it before their chunks load, and what the
 * list shows in each state is worth testing without rendering a page.
 */

import { isUnauthenticatedError } from './signInSettling'
import { isMfaEnrolmentError } from './twoStep'

/**
 * Where the Job tab's jobs come from.
 *
 * - `paged`: the whole business, a page at a time (`jobs.listPage`), for
 *   whoever's lists show everyone's work.
 * - `bounded`: one person's or one team's work, the newest 200 whole
 *   (`jobs.list`), with the status chosen on the server. A page's place
 *   is tied to the exact query that made it, and a list narrowed to "these
 *   people" changes whenever they are put on a job — so a narrow list is
 *   read whole instead of paged (convex/jobs.ts, `listPage`).
 * - `legacy`: a backend from before `listsEverything` — the two deploy
 *   separately (CLAUDE.md). `jobs.list` as it always was, filtered here.
 */
export type JobListSource = 'paged' | 'bounded' | 'legacy'

/**
 * `access.me`'s `listsEverything`, or undefined where the backend is older
 * than the field. Read off any object, so neither the app's `Access` type
 * (which may not name it yet) nor a cached answer from an older backend has
 * to be told it is there.
 */
export function listsEverythingOf(
  access: object | null | undefined,
): boolean | undefined {
  if (!access || !('listsEverything' in access)) return undefined
  return typeof access.listsEverything === 'boolean'
    ? access.listsEverything
    : undefined
}

export function jobListSource(
  listsEverything: boolean | undefined,
): JobListSource {
  if (listsEverything === true) return 'paged'
  if (listsEverything === false) return 'bounded'
  return 'legacy'
}

/** What the Job tab's list area shows. */
export type JobListView = 'pending' | 'failed' | 'empty' | 'noMatches' | 'list'

/**
 * The list area's state, decided in one place so "No jobs yet" can only
 * ever mean it.
 *
 * - Anything to show is shown, whatever else is going on.
 * - Nothing to show and nothing coming: Could not load, with Try again.
 * - Nothing to show yet: the placeholder.
 * - Nothing shown but more behind it — every row a page could read was
 *   stepped over, and the hunt for one has stopped asking by itself: the
 *   list, empty, with its "Show more" under it. Never a placeholder that
 *   waits for good (design-system §4.6), and never "No jobs yet" over jobs
 *   that exist.
 * - Done and empty, but not `confirmedEmpty`: still the placeholder. The
 *   paged list's two copies of its first page are delivered a tick apart —
 *   the paginator's at once, the warmed copy with `access.me` a tick later
 *   — so a view change ("Just my jobs") briefly has the paginator saying
 *   "none" while everything else still says "everyone's". Only when the
 *   warmed copy agrees is the list really empty.
 * - Then "No jobs yet" for the whole list, "No matches" under a status.
 */
export function jobListView(state: {
  /** A status is chosen. */
  filtered: boolean
  /** How many jobs are on screen. */
  rows: number
  /** Nothing to show yet, and something on its way. */
  loading: boolean
  /** The whole list is here. */
  done: boolean
  /** It could not be read, and nothing is on its way. */
  failed: boolean
  /** Everything that answers for this list agrees it is empty. */
  confirmedEmpty: boolean
}): JobListView {
  if (state.rows > 0) return 'list'
  if (state.failed) return 'failed'
  if (state.loading) return 'pending'
  if (!state.done) return 'list'
  if (!state.confirmedEmpty) return 'pending'
  return state.filtered ? 'noMatches' : 'empty'
}

/**
 * The line above the list, digits and noun: "148 jobs", "1000+ jobs" for a
 * count that stopped counting, and "200 jobs · newest 200" for a list that
 * holds only the newest — said out loud rather than quietly dropped, so a
 * filter is known to search those and not the archive.
 */
export function jobsCaption({
  count,
  capped,
  newest,
}: {
  count: number
  /** The count is a floor: there are more than it says. */
  capped?: boolean
  /** The list holds only the newest this many. */
  newest?: number
}): string {
  const noun = count === 1 ? 'job' : 'jobs'
  if (newest !== undefined) return `${count} ${noun} · newest ${newest}`
  return `${count}${capped ? '+' : ''} ${noun}`
}

/**
 * A refusal that means "not signed in (yet)" or "set up two-step sign-in
 * first". A list read without suspense would otherwise sit on its
 * placeholder or say "Could not load"; thrown, it reaches the route's error
 * component, which knows to wait for the sign-in to settle or to send the
 * person to set up two-step sign-in (router.tsx).
 */
export function isSignInRefusal(error: unknown): boolean {
  return isUnauthenticatedError(error) || isMfaEnrolmentError(error)
}
