/**
 * The ways the Schedule can be read, defined once.
 *
 * It was two hand-kept VIEW_OPTIONS lists (the page's and the desktop
 * panel's) and a zod enum beside them — which is how a view ends up
 * offered on one layout and not the other. `job` reads one day as cards;
 * `week` (Phase 4.4) reads the seven days of the strip. The Table view was
 * retired: the card shows everything its row did, and an old `?view=table`
 * link opens the cards (the route's `.catch`).
 */
export const SCHEDULE_VIEWS = ['job', 'week'] as const

export type ScheduleView = (typeof SCHEDULE_VIEWS)[number]

export const SCHEDULE_VIEW_OPTIONS: Array<{
  value: ScheduleView
  label: string
}> = [
  { value: 'job', label: 'Job' },
  { value: 'week', label: 'Week' },
]
