import { describe, expect, test } from 'vitest'
import {
  EMAIL_BUDGET_BYTES,
  KEEP_ORIGINAL_RATIO,
  PHOTO_TIERS,
  REFERENCE_TIER,
  chooseTier,
  countImageMarkers,
  expectedCopyImages,
  fitWithin,
  pickSample,
  predictPhotoBytes,
  qualityFactor,
} from './emailFit'
import type { PhotoMeasure } from './emailFit'

/**
 * The arithmetic behind the lighter copy of a report too big to email.
 *
 * The numbers are the 30 Sept 2026 report's: 53 photos at 1200×1600, 647 KB
 * each on average as the phone saved them, about 95 KB each at the reference
 * size, and a PDF of 33.7 MiB that no email could carry.
 */

const KB = 1024
const MIB = 1024 * 1024

/** A photo off the phone, as that report's were. */
function phonePhoto(originalKB = 647, referenceKB?: number): PhotoMeasure {
  return {
    originalBytes: originalKB * KB,
    width: 1200,
    height: 1600,
    ...(referenceKB === undefined ? {} : { referenceBytes: referenceKB * KB }),
  }
}

describe('the tiers', () => {
  test('run from the lightest touch to the most, never growing a photo', () => {
    for (let i = 1; i < PHOTO_TIERS.length; i++) {
      expect(PHOTO_TIERS[i].edge).toBeLessThanOrEqual(PHOTO_TIERS[i - 1].edge)
      expect(PHOTO_TIERS[i].quality).toBeLessThanOrEqual(
        PHOTO_TIERS[i - 1].quality,
      )
    }
    // The first keeps every pixel of a phone photo; it only encodes them
    // sensibly.
    expect(PHOTO_TIERS[0].edge).toBe(1600)
    // The floor still prints at about 200 dpi on a 3-inch tile.
    expect(PHOTO_TIERS[PHOTO_TIERS.length - 1].edge / 3).toBeGreaterThanOrEqual(
      200,
    )
  })

  test('the reference is one of them, so a sample made at it can be reused', () => {
    expect(PHOTO_TIERS).toContainEqual(REFERENCE_TIER)
  })

  test('an email of the budget stays under the 10 MB a mail server may refuse', () => {
    // Base64 is 4/3, and a MIME line break every 76 characters adds 2 more.
    const onTheWire = ((EMAIL_BUDGET_BYTES * 4) / 3) * (78 / 76)
    expect(onTheWire).toBeLessThan(10_000_000)
  })
})

describe('what quality costs', () => {
  test('matches what mozjpeg was measured at', () => {
    expect(qualityFactor(75)).toBe(1)
    expect(qualityFactor(80)).toBeCloseTo(1.19)
    expect(qualityFactor(85)).toBeCloseTo(1.43)
    expect(qualityFactor(70)).toBeCloseTo(0.875)
  })

  test('is interpolated between, and held at the ends rather than guessed', () => {
    expect(qualityFactor(72)).toBeGreaterThan(qualityFactor(70))
    expect(qualityFactor(72)).toBeLessThan(qualityFactor(75))
    expect(qualityFactor(50)).toBe(qualityFactor(70))
    expect(qualityFactor(95)).toBe(qualityFactor(85))
  })
})

describe('the size a photo is encoded at', () => {
  test('keeps its shape, down to the edge', () => {
    expect(fitWithin(1200, 1600, 1000)).toEqual({ width: 750, height: 1000 })
    expect(fitWithin(1600, 1200, 800)).toEqual({ width: 800, height: 600 })
  })

  test('never enlarges: an annotated photo is only 640 wide', () => {
    expect(fitWithin(640, 853, 1000)).toEqual({ width: 640, height: 853 })
  })

  test('keeps a pixel on an extreme shape', () => {
    expect(fitWithin(8000, 3, 800)).toEqual({ width: 800, height: 1 })
  })
})

