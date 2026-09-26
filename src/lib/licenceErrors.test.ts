import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { describeError } from '#/components/forms/describeError'
import { licenceErrorCopy, licenceRefusal } from './licenceErrors'
import { SWITCH_ENDED } from './productErrors'
import type { LicenceAction } from './licenceErrors'

/**
 * Every refusal `convex/memberLicences.ts` (and the upload claim it shares
 * with the Phase 8.1 document) can make has words of its own, not the
 * generic "Could not save".
 */

const SERVER_CODES = [
  'NO_ACCESS',
  'NOT_FOUND',
  'FILE_NOT_FOUND',
  'ALREADY_ATTACHED',
  'WRONG_FILE_TYPE',
  'FILE_TOO_LARGE',
  'TOO_MANY_LICENCES',
  'TOO_MANY_FILES',
  'INVALID_NAME',
  'INVALID_NUMBER',
  'INVALID_DATE',
]

const ACTIONS: Array<LicenceAction> = [
  'add',
  'save',
  'delete',
  'upload',
  'removeFile',
  'load',
]

describe('licenceErrorCopy', () => {
  test.each(SERVER_CODES)('%s has its own words', (code) => {
    const copy = licenceErrorCopy('save')
    const words = describeError(new ConvexError(code), copy)
    expect(words).not.toBe(copy.default)
    expect(words).toBe(copy[code])
  })

  test('the limits are the rules’ own numbers', () => {
    const copy = licenceErrorCopy('upload')
    expect(copy.TOO_MANY_FILES).toContain('up to 6 files')
    expect(copy.TOO_MANY_LICENCES).toContain('up to 20 licences')
    expect(copy.FILE_TOO_LARGE).toContain('20 MB')
    expect(copy.FILE_TOO_LARGE).toContain('10 MB')
    expect(copy.INVALID_NAME).toContain('80 characters')
  })

  test('a lapsed switch says what happened', () => {
    expect(
      describeError(new ConvexError('SWITCH_EXPIRED'), licenceErrorCopy('add')),
    ).toBe(SWITCH_ENDED)
  })

  test.each(ACTIONS)(
    'anything else, while %s, gets that action’s words',
    (action) => {
      const copy = licenceErrorCopy(action)
      expect(describeError(new Error('boom'), copy)).toBe(copy.default)
    },
  )

  test('the page’s own checks read as the server’s would', () => {
    const copy = licenceErrorCopy('upload')
    expect(describeError(licenceRefusal('WRONG_FILE_TYPE'), copy)).toBe(
      copy.WRONG_FILE_TYPE,
    )
  })

  test('an upload given up on, and a save not yet confirmed, say which', () => {
    const copy = licenceErrorCopy('upload')
    for (const code of ['UPLOAD_STALLED', 'ADD_FILE_UNCONFIRMED']) {
      const words = describeError(licenceRefusal(code), copy)
      expect(words).toBe(copy[code])
      expect(words).not.toBe(copy.offline)
      expect(words).not.toBe(copy.default)
    }
  })

  test('no signal before anything was sent says so', () => {
    const copy = licenceErrorCopy('upload')
    expect(describeError(new Error('offline'), copy)).toBe(copy.offline)
    expect(describeError(new Error('Timed out'), copy)).toBe(copy.offline)
  })
})
