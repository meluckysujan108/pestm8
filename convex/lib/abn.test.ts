import { ConvexError } from 'convex/values'
import { describe, expect, test } from 'vitest'
import { abnDigits, formatAbn, isValidAbn, normaliseAbn } from './abn'

/**
 * Prompt 6.1: a client's ABN is checked with the ATO's checksum, because it
 * goes on an invoice and a length check passes every typo.
 *
 * The ATO's worked example, by hand: 51 824 753 556 less 1 on the first digit
 * is 4 1 8 2 4 7 5 3 5 5 6; weighted 10 1 3 5 7 9 11 13 15 17 19 that is
 * 40 + 1 + 24 + 10 + 28 + 63 + 55 + 39 + 75 + 85 + 114 = 534, which is 6 × 89.
 */
const ATO_EXAMPLE = '51 824 753 556'

describe('a valid ABN', () => {
  test.each([
    [ATO_EXAMPLE, 'the ATO’s own example'],
    ['33 051 775 556', 'Telstra'],
    ['49 004 028 077', 'BHP'],
    ['48 123 123 124', 'Commonwealth Bank'],
    ['88 000 014 675', 'Woolworths'],
  ])('%s passes (%s)', (abn) => {
    expect(isValidAbn(abn)).toBe(true)
  })

  test.each([
    '51824753556',
    '51-824-753-556',
    ' 51 824 753 556 ',
    '51  824 753  556',
    '51 824-753 556',
  ])(
    '"%s" is how people write one, and reads as the same eleven digits',
    (typed) => {
      expect(isValidAbn(typed)).toBe(true)
      expect(abnDigits(typed)).toBe('51824753556')
    },
  )
})

describe('not an ABN', () => {
  test.each([
    ['5182475355', 'ten digits'],
    ['518247535560', 'twelve digits'],
    ['51 824 753 55O', 'a letter O for a zero'],
    ['ABN 51 824 753 556', 'the label pasted in with it'],
    ['51.824.753.556', 'dots, which nobody writes an ABN with'],
    ['', 'nothing'],
  ])('"%s" (%s)', (typed) => {
    expect(isValidAbn(typed)).toBe(false)
    expect(abnDigits(typed)).toBeNull()
  })

  test('eleven digits that fail the checksum', () => {
    // One digit out, and two neighbours swapped: the two slips a length check
    // lets straight through.
    expect(abnDigits('51 824 753 557')).toBe('51824753557')
    expect(isValidAbn('51 824 753 557')).toBe(false)
    expect(isValidAbn('51 824 735 556')).toBe(false)
  })

  test('every single-digit typo of a valid ABN is caught', () => {
    const digits = '51824753556'
    let tried = 0
    for (let i = 0; i < digits.length; i++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === digits[i]) continue
        const typo = digits.slice(0, i) + d + digits.slice(i + 1)
        expect(isValidAbn(typo), typo).toBe(false)
        tried++
      }
    }
    expect(tried).toBe(99)
  })

  test('every transposition of two neighbouring digits is caught', () => {
    const digits = '51824753556'
    for (let i = 0; i < digits.length - 1; i++) {
      if (digits[i] === digits[i + 1]) continue
      const swapped =
        digits.slice(0, i) + digits[i + 1] + digits[i] + digits.slice(i + 2)
      expect(isValidAbn(swapped), swapped).toBe(false)
    }
  })
})

describe('an ABN as stored', () => {
  test('is its eleven digits, however it was typed', () => {
    expect(normaliseAbn(ATO_EXAMPLE)).toBe('51824753556')
    expect(normaliseAbn('51-824-753-556')).toBe('51824753556')
    expect(normaliseAbn(' 51824753556 ')).toBe('51824753556')
  })

  test('is absent when not given, and when blank — which is how a form clears one', () => {
    expect(normaliseAbn(undefined)).toBeUndefined()
    expect(normaliseAbn('')).toBeUndefined()
    expect(normaliseAbn('   ')).toBeUndefined()
  })

  test.each(['51 824 753 557', '5182475355', 'not an ABN'])(
    '"%s" is refused with INVALID_ABN',
    (typed) => {
      expect(() => normaliseAbn(typed)).toThrow(ConvexError)
      expect(() => normaliseAbn(typed)).toThrow('INVALID_ABN')
    },
  )
})

describe('an ABN as printed', () => {
  test('is grouped 2-3-3-3, the way the ABN Lookup prints it', () => {
    expect(formatAbn('51824753556')).toBe(ATO_EXAMPLE)
    expect(formatAbn('51-824-753-556')).toBe(ATO_EXAMPLE)
    expect(formatAbn(normaliseAbn(' 51 824 753 556 ')!)).toBe(ATO_EXAMPLE)
  })

  test('anything that is not eleven digits is printed as it was given', () => {
    expect(formatAbn('5182475355')).toBe('5182475355')
    expect(formatAbn('pending')).toBe('pending')
  })
})
