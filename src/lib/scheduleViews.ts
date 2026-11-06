/**
 * The ways the Schedule can be read, defined once.
 *
 * It was two hand-kept VIEW_OPTIONS lists (the page's and the desktop
 * panel's) and a zod enum beside them — which is how a view ends up
 * offered on one layout and not the other. `job` reads one day as cards;
 * `week` (Phase 4.4) reads the seven days of the strip; `recurring` is the
 * Job section's Recurring Job (`RecurringView`), which belongs to no day,
 * so the strip makes way for it. The Table view was retired: the card shows
 * everything its row did, and an old `?view=table` link opens the cards (the
 * route's `.catch`).
 */
export const SCHEDULE_VIEWS = ['job', 'week', 'recurring'] as const

export type ScheduleView = (typeof SCHEDULE_VIEWS)[number]

export const SCHEDULE_VIEW_OPTIONS: Array<{
  value: ScheduleView
  label: string
}> = [
  { value: 'job', label: 'Job' },
  { value: 'week', label: 'Week' },
  { value: 'recurring', label: 'Recurring' },
]

/**
 * How the Schedule moves to a day to open one of its jobs over it (New
 * Job's Open #123), as picking that day does (`setDay`): in the week, the
 * day is scrolled to (`focusWeek`); in a day's list, a day newly opened
 * reads from its top, while the day already shown keeps the person's place
 * in it. The Recurring view is no day's, so it stays put under the sheet.
 */
export function openJobScroll(
  view: ScheduleView,
  shownKey: string,
  dayKey: string,
): { resetScroll: boolean; focusWeek: boolean } {
  return {
    resetScroll: view === 'job' && dayKey !== shownKey,
    focusWeek: view === 'week',
  }
}
