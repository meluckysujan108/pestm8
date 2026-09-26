import { describe, expect, test } from 'vitest'
import {
  MAX_LICENCES,
  MAX_LICENCE_FILES,
  MAX_LICENCE_NAME_LENGTH,
  MAX_LICENCE_NUMBER_LENGTH,
  checkExpiresOn,
  checkLicenceCount,
  checkLicenceFileCount,
  cleanLicenceName,
  cleanLicenceNumber,
  daysUntilExpiry,
  isCalendarDate,
} from './memberLicences'

describe('cleanLicenceName', () => {
  test('trimmed, one space between words, controls gone', () => {
    expect(cleanLicenceName('  Pest   management (WA) ')).toEqual({
      ok: true,
      value: 'Pest management (WA)',
    })
    expect(cleanLicenceName('White\ncard')).toEqual({
      ok: true,
      value: 'White card',
    })
    // An RLO would make the name read backwards on the owner's screen.
    expect(cleanLicenceName('Fumi‮gation\u0000')).toEqual({
      ok: true,
      value: 'Fumigation',
    })
  })

  test('required, and no longer than the limit', () => {
    for (const name of ['', '   ', '‮\u0007']) {
      expect(cleanLicenceName(name)).toEqual({
        ok: false,
        refusal: 'INVALID_NAME',
      })
    }
    const longest = 'x'.repeat(MAX_LICENCE_NAME_LENGTH)
    expect(cleanLicenceName(longest)).toEqual({ ok: true, value: longest })
    expect(cleanLicenceName(`${longest}x`)).toEqual({
      ok: false,
      refusal: 'INVALID_NAME',
    })
  })

  test('nothing visible is no name: zero-width and format characters alone', () => {
    for (const name of [
      '​', // zero-width space
      '​‌‍', // with the non-joiner and joiner
      '⁠', // word joiner
      '­', // soft hyphen
      ' ​ 　 ', // among spaces, an ideographic one included
    ]) {
      expect(cleanLicenceName(name), JSON.stringify(name)).toEqual({
        ok: false,
        refusal: 'INVALID_NAME',
      })
    }
  })

  test('what is visible keeps its invisible parts, so an emoji stays whole', () => {
    // A zero-width joiner holds the worker and the sign together.
    expect(cleanLicenceName('👷‍♀️')).toEqual({ ok: true, value: '👷‍♀️' })
    expect(cleanLicenceName('White​card')).toEqual({
      ok: true,
      value: 'White​card',
    })
  })
})

describe('cleanLicenceNumber', () => {
  test('blank means none', () => {
    expect(cleanLicenceNumber('')).toEqual({ ok: true, value: undefined })
    expect(cleanLicenceNumber('  ')).toEqual({ ok: true, value: undefined })
    expect(cleanLicenceNumber(' PMT 1234 ')).toEqual({
      ok: true,
      value: 'PMT 1234',
    })
  })

  test('nothing visible is blank too, never an invisible number', () => {
    for (const number of ['​', '⁠‍', ' ­ ']) {
      expect(cleanLicenceNumber(number), JSON.stringify(number)).toEqual({
        ok: true,
        value: undefined,
      })
    }
    expect(cleanLicenceNumber('PMT​1234')).toEqual({
      ok: true,
      value: 'PMT​1234',
    })
  })

  test('refused rather than cut short past the limit', () => {
    const longest = '9'.repeat(MAX_LICENCE_NUMBER_LENGTH)
    expect(cleanLicenceNumber(longest)).toEqual({ ok: true, value: longest })
    expect(cleanLicenceNumber(`${longest}9`)).toEqual({
      ok: false,
      refusal: 'INVALID_NUMBER',
    })
  })
})

describe('expiry dates', () => {
  test('a date that exists, written YYYY-MM-DD', () => {
    for (const date of [
      '2027-06-30',
      '2028-02-29',
      '2000-02-29',
      '1999-12-31',
    ]) {
      expect(isCalendarDate(date), date).toBe(true)
    }
    for (const date of [
      '2027-02-29', // not a leap year
      '1900-02-29', // nor is a century, unless divisible by 400
      '2027-04-31',
      '2027-13-01',
      '2027-00-10',
      '2027-06-00',
      '2027-6-30',
      '27-06-30',
      '30/06/2027',
      '2027-06-30T00:00:00Z',
      '0202-06-30',
      '20266-06-30',
      ' 2027-06-30x',
    ]) {
      expect(isCalendarDate(date), date).toBe(false)
    }
  })

  test('blank means none; anything else must be a date', () => {
    expect(checkExpiresOn('')).toEqual({ ok: true, value: undefined })
    expect(checkExpiresOn(' 2027-06-30 ')).toEqual({
      ok: true,
      value: '2027-06-30',
    })
    expect(checkExpiresOn('2027-02-30')).toEqual({
      ok: false,
      refusal: 'INVALID_DATE',
    })
  })

  test('days to go: 0 on the last good day, negative after', () => {
    expect(daysUntilExpiry('2027-06-30', '2027-06-30')).toBe(0)
    expect(daysUntilExpiry('2027-06-30', '2027-06-29')).toBe(1)
    expect(daysUntilExpiry('2027-06-30', '2027-07-01')).toBe(-1)
    expect(daysUntilExpiry('2027-03-01', '2027-02-28')).toBe(1)
    expect(daysUntilExpiry('2028-03-01', '2028-02-28')).toBe(2)
    expect(daysUntilExpiry('2028-01-01', '2027-01-01')).toBe(365)
    // Across a daylight-saving change in the eastern states: still whole days.
    expect(daysUntilExpiry('2026-10-05', '2026-10-03')).toBe(2)
  })
})

describe('caps', () => {
  test('licences per person, files per licence', () => {
    expect(checkLicenceCount(MAX_LICENCES - 1)).toEqual({ ok: true })
    expect(checkLicenceCount(MAX_LICENCES)).toEqual({
      ok: false,
      refusal: 'TOO_MANY_LICENCES',
    })
    expect(checkLicenceFileCount(MAX_LICENCE_FILES - 1)).toEqual({ ok: true })
    expect(checkLicenceFileCount(MAX_LICENCE_FILES)).toEqual({
      ok: false,
      refusal: 'TOO_MANY_FILES',
    })
  })
})
