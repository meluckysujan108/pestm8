import { ConvexError } from 'convex/values'
import { describe, expect, test } from 'vitest'
import { checkPhone, normalisePhone } from './phone'

/**
 * Field verification: Call and Text dial whatever is saved, so a number that
 * can never be dialled is refused, and the rest get a warning with a one-tap
 * fix. Nothing typed is ever rewritten without being asked: `tidy` is only
 * offered.
 */

describe('numbers that are fine as typed', () => {
  test.each([
    ['0412 345 678', 'mobile'],
    ['08 9123 4567', 'landline'],
    ['02 9123 4567', 'landline'],
    ['03 9123 4567', 'landline'],
    ['07 3123 4567', 'landline'],
    ['1300 123 456', 'special'],
    ['1800 123 456', 'special'],
    ['13 12 34', 'special'],
  ] as const)('%j is a %s number, with nothing to offer', (typed, kind) => {
    expect(checkPhone(typed)).toEqual({ level: 'ok', kind })
  })

  test('blank is not a problem here: whether it may be blank is the form’s', () => {
    expect(checkPhone('')).toEqual({ level: 'ok', kind: 'unknown' })
    expect(checkPhone('   ')).toEqual({ level: 'ok', kind: 'unknown' })
  })

  test('surrounding spaces are not an untidy number', () => {
    expect(checkPhone('  0412 345 678  ')).toEqual({
      level: 'ok',
      kind: 'mobile',
    })
  })

  test("another country's number is trusted as typed", () => {
    expect(checkPhone('+44 20 7946 0958')).toEqual({
      level: 'ok',
      kind: 'international',
    })
    expect(checkPhone('+1 (555) 010-9999')).toEqual({
      level: 'ok',
      kind: 'international',
    })
  })
})

describe('the usual way of writing it, offered', () => {
  test.each([
    ['0412345678', '0412 345 678', 'mobile'],
    ['0412-345-678', '0412 345 678', 'mobile'],
    ['04 1234 5678', '0412 345 678', 'mobile'],
    ['(08) 9123 4567', '08 9123 4567', 'landline'],
    ['0891234567', '08 9123 4567', 'landline'],
    ['1300123456', '1300 123 456', 'special'],
    ['131234', '13 12 34', 'special'],
    // Written from overseas: the same number, as dialled from here.
    ['+61 412 345 678', '0412 345 678', 'mobile'],
    ['+61412345678', '0412 345 678', 'mobile'],
    ['61412345678', '0412 345 678', 'mobile'],
    ['0061 412 345 678', '0412 345 678', 'mobile'],
    ['0061 8 9123 4567', '08 9123 4567', 'landline'],
    // The 0 in brackets is not dialled after +61.
    ['+61 (0)8 9123 4567', '08 9123 4567', 'landline'],
    ['+610412345678', '0412 345 678', 'mobile'],
  ] as const)('%j → %j', (typed, tidy, kind) => {
    expect(checkPhone(typed)).toEqual({ level: 'ok', kind, tidy })
  })

  test.each([
    ['08 9123 4567 x21', '08 9123 4567 ext 21'],
    ['08 9123 4567 x 21', '08 9123 4567 ext 21'],
    ['0412345678 ext. 5', '0412 345 678 ext 5'],
    ['08 9123 4567 extension 200', '08 9123 4567 ext 200'],
    ['(08) 9123 4567 EXT 3', '08 9123 4567 ext 3'],
  ])('an extension is kept: %j → %j', (typed, tidy) => {
    expect(checkPhone(typed)).toMatchObject({ level: 'ok', tidy })
  })

  test('a number already written the usual way, with its extension, is left be', () => {
    expect(checkPhone('08 9123 4567 ext 21')).toEqual({
      level: 'ok',
      kind: 'landline',
    })
  })
})

