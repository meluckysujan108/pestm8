import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import {
  PDF_LIMIT_MB,
  PHOTO_LIMIT_MB,
  SWITCH_ENDED,
  pickRefusalMessage,
  productErrorCode,
  productErrorMessage,
  uploadsSpent,
} from './productErrors'
import { FileTransferError } from './pdfFiles'

const refused = (code: string) => new ConvexError(code)

describe('productErrorMessage', () => {
  test.each([
    ['PRODUCT_EXISTS', "There's already a product with that name."],
    ['FILE_NOT_FOUND', 'That upload took too long — pick the file again.'],
    [
      'NO_ACCESS',
      'Only the person who added this product, or the owner, can change it.',
    ],
  ])('%s has the words the page was asked for', (code, words) => {
    expect(productErrorMessage(refused(code), 'replace')).toBe(words)
  })

  test('an expired upload in a Save says to tap Save, not to pick again', () => {
    // The draft still holds the file and the upload memo has let it go, so
    // Save sends it afresh; "pick the file again" would not help.
    expect(productErrorMessage(refused('FILE_NOT_FOUND'), 'save')).toBe(
      'The upload took too long to reach the server. Tap Save to send it again.',
    )
  })

  test.each([
    'INVALID_PRODUCT',
    'INVALID_URL',
    'PRODUCT_EXISTS',
    'TOO_MANY_PRODUCTS',
    'FILE_NOT_FOUND',
    'ALREADY_ATTACHED',
    'FILE_TOO_LARGE',
    'WRONG_FILE_TYPE',
    'NOT_FOUND',
    'NO_ACCESS',
  ])('%s never falls through to the generic sentence', (code) => {
    const words = productErrorMessage(refused(code))
    expect(words).not.toMatch(/Check your signal/)
    expect(words).not.toContain(code)
  })

  test('quotes the limits the server enforces', () => {
    expect(productErrorMessage(refused('TOO_MANY_PRODUCTS'))).toContain('200')
    expect(productErrorMessage(refused('FILE_TOO_LARGE'))).toContain(
      `${PDF_LIMIT_MB} MB`,
    )
    expect(PDF_LIMIT_MB).toBe(20)
    expect(PHOTO_LIMIT_MB).toBe(10)
    expect(productErrorMessage(refused('INVALID_PRODUCT'))).toContain('2,000')
  })

  test.each([
    'SWITCH_EXPIRED',
    'SWITCH_REVOKED',
    'SWITCH_TEAM_CHANGED',
    'SWITCH_TARGET_INACTIVE',
    'SWITCH_NOT_PERMITTED',
    'SWITCH_CHAINED',
  ])('%s says the switch ended', (code) => {
    expect(productErrorMessage(refused(code))).toBe(SWITCH_ENDED)
  })

  test('a delete of something already gone says so', () => {
    expect(productErrorMessage(refused('NOT_FOUND'), 'delete')).toBe(
      'This product was already deleted.',
    )
  })

  test('an upload that failed says why in its own words', () => {
    const error = new FileTransferError(
      'network',
      'The upload did not get through. Check your signal and try again.',
    )
    expect(productErrorMessage(error)).toBe(error.message)
  })

  test('anything else gets the sentence for what was being done', () => {
    expect(productErrorMessage(new Error('Server Error'))).toMatch(
      /^Could not save this product/,
    )
    expect(productErrorMessage(refused('SOMETHING_NEW'), 'replace')).toMatch(
      /^Could not replace the PDF/,
    )
    expect(productErrorMessage(null, 'delete')).toMatch(
      /^Could not delete this product/,
    )
  })
})

describe('productErrorCode', () => {
  test('reads the code off a Convex refusal only', () => {
    expect(productErrorCode(refused('NOT_FOUND'))).toBe('NOT_FOUND')
    expect(productErrorCode(new ConvexError({ code: 'X' }))).toBeNull()
    expect(productErrorCode(new Error('NOT_FOUND'))).toBeNull()
  })
})

describe('uploadsSpent', () => {
  test('only when the server will not take the same uploads again', () => {
    expect(uploadsSpent(refused('FILE_NOT_FOUND'))).toBe(true)
    expect(uploadsSpent(refused('ALREADY_ATTACHED'))).toBe(true)
    expect(uploadsSpent(refused('PRODUCT_EXISTS'))).toBe(false)
    expect(uploadsSpent(new Error('x'))).toBe(false)
  })
})

describe('pickRefusalMessage', () => {
  test('a PDF too big quotes the limit', () => {
    expect(pickRefusalMessage('pdf', 'FILE_TOO_LARGE')).toContain('20 MB')
  })

  test('a file that is not a PDF, however it was caught', () => {
    expect(pickRefusalMessage('pdf', 'WRONG_FILE_TYPE')).toMatch(
      /^That file isn't a PDF/,
    )
    expect(pickRefusalMessage('pdf', 'NOT_A_PDF')).toMatch(
      /^That file isn't a PDF/,
    )
  })

  test('photos', () => {
    expect(pickRefusalMessage('photo', 'FILE_TOO_LARGE')).toContain('10 MB')
    expect(pickRefusalMessage('photo', 'WRONG_FILE_TYPE')).toMatch(
      /^That file isn't a photo/,
    )
  })
})
