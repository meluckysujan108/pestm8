import { describe, expect, test } from 'vitest'
import { openJobScroll } from './scheduleViews'

/**
 * The Schedule moving to a job's day to open it over that day (New Job's
 * Open #123, the matching plan's M5), as picking that day moves: the
 * person never lands mid-list on a day they hadn't been reading.
 */
describe('to a job’s day, for Open #123 (`openJobScroll`)', () => {
  test('in a day’s list, another day reads from its top, as picking it does', () => {
    expect(openJobScroll('job', '2026-11-02', '2026-11-05')).toEqual({
      resetScroll: true,
      focusWeek: false,
    })
  })

  test('the day already shown keeps the place in it', () => {
    expect(openJobScroll('job', '2026-11-05', '2026-11-05')).toEqual({
      resetScroll: false,
      focusWeek: false,
    })
  })

  test('in the week, the page stays put and the day is scrolled to', () => {
    expect(openJobScroll('week', '2026-11-02', '2026-11-05')).toEqual({
      resetScroll: false,
      focusWeek: true,
    })
  })
})