describe('warnings, each with its fix where the meaning is plain', () => {
  test('a local number missing its area code gets the business’s', () => {
    expect(checkPhone('9123 4567', { businessState: 'WA' })).toEqual({
      level: 'warning',
      kind: 'local',
      message:
        'Missing the area code. From a mobile it will not connect without one.',
      tidy: '08 9123 4567',
    })
    expect(checkPhone('9123 4567', { businessState: 'nsw' }).tidy).toBe(
      '02 9123 4567',
    )
    expect(checkPhone('9123 4567', { businessState: 'VIC' }).tidy).toBe(
      '03 9123 4567',
    )
    expect(checkPhone('3123 4567', { businessState: 'QLD' }).tidy).toBe(
      '07 3123 4567',
    )
    expect(checkPhone('9123 4567 x2', { businessState: 'NT' }).tidy).toBe(
      '08 9123 4567 ext 2',
    )
  })

  test('without a state, the area code offered is 08', () => {
    expect(checkPhone('91234567').tidy).toBe('08 9123 4567')
    expect(checkPhone('91234567', { businessState: 'XX' }).tidy).toBe(
      '08 9123 4567',
    )
  })

  test('a mobile missing its 0', () => {
    expect(checkPhone('412 345 678')).toEqual({
      level: 'warning',
      kind: 'mobile',
      message: 'A mobile number starts with 04.',
      tidy: '0412 345 678',
    })
  })

  test('05 numbers', () => {
    expect(checkPhone('0512 345 678')).toEqual({
      level: 'warning',
      kind: 'unknown',
      message: '05 numbers are not in use in Australia yet. Check it.',
    })
  })

  test.each([
    ['041234567', 9],
    ['04123456789', 11],
    ['891234567', 9],
    ['+61 8 9123 456', 9],
    ['6112345678', 10],
    ['0912 345 678', 10],
  ])('%j is not a number here, and no fix is guessed', (typed, digits) => {
    expect(checkPhone(typed)).toEqual({
      level: 'warning',
      kind: 'unknown',
      message: `This does not look like an Australian number (it has ${digits} digits). Check it.`,
    })
  })
})

describe('errors: a number that can never be dialled', () => {
  test.each([
    'ph 0412345678',
    '0412 345 678 (Bob)',
    'call after 5',
    'O412 345 678',
    '0412 345 678 ext',
  ])('%j has letters in it', (typed) => {
    expect(checkPhone(typed)).toEqual({
      level: 'error',
      kind: 'unknown',
      message:
        'A phone number can only have digits, spaces, brackets and a +. Put a name or note somewhere else.',
    })
  })

  test.each(['123', '12345', '+61', '(08)', '12 34 5'])(
    '%j is too short',
    (typed) => {
      expect(checkPhone(typed)).toEqual({
        level: 'error',
        kind: 'unknown',
        message: 'That is too short for a phone number.',
      })
    },
  )

  test('the letters of an extension are not counted as letters', () => {
    expect(checkPhone('08 9123 4567 ext 2').level).toBe('ok')
    expect(checkPhone('08 9123 4567 x2').level).toBe('ok')
  })

  test('an extension alone is no number, and not an error either', () => {
    expect(checkPhone('ext 2')).toEqual({ level: 'ok', kind: 'unknown' })
  })
})

describe('the fix offered is always a number that passes', () => {
  test.each(['0412345678', '(08) 9123 4567', '+61 412 345 678', '412 345 678'])(
    '%j',
    (typed) => {
      const { tidy } = checkPhone(typed, { businessState: 'WA' })
      expect(tidy).toBeDefined()
      expect(checkPhone(tidy!)).toMatchObject({ level: 'ok' })
      expect(checkPhone(tidy!).tidy).toBeUndefined()
    },
  )

  test('and the local number’s fix too', () => {
    const { tidy } = checkPhone('9123 4567', { businessState: 'WA' })
    expect(checkPhone(tidy!)).toEqual({ level: 'ok', kind: 'landline' })
  })
})

describe('normalisePhone: as stored', () => {
  test('trimmed and otherwise as typed: the stricter checks are the form’s', () => {
    expect(normalisePhone('  0412 345 678 ')).toBe('0412 345 678')
    // A note in brackets from an older screen is not turned away.
    expect(normalisePhone('0412 345 678 (Bob)')).toBe('0412 345 678 (Bob)')
    expect(normalisePhone('9123 4567')).toBe('9123 4567')
  })

  test('absent when not given or blank', () => {
    expect(normalisePhone(undefined)).toBeUndefined()
    expect(normalisePhone('')).toBeUndefined()
    expect(normalisePhone('  ')).toBeUndefined()
  })

  test('refuses a number too short to dial, with a code the client can read', () => {
    expect(() => normalisePhone('12345')).toThrow(ConvexError)
    try {
      normalisePhone('ph 123')
    } catch (error) {
      expect((error as ConvexError<string>).data).toBe('INVALID_PHONE')
    }
    expect(normalisePhone('13 12 34')).toBe('13 12 34')
  })
})

describe('an 8-digit number starting with 0 or 1 is not a local number', () => {
  test.each(['0412 3456', '0891 2345', '1300 1234'])(
    '%j gets no area code put in front of it',
    (typed) => {
      const check = checkPhone(typed, { businessState: 'WA' })
      expect(check.level).toBe('warning')
      expect(check.tidy).toBeUndefined()
      expect(check.message).toMatch(/does not look like an Australian number/)
    },
  )
})
