/**
 * What this phone keeps a copy of, for opening the schedule and New Job with
 * no signal, and the switches that govern it.
 *
 * Only the constants the clearing code needs so far. keptStore.ts imports
 * them, and through it rootState.ts and the root route, so nothing added here
 * may import either of those.
 */

/**
 * The kill switch. False: nothing is read from the phone, nothing is served
 * from it or written to it, and whatever an earlier build kept is wiped on
 * the next page load (`checkKeptOwner`).
 *
 * `as boolean`: a bare `true` is typed as the literal, and every check on it
 * would then be an unnecessary condition to the linter.
 */
export const KEPT_ENABLED = true as boolean

/**
 * Bumped whenever a kept query's answer changes shape (a field renamed or
 * removed), so a copy written by an older build is never read as this one's.
 */
export const KEPT_SHAPE = 1

/**
 * How long the page load's read of the kept copy may take before it is given
 * up on. Off the critical path either way: the read starts at module load.
 */
export const PEEK_TIMEOUT_MS = 3_000

/**
 * The Convex functions whose answers are kept: the schedule's days and
 * weeks, and what New Job is made of. Nothing `keptOutOfHtml` names, and
 * nothing that is already in every page's HTML.
 */
export const KEPT_FNS = [
  'jobs:listDay',
  'jobs:listWeek',
  'clients:directory',
  'memberships:listForBusiness',
  'jobTypes:list',
] as const

export type KeptFn = (typeof KEPT_FNS)[number]
