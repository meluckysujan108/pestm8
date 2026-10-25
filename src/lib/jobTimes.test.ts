import { describe, expect, test } from 'vitest'
import {
  endAfter,
  isDayKey,
  lengthBetween,
  minutesOfDay,
  timeOfDay,
} from './jobTimes'

const PERTH = 'Australia/Perth'
const SYDNEY = 'Australia/Sydney'

describe('a time input’s value', () => {
  test('reads as minutes past midnight, seconds or not', () => {
    expect(minutesOfDay('09:30')).toBe(570)
    expect(minutesOfDay('09:30:45')).toBe(570)
    expect(minutesOfDay('00:00')).toBe(0)
    expect(minutesOfDay('23:59')).toBe(1439)
  })

  test('an empty or impossible one is no time at all', () => {
    expect(minutesOfDay('')).toBeNull()
    expect(minutesOfDay('24:00')).toBeNull()
    expect(minutesOfDay('09:60')).toBeNull()
    expect(minutesOfDay('9:30')).toBeNull()
  })

  test('and goes back the way it came', () => {
    expect(timeOfDay(570)).toBe('09:30')
    expect(timeOfDay(0)).toBe('00:00')
    expect(timeOfDay(1439)).toBe('23:59')
  })
})

describe('the end, as the start moves', () => {
  test('keeps the job as long as it was', () => {
    expect(endAfter('09:00', 60)).toBe('10:00')
    expect(endAfter('08:15', 270)).toBe('12:45')
    expect(endAfter('23:00', 59)).toBe('23:59')
  })

  test('past midnight, reads as the clock would, and is then refused', () => {
    expect(endAfter('23:00', 60)).toBe('00:00')
    expect(endAfter('23:30', 90)).toBe('01:00')
    expect(lengthBetween('2026-10-26', '23:30', '01:00', PERTH)).toBeNull()
  })

  test('has nothing to follow without a start or a length', () => {
    expect(endAfter('', 60)).toBeNull()
    expect(endAfter('09:00', 0)).toBeNull()
  })

  test('lands on a whole minute, which is all a time input holds', () => {
    // The server keeps any number; one saved by something else as 37.5
    // would otherwise make "09:37.5", which an input shows as empty.
    expect(endAfter('09:00', 37.5)).toBe('09:38')
  })
})

describe('how long a job from its start to its end is', () => {
  test('in minutes, however many hours', () => {
    expect(lengthBetween('2026-10-26', '08:00', '12:30', PERTH)).toBe(270)
    expect(lengthBetween('2026-10-26', '09:00', '09:15', PERTH)).toBe(15)
    expect(lengthBetween('2026-10-26', '06:00', '17:45', PERTH)).toBe(705)
  })

  test('nothing, when the end is not after the start', () => {
    expect(lengthBetween('2026-10-26', '09:00', '08:00', PERTH)).toBeNull()
    expect(lengthBetween('2026-10-26', '09:00', '09:00', PERTH)).toBeNull()
  })

  test('nothing, when either is empty', () => {
    expect(lengthBetween('2026-10-26', '', '10:00', PERTH)).toBeNull()
    expect(lengthBetween('2026-10-26', '09:00', '', PERTH)).toBeNull()
  })

  test('as the clock reads while the date is cleared, rather than failing', () => {
    expect(isDayKey('')).toBe(false)
    expect(isDayKey('2026-10-26')).toBe(true)
    expect(lengthBetween('', '08:00', '12:30', SYDNEY)).toBe(270)
    expect(lengthBetween('', '12:30', '08:00', SYDNEY)).toBeNull()
  })

  test('as long as it really is, on the days the clocks change', () => {
    // Sydney skips 2–3am on Sun 4 Oct 2026, and has 2–3am twice on Sun
    // 5 Apr 2026.
    expect(lengthBetween('2026-10-04', '01:00', '04:00', SYDNEY)).toBe(120)
    expect(lengthBetween('2026-04-05', '01:00', '04:00', SYDNEY)).toBe(240)
    // Perth has no daylight saving: three hours is three hours.
    expect(lengthBetween('2026-10-04', '01:00', '04:00', PERTH)).toBe(180)
  })

  test('nothing, for a start in the skipped hour that lands after the end', () => {
    // 2:30am does not happen that day and is taken as 3:30am.
    expect(lengthBetween('2026-10-04', '02:30', '03:15', SYDNEY)).toBeNull()
  })
})
