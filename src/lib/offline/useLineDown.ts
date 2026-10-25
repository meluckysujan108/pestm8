import { keeper } from './keeper'
import type { LineDown } from './keeper'

/**
 * Whether the line to PestM8 is down, for the caption above a save that
 * waits for signal rather than failing: Book job, Save client, Add property.
 * Convex holds such a save until its socket is back (ARCHITECTURE.md §5.5),
 * and the caption says so, so a "Booking…" that sits there isn't taken for
 * a hang. The business switcher reads it too.
 *
 * Down is either of:
 * - `no-signal`: the phone says it has no network (`isOffline()`);
 * - `unreachable`: the phone says it has one, but the Convex socket has not
 *   been connected for 8 s while the page was on screen (20 s while it is
 *   held for a sign-in token) — the same wait ConnectionNotice gives it.
 *
 * The keeper of the kept copy (keeper.ts) watches the line from the start
 * of the page load and decides this (`keeper.downReason`); the hook lives
 * with the keeper's others (useKept.ts). This module stays so its callers,
 * and the guide's name for it, stay as they are.
 */
export type { LineDown } from './keeper'
export { subscribeLineDown, useLineDown } from './useKept'

/** The line now, outside React: null while it is up. */
export function lineDown(): LineDown | null {
  return keeper.downReason()
}
