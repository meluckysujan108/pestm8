import { describe, expect, test } from 'vitest'
import {
  DRAWN_AT_SKEW_MS,
  MAX_SIGNATURE_IMAGE_BYTES,
  MAX_SIGNATURE_STROKES_BYTES,
  signatureFileRefusal,
  signedAtOf,
} from './signatures'

describe('a file offered as a signature', () => {
  test('is the PNG the pad makes, or has no type at all', () => {
    expect(
      signatureFileRefusal({ contentType: 'image/png', size: 40_000 }, 'image'),
    ).toBeNull()
    expect(signatureFileRefusal({ size: 40_000 }, 'image')).toBeNull()
    expect(
      signatureFileRefusal(
        { contentType: 'Image/PNG; foo=bar', size: 40_000 },
        'image',
      ),
    ).toBeNull()
    for (const contentType of [
      'image/jpeg',
      'image/svg+xml',
      'text/html',
      'application/pdf',
    ]) {
      expect(signatureFileRefusal({ contentType, size: 40_000 }, 'image')).toBe(
        'WRONG_FILE_TYPE',
      )
    }
  })

  test('keeps its strokes as JSON', () => {
    expect(
      signatureFileRefusal(
        { contentType: 'application/json', size: 20_000 },
        'strokes',
      ),
    ).toBeNull()
    expect(signatureFileRefusal({ size: 20_000 }, 'strokes')).toBeNull()
    expect(
      signatureFileRefusal(
        { contentType: 'image/png', size: 20_000 },
        'strokes',
      ),
    ).toBe('WRONG_FILE_TYPE')
  })

  test('is refused when it is far bigger than any signature', () => {
    expect(
      signatureFileRefusal(
        { contentType: 'image/png', size: MAX_SIGNATURE_IMAGE_BYTES + 1 },
        'image',
      ),
    ).toBe('FILE_TOO_LARGE')
    expect(
      signatureFileRefusal(
        {
          contentType: 'application/json',
          size: MAX_SIGNATURE_STROKES_BYTES + 1,
        },
        'strokes',
      ),
    ).toBe('FILE_TOO_LARGE')
  })
})

describe('when a signature was signed', () => {
  const now = Date.UTC(2026, 9, 3, 2, 0)
  const notBefore = Date.UTC(2026, 9, 3, 0, 0)

  test('is now, when the phone does not say', () => {
    expect(signedAtOf(undefined, { now, notBefore })).toEqual({ signedAt: now })
  })

  test('is when it was drawn, kept with when it arrived, for one held on the phone', () => {
    const drawnAt = now - 90 * 60 * 1000
    expect(signedAtOf(drawnAt, { now, notBefore })).toEqual({
      signedAt: drawnAt,
      receivedAt: now,
    })
  })

  test('is never later than it arrived: a phone a little fast is taken as now', () => {
    expect(signedAtOf(now + 30_000, { now, notBefore })).toEqual({
      signedAt: now,
    })
    expect(signedAtOf(now, { now, notBefore })).toEqual({ signedAt: now })
  })

  test('is now when the phone’s time could not be true', () => {
    // Before the report existed.
    expect(signedAtOf(notBefore - 1, { now, notBefore })).toEqual({
      signedAt: now,
    })
    // Further ahead than a phone's clock drifts.
    expect(signedAtOf(now + DRAWN_AT_SKEW_MS + 1, { now, notBefore })).toEqual({
      signedAt: now,
    })
    expect(signedAtOf(Number.NaN, { now, notBefore })).toEqual({
      signedAt: now,
    })
  })
})
