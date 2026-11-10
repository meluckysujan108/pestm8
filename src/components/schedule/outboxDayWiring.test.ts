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
