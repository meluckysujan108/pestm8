import { describe, expect, test } from 'vitest'
import { rq } from '#/lib/routeQueries'
import { aimFor, drawnFrom, drawnNow, firstDrawn } from './keptSchedule'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Which day the Schedule draws with the line down: the one asked for while
 * it can be drawn, else the last one that was put on screen, and never one
 * that was only on its way when the line went.
 */

const B = 'b1' as Id<'businesses'>
const TODAY = '2026-10-25'
const ASKED = '2026-11-23'

describe('what a day or week is drawn from', () => {
  test('its week’s counts and the day, or all seven days', () => {
    expect(drawnFrom(B, TODAY, false)).toEqual([
      rq.week(B, '2026-10-19').queryKey,
      rq.day(B, TODAY).queryKey,
    ])
    const week = drawnFrom(B, TODAY, true)
    expect(week).toHaveLength(8)
    expect(week[1]).toEqual(rq.day(B, '2026-10-19').queryKey)
    expect(week[7]).toEqual(rq.day(B, TODAY).queryKey)
  })
})

describe('the day drawn', () => {
  test('a page opened on a day it can draw starts there, else on today', () => {
    expect(firstDrawn(ASKED, true, TODAY)).toBe(ASKED)
    expect(firstDrawn(ASKED, false, TODAY)).toBe(TODAY)
  })

  test('a day that can be drawn is aimed for; one that can’t keeps the last, and says so', () => {
    expect(
      aimFor({
        requestedKey: ASKED,
        requestedReadable: true,
        lastDrawn: TODAY,
      }),
    ).toEqual({ target: ASKED, notKept: false })
    expect(
      aimFor({
        requestedKey: ASKED,
        requestedReadable: false,
        lastDrawn: TODAY,
      }),
    ).toEqual({ target: TODAY, notKept: true })
  })

  test('a day still loading as the line drops was never drawn, so the page goes back to the one that was', () => {
    // Tomorrow asked for on a working line: the deferred day is still today.
    const tomorrow = '2026-10-26'
    let last = drawnNow(TODAY, TODAY, tomorrow)
    expect(last).toBe(TODAY)
    // The line drops before it lands, and tomorrow is not on the phone.
    expect(
      aimFor({
        requestedKey: tomorrow,
        requestedReadable: false,
        lastDrawn: last,
      }),
    ).toEqual({ target: TODAY, notKept: true })
    // Once a day is on screen, it is the one drawn.
    last = drawnNow(last, tomorrow, tomorrow)
    expect(last).toBe(tomorrow)
  })
})
