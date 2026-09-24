import { describe, expect, test } from 'vitest'
import { heldPdfUsable, isGestureExpired, preparingLabel } from './shareGesture'
import type { HeldPdf } from './shareGesture'

describe('isGestureExpired', () => {
  test('NotAllowedError, however it was made', () => {
    expect(
      isGestureExpired(new DOMException('no activation', 'NotAllowedError')),
    ).toBe(true)
    const plain = new Error('no activation')
    plain.name = 'NotAllowedError'
    expect(isGestureExpired(plain)).toBe(true)
  })

  test('anything else is a real failure', () => {
    expect(isGestureExpired(new DOMException('closed', 'AbortError'))).toBe(
      false,
    )
    expect(isGestureExpired(new TypeError('bad data'))).toBe(false)
    expect(isGestureExpired('NotAllowedError')).toBe(false)
    expect(isGestureExpired(null)).toBe(false)
  })
})

describe('preparingLabel', () => {
  test('no size known yet: no number', () => {
    expect(preparingLabel(null)).toBe('Preparing…')
    expect(preparingLabel({ loaded: 5000, total: null })).toBe('Preparing…')
    expect(preparingLabel({ loaded: 0, total: 0 })).toBe('Preparing…')
  })

  test('a percentage, rounded down', () => {
    expect(preparingLabel({ loaded: 0, total: 1000 })).toBe('Preparing… 0%')
    expect(preparingLabel({ loaded: 409, total: 1000 })).toBe('Preparing… 40%')
  })

  test('100 only once every byte is in', () => {
    expect(preparingLabel({ loaded: 999, total: 1000 })).toBe('Preparing… 99%')
    expect(preparingLabel({ loaded: 1000, total: 1000 })).toBe(
      'Preparing… 100%',
    )
  })
})

describe('heldPdfUsable', () => {
  const B = 'https://files.example/b'
  const blob = new Blob(['%PDF-'])
  /** The file's current bytes, fetched this visit. */
  const current: HeldPdf = { url: B, blob, current: true }
  /** An older kept copy (file A) held in B's place while there was no signal. */
  const stale: HeldPdf = { url: B, blob, current: false }
  const at = (online: boolean, again = false, url: string | null = B) => ({
    url,
    online,
    again,
  })

  test('the current bytes, whenever they are for this URL', () => {
    expect(heldPdfUsable(current, at(true))).toBe(true)
    expect(heldPdfUsable(current, at(false))).toBe(true)
    expect(
      heldPdfUsable(current, at(true, false, 'https://files.example/c')),
    ).toBe(false)
    expect(heldPdfUsable(null, at(true))).toBe(false)
  })

  test('an older kept copy with no signal: the best there is', () => {
    expect(heldPdfUsable(stale, at(false))).toBe(true)
  })

  test('an older kept copy once the signal is back: fetch the current file', () => {
    expect(heldPdfUsable(stale, at(true))).toBe(false)
  })

  test('an older kept copy offered for "Tap to share": that tap gets it', () => {
    expect(heldPdfUsable(stale, at(true, true))).toBe(true)
  })

  test('a PDF gone from the server: the kept copy is all there is', () => {
    const gone: HeldPdf = { url: null, blob, current: false }
    expect(heldPdfUsable(gone, at(true, false, null))).toBe(true)
  })
})
