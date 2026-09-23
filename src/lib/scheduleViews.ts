/**
 * The ways the Schedule can be read, defined once.
 *
 * It was two hand-kept VIEW_OPTIONS lists (the page's and the desktop
 * panel's) and a zod enum beside them — which is how a view ends up
 * offered on one layout and not the other. `job` and `table` read one day;
 * `week` (Phase 4.4) reads the seven days of the strip.
 */
export const SCHEDULE_VIEWS = ['job', 'table', 'week'] as const

export type ScheduleView = (typeof SCHEDULE_VIEWS)[number]

/** The views that read a single day. */
export type DayView = Exclude<ScheduleView, 'week'>

export const SCHEDULE_VIEW_OPTIONS: Array<{
  value: ScheduleView
  label: string
}> = [
  { value: 'job', label: 'Job' },
  { value: 'table', label: 'Table' },
  { value: 'week', label: 'Week' },
]
