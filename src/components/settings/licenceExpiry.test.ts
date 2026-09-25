import { describe, expect, test } from 'vitest'
import {
  WARN_DAYS,
  expiryBadgeText,
  expiryOf,
  formatExpiryDate,
  licenceSubtitle,
  walletExpiry,
} from './licenceExpiry'

const TODAY = '2026-09-26'

describe('expiryOf', () => {
  test.each([
    [undefined, 'none'],
    ['2026-09-25', 'expired'],
    ['2026-09-26', 'soon'],
    ['2026-11-25', 'soon'],
    ['2026-11-26', 'ok'],
  ] as const)('%s is %s', (expiresOn, state) => {
    expect(expiryOf(expiresOn, TODAY).state).toBe(state)
  })

  test('turns amber sixty days out, not sixty-one', () => {
    expect(WARN_DAYS).toBe(60)
    expect(expiryOf('2026-11-25', TODAY)).toEqual({ state: 'soon', days: 60 })
    expect(expiryOf('2026-11-26', TODAY)).toEqual({ state: 'ok', days: 61 })
  })
})

describe('expiryBadgeText', () => {
  test.each([
    ['2026-09-25', 'Expired'],
    ['2026-09-26', 'Last day'],
    ['2026-09-27', '1 day'],
    ['2026-10-26', '30 days'],
    ['2027-09-26', null],
  ] as const)('%s says %s', (expiresOn, words) => {
    expect(expiryBadgeText(expiryOf(expiresOn, TODAY))).toBe(words)
  })

  test('no date, no badge', () => {
    expect(expiryBadgeText(expiryOf(undefined, TODAY))).toBeNull()
  })
})

describe('the words under a licence', () => {
  test('the date as written, whatever the zone', () => {
    expect(formatExpiryDate('2027-03-12')).toBe('12 Mar 2027')
    expect(formatExpiryDate('2027-01-01')).toBe('1 Jan 2027')
  })

  test.each([
    [
      { number: 'PMT-4471', expiresOn: '2027-03-12' },
      'PMT-4471 · Expires 12 Mar 2027',
    ],
    [{ expiresOn: '2026-01-03' }, 'Expired 3 Jan 2026'],
    [{ number: 'WC-1' }, 'WC-1 · No expiry'],
    [{}, 'No expiry'],
  ])('%o reads "%s"', (licence, words) => {
    expect(licenceSubtitle(licence, TODAY)).toBe(words)
  })
})

describe('walletExpiry', () => {
  test('expired outranks expiring, which outranks nothing', () => {
    expect(walletExpiry([], TODAY)).toBeNull()
    expect(walletExpiry([{}, { expiresOn: '2030-01-01' }], TODAY)).toBeNull()
    expect(walletExpiry([{ expiresOn: '2026-10-01' }], TODAY)).toBe('soon')
    expect(
      walletExpiry(
        [{ expiresOn: '2026-10-01' }, { expiresOn: '2026-01-01' }],
        TODAY,
      ),
    ).toBe('expired')
  })
})
