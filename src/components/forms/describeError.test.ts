import { afterEach, describe, expect, test, vi } from 'vitest'
import { ConvexError } from 'convex/values'
import { ERROR_COPY, describeError, errorCode } from './describeError'

afterEach(() => vi.unstubAllGlobals())

describe('errorCode', () => {
  test('reads a ConvexError carrying a string', () => {
    expect(errorCode(new ConvexError('INVALID_EMAIL'))).toBe('INVALID_EMAIL')
  })

  test('reads a ConvexError carrying { code }', () => {
    expect(
      errorCode(new ConvexError({ code: 'REPORT_INCOMPLETE', issues: [] })),
    ).toBe('REPORT_INCOMPLETE')
  })

  test('finds a known code named in a plain error message', () => {
    expect(
      errorCode(
        new Error(
          '[CONVEX M(clients:update)] Uncaught Error: NOT_FOUND at handler',
        ),
      ),
    ).toBe('NOT_FOUND')
  })

  test('does not match a code inside a longer word', () => {
    expect(errorCode(new Error('JOB_INVOICED_LATER'))).toBeNull()
  })

  test('nothing to read is null', () => {
    expect(errorCode(null)).toBeNull()
    expect(errorCode('NOT_FOUND')).toBeNull()
    expect(errorCode(new Error('Server Error'))).toBeNull()
  })
})

describe('describeError', () => {
  test.each([
    'INVALID_EMAIL',
    'INVALID_PHONE',
    'INVALID_ABN',
    'NOT_FOUND',
    'NO_ACCESS',
    'UNAUTHENTICATED',
    'JOB_INVOICED',
  ] as const)('%s has its own words', (code) => {
    expect(describeError(new ConvexError(code))).toBe(ERROR_COPY[code])
  })

  test('a form can say a code its own way', () => {
    expect(
      describeError(new ConvexError('INVALID_PHONE'), {
        INVALID_PHONE: 'Check the site contact number.',
      }),
    ).toBe('Check the site contact number.')
  })

  test('a form can give words to a code only it meets', () => {
    expect(
      describeError(new ConvexError({ code: 'SLOT_TAKEN' }), {
        SLOT_TAKEN: 'Someone booked that slot first.',
      }),
    ).toBe('Someone booked that slot first.')
  })

  test('a dropped connection says so', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toBe(
      ERROR_COPY.offline,
    )
  })

  test('an offline browser says so, whatever the error', () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(describeError(new Error('Server Error'))).toBe(ERROR_COPY.offline)
  })

  test('anything else is the generic default, or the form’s', () => {
    expect(describeError(new Error('Server Error'))).toBe(
      'Could not save. Check your signal and try again.',
    )
    expect(
      describeError(undefined, { default: 'Could not book the job.' }),
    ).toBe('Could not book the job.')
    expect(describeError(new ConvexError('SOMETHING_NEW'))).toBe(
      ERROR_COPY.default,
    )
  })
})
