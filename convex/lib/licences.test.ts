import { describe, expect, test } from 'vitest'
import {
  MAX_LICENCE_FILE_NAME_LENGTH,
  MAX_LICENCE_IMAGE_BYTES,
  MAX_LICENCE_PDF_BYTES,
  checkLicenceFile,
  cleanLicenceFileName,
  licenceTypeOf,
} from './licences'

const PDF = { kind: 'pdf', contentType: 'application/pdf' } as const
const PNG = { kind: 'image', contentType: 'image/png' } as const
const JPEG = { kind: 'image', contentType: 'image/jpeg' } as const

describe('licenceTypeOf', () => {
  test('the stored type decides, parameters and case aside', () => {
    expect(licenceTypeOf('application/pdf', 'x.png')).toEqual(PDF)
    expect(licenceTypeOf('Application/PDF; charset=binary', '')).toEqual(PDF)
    expect(licenceTypeOf('image/png', 'x.pdf')).toEqual(PNG)
    expect(licenceTypeOf('image/jpeg', '')).toEqual(JPEG)
    expect(licenceTypeOf('image/jpg', '')).toEqual(JPEG)
  })

  test('a wrong type is never overruled by the name', () => {
    for (const type of [
      'image/heic',
      'image/svg+xml',
      'image/gif',
      'text/html',
      'application/octet-stream',
    ]) {
      expect(licenceTypeOf(type, 'licence.pdf')).toBeNull()
    }
  })

  test('with no type at all, the extension', () => {
    expect(licenceTypeOf(undefined, 'licence.PDF')).toEqual(PDF)
    expect(licenceTypeOf('', 'card.png')).toEqual(PNG)
    expect(licenceTypeOf(undefined, 'card.JPG')).toEqual(JPEG)
    expect(licenceTypeOf(undefined, 'card.jpeg')).toEqual(JPEG)
    expect(licenceTypeOf(undefined, 'card.heic')).toBeNull()
    expect(licenceTypeOf(undefined, 'card')).toBeNull()
    expect(licenceTypeOf(undefined, 'card.pdf.exe')).toBeNull()
  })
})

describe('checkLicenceFile', () => {
  test('each kind has its own ceiling', () => {
    expect(
      checkLicenceFile(
        { contentType: 'application/pdf', size: MAX_LICENCE_PDF_BYTES },
        '',
      ),
    ).toEqual({ ok: true, type: PDF })
    expect(
      checkLicenceFile(
        { contentType: 'application/pdf', size: MAX_LICENCE_PDF_BYTES + 1 },
        '',
      ),
    ).toEqual({ ok: false, refusal: 'FILE_TOO_LARGE' })
    expect(
      checkLicenceFile(
        { contentType: 'image/png', size: MAX_LICENCE_IMAGE_BYTES + 1 },
        '',
      ),
    ).toEqual({ ok: false, refusal: 'FILE_TOO_LARGE' })
  })

  test('the type is refused before the size', () => {
    expect(
      checkLicenceFile({ contentType: 'video/mp4', size: 1e9 }, 'x.pdf'),
    ).toEqual({ ok: false, refusal: 'WRONG_FILE_TYPE' })
  })
})

describe('cleanLicenceFileName', () => {
  test('ends in the extension of what it is', () => {
    expect(cleanLicenceFileName('IMG_0412.JPEG', JPEG)).toBe('IMG_0412.jpg')
    expect(cleanLicenceFileName('licence', PDF)).toBe('licence.pdf')
    expect(cleanLicenceFileName('scan.png', PDF)).toBe('scan.pdf')
  })

  test('tidies what a share sheet would choke on', () => {
    expect(cleanLicenceFileName(' WA/2024‮fdp.exe.pdf ', PDF)).toBe(
      'WA-2024fdp.exe.pdf',
    )
    expect(cleanLicenceFileName('...', PNG)).toBe('Licence.png')
    expect(cleanLicenceFileName('', JPEG)).toBe('Licence.jpg')
  })

  test('fits the limit without splitting a character', () => {
    const name = cleanLicenceFileName(`${'😀'.repeat(150)}.pdf`, PDF)
    expect(name.length).toBeLessThanOrEqual(MAX_LICENCE_FILE_NAME_LENGTH)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(() => encodeURIComponent(name)).not.toThrow()
  })
})
