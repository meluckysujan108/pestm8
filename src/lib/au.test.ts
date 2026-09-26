import { describe, expect, test } from 'vitest'
import {
  AU_STATES,
  LICENCE_LABEL,
  TIMEZONE_BY_STATE,
  stateFromTimeZone,
} from './au'

describe('stateFromTimeZone — set-up’s first guess at the state', () => {
  test('each state’s own zone guesses that state', () => {
    // Sydney is the ACT's zone too; a guess can only land on one of them,
    // and NSW is where most of that clock's businesses are.
    for (const { code } of AU_STATES) {
      const guess = stateFromTimeZone(TIMEZONE_BY_STATE[code])
      expect(guess).toBe(code === 'ACT' ? 'NSW' : code)
    }
  })

  test('the odd ones out are put in the state they are in', () => {
    // Adelaide's clock, New South Wales' town.
    expect(stateFromTimeZone('Australia/Broken_Hill')).toBe('NSW')
    expect(stateFromTimeZone('Australia/Eucla')).toBe('WA')
    expect(stateFromTimeZone('Australia/Lindeman')).toBe('QLD')
    expect(stateFromTimeZone('Australia/Canberra')).toBe('ACT')
  })

  test('a phone on another country’s time guesses nothing', () => {
    expect(stateFromTimeZone('Asia/Kathmandu')).toBeNull()
    expect(stateFromTimeZone('UTC')).toBeNull()
    expect(stateFromTimeZone(undefined)).toBeNull()
  })

  test('every state has a licence label to ask with', () => {
    for (const { code } of AU_STATES) {
      expect(LICENCE_LABEL[code]).toBeTruthy()
    }
  })
})
