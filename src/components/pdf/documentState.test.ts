import { describe, expect, it } from 'vitest'
import {
  DAMAGED,
  LOADING,
  askPassword,
  checkPassword,
  downloadFailed,
  plainWords,
} from './documentState'

/**
 * A locked PDF's password round trip. The rule that matters: trying a
 * password never leaves the password phase, because leaving it unmounts the
 * field and takes the iPhone's keyboard with it (see `checkPassword`).
 */

describe('password', () => {
  it('is asked for, not yet refused', () => {
    expect(askPassword(false)).toEqual({
      phase: 'password',
      wrong: false,
      checking: false,
    })
  })

  it('stays on the form while pdf.js tries it', () => {
    const trying = checkPassword(askPassword(false))
    expect(trying).toEqual({ phase: 'password', wrong: false, checking: true })
    // A second Open while the first is out changes nothing.
    expect(checkPassword(trying)).toBe(trying)
  })

  it('comes back to the same form, refused, when it is wrong', () => {
    const trying = checkPassword(askPassword(true))
    // Still marked wrong from the last try while this one is checked; the
    // form hides the message until the answer is in.
    expect(trying).toMatchObject({ phase: 'password', checking: true })
    expect(askPassword(true)).toEqual({
      phase: 'password',
      wrong: true,
      checking: false,
    })
  })

  it('leaves any other phase alone', () => {
    expect(checkPassword(LOADING)).toBe(LOADING)
    expect(checkPassword(DAMAGED)).toBe(DAMAGED)
  })
})

describe('downloadFailed', () => {
  it('keeps the words a source rejected with, which know why it failed', () => {
    // A draft preview asked for while the report was being locked elsewhere:
    // "check your signal" would send someone to find signal, and "Try again"
    // would fail the same way every time.
    const locked =
      'This report has just been locked. Close this and open the finished document.'
    expect(downloadFailed(new Error(locked))).toEqual({
      phase: 'error',
      reason: 'download',
      detail: locked,
    })
    // A subclass with a name of its own is still a source's words.
    class FileTransferError extends Error {
      name = 'FileTransferError'
    }
    expect(
      plainWords(new FileTransferError('The file is no longer there.')),
    ).toBe('The file is no longer there.')
  })

  it('leaves the platform’s own failures to the viewer’s sentence', () => {
    expect(plainWords(new TypeError('Load failed'))).toBeNull()
    expect(
      plainWords(new DOMException('The operation was aborted.', 'AbortError')),
    ).toBeNull()
    expect(
      plainWords(new DOMException('Quota exceeded', 'QuotaExceededError')),
    ).toBeNull()
    expect(
      plainWords(
        new Error(
          '[CONVEX A(reportPdf:preview)] [Request ID: 1a2b] Server Error',
        ),
      ),
    ).toBeNull()
    expect(plainWords(new Error('   '))).toBeNull()
    expect(plainWords('offline')).toBeNull()
    expect(plainWords(undefined)).toBeNull()
    expect(downloadFailed(new TypeError('Failed to fetch'))).toEqual({
      phase: 'error',
      reason: 'download',
      detail: null,
    })
  })
})
