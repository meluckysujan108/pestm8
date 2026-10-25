import { startOfWeekKey } from '../../../convex/lib/dates'
import { rq } from '#/lib/routeQueries'
import { weekDayKeys } from '#/lib/weekView'
import type { QueryKey } from '@tanstack/react-query'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Which day the Schedule draws with the line down, pure so its rule can be
 * tested without a page ($businessSlug/schedule.tsx).
 *
 * The day aimed for is the one asked for while it can be drawn (in memory,
 * kept on the phone, or on its way down a working line), else the last one
 * that was drawn: a day the phone keeps no copy of would never be ready,
 * and the page would sit on the one before, dimmed, for good. "Drawn" is a
 * day put on screen, not one merely asked for, so a day still loading as
 * the line goes is no better than one never asked for.
 */

/**
 * What a day or week on the schedule is drawn from: its week's counts, and
 * the day's jobs or all seven days'.
 */
export function drawnFrom(
  businessId: Id<'businesses'>,
  dayKey: string,
  week: boolean,
): Array<QueryKey> {
  const weekStart = startOfWeekKey(dayKey)
  return [
    rq.week(businessId, weekStart).queryKey,
    ...(week ? weekDayKeys(weekStart) : [dayKey]).map(
      (key) => rq.day(businessId, key).queryKey,
    ),
  ]
}

/** The day counted as drawn before anything has been: the one asked for if
 * it can be, else today. */
export function firstDrawn(
  requestedKey: string,
  requestedReadable: boolean,
  today: string,
): string {
  return requestedReadable ? requestedKey : today
}

/**
 * The day to draw, and whether the one asked for is "Not on this phone",
 * whose heading the page then shows over `NotKeptDay`.
 */
export function aimFor(at: {
  requestedKey: string
  requestedReadable: boolean
  lastDrawn: string
}): { target: string; notKept: boolean } {
  return at.requestedReadable
    ? { target: at.requestedKey, notKept: false }
    : { target: at.lastDrawn, notKept: true }
}

/**
 * The day drawn after a render: the one on screen once it has caught up
 * with the one aimed for (`useDeferredValue` keeps the last one up while
 * the next loads), and until then the one before.
 */
export function drawnNow(
  lastDrawn: string,
  selectedKey: string,
  target: string,
): string {
  return selectedKey === target ? selectedKey : lastDrawn
}
