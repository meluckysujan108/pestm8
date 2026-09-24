import { describe, expect, test } from 'vitest'
import {
  jobWeatherRequests,
  weatherCellOf,
  weatherKeyOf,
  weatherRequestDays,
} from './weather'

const TODAY = '2026-09-25'
const PERTH = 'Australia/Perth'

describe('what the server is asked', () => {
  test('each suburb-day once, in one order, whatever order the cards came in', () => {
    const morley = { dayKey: TODAY, suburb: 'Morley', postcode: '6062' }
    const bays = { dayKey: TODAY, suburb: 'Bayswater', postcode: '6053' }
    const a = weatherRequestDays([morley, bays, morley], TODAY)
    const b = weatherRequestDays([bays, morley], TODAY)
    expect(a).toEqual(b)
    expect(a.map((d) => d.suburb)).toEqual(['Bayswater', 'Morley'])
  })

  test('not days no forecast could exist for, nor jobs with no suburb', () => {
    const days = weatherRequestDays(
      [
        { dayKey: '2026-10-20', suburb: 'Morley', postcode: '6062' },
        { dayKey: '2026-09-20', suburb: 'Morley', postcode: '6062' },
        { dayKey: TODAY, suburb: '', postcode: '' },
        { dayKey: '2026-10-09', suburb: 'Morley', postcode: '6062' },
      ],
      TODAY,
    )
    expect(days.map((d) => d.dayKey)).toEqual(['2026-10-09'])
  })

  test('the property’s state is sent only when there is one', () => {
    const [withState, without] = weatherRequestDays(
      [
        { dayKey: TODAY, suburb: 'Darwin', postcode: '0800', state: 'NT' },
        { dayKey: TODAY, suburb: 'Morley', postcode: '6062', state: '' },
      ],
      TODAY,
    )
    expect(withState).toHaveProperty('state', 'NT')
    expect(without).not.toHaveProperty('state')
  })

  test('a job asks for its own day in the business’s zone, suburb and state', () => {
    // 5pm UTC on the 24th is 1am on the 25th in Perth.
    const [request] = jobWeatherRequests(
      [
        {
          scheduledAt: Date.parse('2026-09-24T17:00:00Z'),
          suburb: 'Darwin',
          postcode: '0800',
          propertyState: 'NT',
        },
      ],
      PERTH,
    )
    expect(request).toEqual({
      dayKey: TODAY,
      suburb: 'Darwin',
      postcode: '0800',
      state: 'NT',
    })
  })
})

describe('what a card draws', () => {
  const morley = { suburb: 'Morley', maxTempC: 21 }
  const byKey = { [weatherKeyOf('Morley', '6062', TODAY)]: morley }
  const cell = (waiting: boolean, dayKey = TODAY, suburb = 'Morley') =>
    weatherCellOf(byKey, waiting, TODAY, suburb, '6062', dayKey)

  test('its forecast, once there is one', () => {
    expect(cell(false)).toEqual({ status: 'ready', weather: morley })
    // …even while a newer answer is on its way.
    expect(cell(true)).toEqual({ status: 'ready', weather: morley })
  })

  test('a placeholder while its answer is on its way, "No forecast" once it is not in it', () => {
    expect(cell(true, '2026-09-26')).toEqual({ status: 'pending' })
    expect(cell(false, '2026-09-26')).toEqual({ status: 'absent' })
  })

  test('nothing at all out of the window, or with no suburb', () => {
    expect(cell(true, '2026-12-25')).toEqual({ status: 'outOfWindow' })
    expect(cell(false, TODAY, '')).toEqual({ status: 'outOfWindow' })
  })
})
