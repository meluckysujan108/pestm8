// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

/**
 * A day's empty and no-matches states, and where its WeatherCredit goes,
 * are decided on whether its "Not sent yet" group draws anything
 * (`outboxDrawn`): its slots, and today's bookings saved by a newer PestM8,
 * which are no slots. A page asking only for slots draws "This day is
 * clear." in place of a booking the group would list, which then can't be
 * opened or discarded anywhere (plan §9.3, D13). There is no DOM renderer
 * here for a route, so this pins both pages that draw a day.
 */
const SRC = resolve(import.meta.dirname, '../..')

test.each([
  'routes/$businessSlug/schedule.tsx',
  'components/schedule/DayAgendaPanel.tsx',
])('%s decides the day on what its group draws', (page) => {
  const text = readFileSync(resolve(SRC, page), 'utf8')
  expect(text).not.toMatch(/outboxDay\.slots\.length/)
  // EmptyState, NoMatches, and WeatherCredit in the grid and under it.
  expect(text.match(/outboxDrawn\(outboxDay\)/g)).toHaveLength(4)
})

/**
 * A booking's sheet hands over to its job in the same `SheetShell`, but its
 * body and the job's are two components, so two elements: the job's lands
 * where the booking's stood only if the sheet passes that along, and only to
 * the job handed over to (plan §9.5).
 */
test('the job handed over to lands where the booking’s body stood, and no other', () => {
  const text = readFileSync(
    resolve(SRC, 'components/schedule/JobDetailSheet.tsx'),
    'utf8',
  )
  expect(text).toMatch(
    /landing=\{landing\?\.jobId === jobId \? landing\.body : null\}/,
  )
  expect(text).toMatch(/kept\.day !== null,\s+landing,\s+\)/)
  expect(text).toMatch(
    /setLanding\(\{ jobId: sentAs, body \}\)\s+onSent\(sentAs\)/,
  )
  expect(text).toMatch(/if \(closed\) setLanding\(null\)/)
})

/**
 * The Week View's days draw their bookings not sent yet too (plan §9.3): a
 * day with only those draws no "No jobs", which would be untrue; a job a
 * slot draws is left out of the day's list, which would draw it twice; and
 * each day's comes on only at the week's first drawing (`inWeek`), since
 * every day under it would move. The schedule hands the week the bookings'
 * sheet to open.
 */
test('the Week View’s days decide on what their group draws, and draw each job once', () => {
  const week = readFileSync(
    resolve(SRC, 'components/schedule/WeekView.tsx'),
    'utf8',
  )
  expect(week).toMatch(
    /committed\.length === 0 && dueHere\.length === 0 && !drawsOutbox/,
  )
  expect(week).toMatch(
    /const drawsOutbox = outboxDay !== null && outboxDrawn\(outboxDay\)/,
  )
  expect(week).toMatch(/!outboxDay\.hidden\.has\(job\._id\)/)
  expect(week).toMatch(/inWeek: true/)
  expect(week).toMatch(/drawsCards: false/)
  const schedule = readFileSync(
    resolve(SRC, 'routes/$businessSlug/schedule.tsx'),
    'utf8',
  )
  expect(schedule).toMatch(
    /<WeekView[\s\S]*?outbox=\{\{\s+onOpenItem: setOpenOutboxId,/,
  )
})

/**
 * The Week View's first scroll to a day waits for the days above to draw
 * their bookings on this phone (`useOutboxSettled`), which come on only as
 * the week first draws and would push the day off screen (F5).
 */
test('the Week View scrolls to its day only once the bookings above it have come on', () => {
  const week = readFileSync(
    resolve(SRC, 'components/schedule/WeekView.tsx'),
    'utf8',
  )
  expect(week).toMatch(
    /useScrollToDay\(focusKey, weekStart, focusTick, useOutboxSettled\(\)\)/,
  )
  // Not settled, nothing is done, and the first scroll is still to come.
  expect(week).toMatch(
    /useEffect\(\(\) => \{\s*if \(!settled\) return\s*const isFirst = first\.current\s*first\.current = false/,
  )
  expect(week).toMatch(/\}, \[focusKey, weekStart, tick, settled\]\)/)
})
