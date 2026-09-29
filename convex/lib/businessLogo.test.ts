import { describe, expect, test } from 'vitest'
import {
  EMAIL_LOGO,
  MAX_LOGO_BYTES,
  emailCardSize,
  fitEmailLogo,
  isEmailCardSize,
  logoFileRefusal,
  logoFilesOf,
} from './businessLogo'
import type { Id } from '../_generated/dataModel'

describe('a logo’s size in an email', () => {
  test('a wide lockup fills the width, a square mark the height', () => {
    // Pest M8's lockup, trimmed: 1246 × 326.
    expect(fitEmailLogo(1246, 326)).toEqual({ width: 200, height: 52 })
    // A square mark stops at the height, not the width.
    expect(fitEmailLogo(600, 600)).toEqual({ width: 56, height: 56 })
    // A tall one too.
    expect(fitEmailLogo(300, 900)).toEqual({ width: 19, height: 56 })
    // A small logo is brought up to the box rather than left a speck.
    expect(fitEmailLogo(100, 25)).toEqual({ width: 200, height: 50 })
  })

  test('its card is the logo and the margin round it', () => {
    expect(emailCardSize({ width: 200, height: 52 })).toEqual({
      width: 200 + 2 * EMAIL_LOGO.padding,
      height: 52 + 2 * EMAIL_LOGO.padding,
    })
  })

  test('only a size a card could have is taken', () => {
    expect(isEmailCardSize({ width: 220, height: 72 })).toBe(true)
    expect(isEmailCardSize({ width: 76, height: 76 })).toBe(true)
    // Bigger than the box and its margin: nothing drawn here is that big.
    expect(isEmailCardSize({ width: 800, height: 360 })).toBe(false)
    // No room for a logo inside the margin.
    expect(isEmailCardSize({ width: 20, height: 72 })).toBe(false)
    expect(isEmailCardSize({ width: 220.5, height: 72 })).toBe(false)
    expect(isEmailCardSize({ width: Number.NaN, height: 72 })).toBe(false)
  })
})

describe('what file may be a logo', () => {
  test('a PNG or a JPEG, which the PDF can draw', () => {
    expect(logoFileRefusal({ contentType: 'image/png', size: 100 })).toBeNull()
    expect(logoFileRefusal({ contentType: 'image/jpeg', size: 100 })).toBeNull()
    expect(
      logoFileRefusal({ contentType: 'Image/PNG; charset=binary', size: 100 }),
    ).toBeNull()
  })

  test('not a GIF, a WebP or an SVG: the PDF prints nothing for those', () => {
    for (const contentType of ['image/gif', 'image/webp', 'image/svg+xml']) {
      expect(logoFileRefusal({ contentType, size: 100 })).toBe(
        'WRONG_FILE_TYPE',
      )
    }
    expect(logoFileRefusal({ contentType: 'application/pdf', size: 100 })).toBe(
      'WRONG_FILE_TYPE',
    )
  })

  test('an upload sent with no type is let through, as a product’s is', () => {
    expect(logoFileRefusal({ size: 100 })).toBeNull()
  })

  test('and nothing the size of a photo library', () => {
    expect(
      logoFileRefusal({ contentType: 'image/png', size: MAX_LOGO_BYTES + 1 }),
    ).toBe('FILE_TOO_LARGE')
  })
})

describe('the files a business’s logos use', () => {
  const id = (n: number) => `kg2${n}` as Id<'_storage'>

  test('every one of them, and only the ones in use', () => {
    expect(logoFilesOf({})).toEqual([])
    expect(
      logoFilesOf({
        logoStorageId: id(1),
        logoEmail: { storageId: id(2), width: 220, height: 72 },
        logoOnDark: {
          storageId: id(3),
          email: { storageId: id(4), width: 220, height: 72 },
        },
      }),
    ).toEqual([id(1), id(2), id(3), id(4)])
  })
})
