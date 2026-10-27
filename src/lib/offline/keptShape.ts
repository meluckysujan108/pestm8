/**
 * Which answers the phone keeps, and the shape they are kept in: the two
 * facts about the kept copy that the server's own tests hold the server to
 * (convex/keptShape.test.ts). In a module of their own that imports nothing,
 * so that test reads them without loading the app.
 *
 * keptSet.ts passes both on, and everything else reads them from there.
 */

/**
 * The Convex functions whose answers are kept: the schedule's days and
 * weeks, what New Job is made of, and what is booked at each site for its
 * double-booking check. Nothing `keptOutOfHtml` names, and nothing that is
 * already in every page's HTML.
 *
 * `jobs:openWork` is kept but not yet asked for (`keptQueries`): nothing
 * reads it until New Job's check does, and pinning it before then would
 * only add a subscription to every page.
 */
export const KEPT_FNS = [
  'jobs:listDay',
  'jobs:listWeek',
  'clients:directory',
  'memberships:listForBusiness',
  'jobTypes:list',
  'jobs:openWork',
] as const

export type KeptFn = (typeof KEPT_FNS)[number]

/**
 * Bumped whenever a kept query's answer changes shape (a field renamed or
 * removed), so a copy written by an older build is never read as this one's.
 * convex/keptShape.test.ts lists the shape this number stands for, and fails
 * when the queries answer in another.
 */
export const KEPT_SHAPE = 1
