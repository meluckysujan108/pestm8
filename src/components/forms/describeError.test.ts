import { afterEach, describe, expect, test, vi } from 'vitest'
import { ConvexError } from 'convex/values'
import {
  ERROR_COPY,
  convexCode,
  describeError,
  errorCode,
} from './describeError'

afterEach(() => vi.unstubAllGlobals())

describe('convexCode', () => {
  test('reads a ConvexError carrying a string', () => {
    expect(convexCode(new ConvexError('SITE_BOOKED'))).toBe('SITE_BOOKED')
  })

  test('reads the code of a refusal that brings its rows', () => {
    expect(
      convexCode(
        new ConvexError({
          code: 'MATCHED_CLIENT',
          candidates: [{ clientId: 'c1', name: 'Jane Nguyen', auto: false }],
        }),
      ),
    ).toBe('MATCHED_CLIENT')
    expect(
      convexCode(new ConvexError({ code: 'SITE_REPEATS', series: [] })),
    ).toBe('SITE_REPEATS')
  })

  test('reads data on anything that carries it, as the socket hands it over', () => {
    expect(convexCode({ data: { code: 'SITE_BOOKED', rows: [] } })).toBe(
      'SITE_BOOKED',
    )
  })

  test('never reads a code out of a message', () => {
    for (const message of [
      'MATCHED_CLIENT',
      '[CONVEX M(jobs:create)] Uncaught Error: MATCHED_CLIENT at handler',
      'NOT_FOUND',
      'ArgumentValidationError: Object contains extra field `matchCheck`',
    ]) {
      expect(convexCode(new Error(message))).toBeNull()
    }
    // Where errorCode still finds its own codes, for words only.
    expect(errorCode(new Error('Uncaught Error: NOT_FOUND'))).toBe('NOT_FOUND')
    expect(convexCode(new Error('Uncaught Error: NOT_FOUND'))).toBeNull()
  })

  test('data that is neither a string nor an object with a string code is nothing', () => {
    expect(convexCode(new ConvexError({ code: 3 }))).toBeNull()
    expect(convexCode(new ConvexError({ rows: [] }))).toBeNull()
    expect(convexCode({ data: null })).toBeNull()
    expect(convexCode({ data: 42 })).toBeNull()
    expect(convexCode(null)).toBeNull()
    expect(convexCode(undefined)).toBeNull()
    expect(convexCode('SITE_BOOKED')).toBeNull()
  })
})

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