describe('what a photo is expected to weigh', () => {
  const photo = { ...phonePhoto(647), referenceBytes: 95 * KB }

  test('follows its pixel count at a fixed quality', () => {
    // 1000 → 800 px is 0.64 of the pixels.
    expect(predictPhotoBytes(photo, { edge: 800, quality: 75 })).toBeCloseTo(
      95 * KB * 0.64,
    )
  })

  test('and the quality', () => {
    // Every pixel (2.56× the reference's) at 85.
    expect(predictPhotoBytes(photo, { edge: 1600, quality: 85 })).toBeCloseTo(
      95 * KB * 2.56 * 1.43,
    )
  })

  test('is its own size when a re-encode would barely save anything', () => {
    // Already light: a re-encode at every pixel saves less than a tenth.
    const light = { ...phonePhoto(300), referenceBytes: 95 * KB }
    expect(predictPhotoBytes(light, PHOTO_TIERS[0])).toBe(300 * KB)
    expect(predictPhotoBytes(light, PHOTO_TIERS[3]) / (300 * KB)).toBeLessThan(
      KEEP_ORIGINAL_RATIO,
    )
  })

  test('is its own size when it could not be decoded', () => {
    expect(
      predictPhotoBytes(
        { ...photo, keep: true },
        PHOTO_TIERS[PHOTO_TIERS.length - 1],
      ),
    ).toBe(647 * KB)
  })
})

describe('which photos are the sample', () => {
  test('every one, when there are few', () => {
    expect(pickSample([phonePhoto(1), phonePhoto(2)]).sort()).toEqual([0, 1])
  })

  test('spread through the set, and always the largest', () => {
    const photos = Array.from({ length: 53 }, (_, i) =>
      phonePhoto(300 + i * 10),
    )
    const sample = pickSample(photos)
    expect(sample).toHaveLength(8)
    expect(sample).toContain(52)
    expect(sample).toContain(0)
  })
})

describe('the tier a report goes at', () => {
  // The budget left for the photos: the report's own pages and its cover
  // weigh what they weigh.
  const photoBudget = EMAIL_BUDGET_BYTES - 0.85 * MIB

  test('the 30 Sept report goes at 1000 px, the most that fits', () => {
    const photos = Array.from({ length: 52 }, (_, i) =>
      phonePhoto(647, i % 7 === 0 ? 95 : undefined),
    )
    const index = chooseTier(photos, photoBudget)
    expect(index).not.toBeNull()
    expect(PHOTO_TIERS[index!]).toEqual({ edge: 1000, quality: 75 })
  })

  test('a dozen photos keep every pixel, and a few more go one tier down', () => {
    const photos = (n: number) =>
      Array.from({ length: n }, () => phonePhoto(647, 95))
    expect(chooseTier(photos(12), photoBudget)).toBe(0)
    expect(chooseTier(photos(16), photoBudget)).toBe(1)
  })

  test('noisy photos, which shrink less, go a tier lower', () => {
    const typical = Array.from({ length: 40 }, () => phonePhoto(647, 95))
    const noisy = Array.from({ length: 40 }, () => phonePhoto(1161, 188))
    expect(chooseTier(noisy, photoBudget)!).toBeGreaterThan(
      chooseTier(typical, photoBudget)!,
    )
  })

  test('a report that cannot fit even at the floor is not tried', () => {
    const photos = Array.from({ length: 400 }, () => phonePhoto(647, 95))
    expect(chooseTier(photos, photoBudget)).toBeNull()
  })

  test('photos that could not be decoded count at their own size', () => {
    const photos = [
      ...Array.from({ length: 20 }, () => phonePhoto(647, 95)),
      { ...phonePhoto(4000), keep: true },
    ]
    const withUndecodable = chooseTier(photos, photoBudget)
    const without = chooseTier(photos.slice(0, 20), photoBudget)
    expect(withUndecodable!).toBeGreaterThan(without!)
  })
})

describe('counting the images in a PDF', () => {
  const text = (s: string) => new TextEncoder().encode(s)

  test('counts each image dictionary once', () => {
    const pdf = text(
      '<< /Type /XObject /Subtype /Image /Width 750 >> ... << /Subtype /Image >> << /Subtype /Form >>',
    )
    expect(countImageMarkers(pdf).count).toBe(2)
  })

  test('finds a marker split between two pieces of the file', () => {
    const whole = '<< /Subtype /Image >> xx << /Subtype /Image >>'
    for (let cut = 1; cut < whole.length; cut++) {
      const first = countImageMarkers(text(whole.slice(0, cut)))
      const second = countImageMarkers(text(whole.slice(cut)), first.carry)
      expect(first.count + second.count).toBe(2)
    }
  })

  test('a copy holds one image fewer for each pair of photos that came out the same', () => {
    expect(
      expectedCopyImages(12, [
        { url: 'a', contentKey: 'x' },
        { url: 'b', contentKey: 'x' },
        { url: 'c', contentKey: 'y' },
      ]),
    ).toBe(11)
    // The same file named twice was one image in the original too.
    expect(
      expectedCopyImages(12, [
        { url: 'a', contentKey: 'x' },
        { url: 'a', contentKey: 'x' },
      ]),
    ).toBe(12)
  })
})
