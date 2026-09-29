import type { HistoryState } from '@tanstack/react-router'

/**
 * Add new, opened from the list: the list's link marks the history entry it
 * pushes, so a finished Add goes BACK to the list it came from. Replacing Add
 * with a fresh copy of the list would leave the list in the history twice,
 * and Back would show the same page again. Opened any other way (a link from
 * elsewhere, a refresh of a bare address), there is no such entry to go back
 * to, and Add goes to the list by replacing itself.
 *
 * Its own small module so the list, which every Licences & insurance visit
 * loads, does not pull Add's code in with it.
 */
const FROM_LIST_KEY = 'licenceAddFromList'

/** The history state the list's Add link pushes. */
export const addFromListState = (): HistoryState =>
  ({ [FROM_LIST_KEY]: true }) as HistoryState

/** Whether this history entry was pushed by the list's Add link. */
export function addedFromList(state: HistoryState): boolean {
  return (state as Record<string, unknown>)[FROM_LIST_KEY] === true
}
