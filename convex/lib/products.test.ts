import { describe, expect, test } from 'vitest'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_FILE_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PDF_BYTES,
  MAX_PHOTO_BYTES,
  MAX_URL_LENGTH,
  checkPdfFile,
  checkPhotoFile,
  cleanDescription,
  cleanPdfFileName,
  cleanProductName,
  nameKeyOf,
  normaliseProductUrl,
} from './products'

/**
 * Phase 7.1: the rules a product is held to, pure so the Products page can
 * apply the same ones as it is typed into.
 *
 * The link rules matter most. A product's link is shown to every member of
 * the business and tapped, copied and shared onwards, so whatever one member
 * saves is something every other member's phone will open. The file checks
 * are tested here rather than through the mutations because convex-test
 * stores a file without a content type — through `create`, every upload looks
 * like one whose browser did not say what it was.
 */

describe('a product link', () => {
  test.each([
    ['https://www.termidor.com.au/sds', 'https://www.termidor.com.au/sds'],
    ['http://brand.com.au/label.pdf', 'http://brand.com.au/label.pdf'],
    ['HTTPS://Brand.COM.au/Label', 'https://brand.com.au/Label'],
    ['  https://brand.com.au/x  ', 'https://brand.com.au/x'],
  ])('%s is kept as %s', (typed, stored) => {
    expect(normaliseProductUrl(typed)).toBe(stored)
  })

  test.each([
    ['brand.com.au', 'https://brand.com.au/'],
    [
      'www.brand.com.au/products/termidor',
      'https://www.brand.com.au/products/termidor',
    ],
    ['brand.com.au:8080/sds', 'https://brand.com.au:8080/sds'],
    ['//brand.com.au/sds', 'https://brand.com.au/sds'],
  ])(
    'a bare %s is how one gets typed on a phone, and gets https in front',
    (typed, stored) => {
      expect(normaliseProductUrl(typed)).toBe(stored)
    },
  )

  test('spaces inside are escaped, so what is stored can be opened as it is', () => {
    expect(normaliseProductUrl('brand.com.au/safety data sheet.pdf')).toBe(
      'https://brand.com.au/safety%20data%20sheet.pdf',
    )
  })

  test.each([
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    // A host, a dot, and still a script: only the scheme gives it away.
    'javascript://brand.com.au/%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:application/pdf;base64,JVBERi0=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://files.brand.com.au/sds.pdf',
    'mailto:sales@brand.com.au',
    'tel:0893351000',
    'blob:https://brand.com.au/1234',
  ])('%s is refused: only a web page is a product link', (typed) => {
    expect(normaliseProductUrl(typed)).toBeNull()
  })

  test.each([
    'localhost',
    'localhost:3000',
    'https://intranet/sds',
    'termidor',
    'http://',
    'https://',
    'brand .com.au',
    'https://bra nd.com.au',
  ])('%s is refused: nowhere a colleague’s phone can go', (typed) => {
    expect(normaliseProductUrl(typed)).toBeNull()
  })

  test('a user name in front of the host is refused — it reads as one site and opens another', () => {
    expect(
      normaliseProductUrl('https://www.termidor.com.au@example.com/sds'),
    ).toBeNull()
    expect(normaliseProductUrl('https://user:pass@brand.com.au/')).toBeNull()
  })

  test.each(['', '   ', '\n\t'])(
    '%j is no link at all, not a refused one',
    (typed) => {
      expect(normaliseProductUrl(typed)).toBeUndefined()
    },
  )

  test('fits MAX_URL_LENGTH as typed and as stored', () => {
    const base = 'https://brand.com.au/'
    const longest = base + 'a'.repeat(MAX_URL_LENGTH - base.length)
    expect(normaliseProductUrl(longest)).toBe(longest)
    expect(normaliseProductUrl(`${longest}a`)).toBeNull()

    // Too long typed, short once parsed: `new URL` resolves every "./" away
    // and stores "https://brand.com.au/". Only the typed check refuses it, so
    // this is the line that fails if that check goes.
    const dotted = base + './'.repeat(1100)
    expect(dotted.length).toBeGreaterThan(MAX_URL_LENGTH)
    expect(new URL(dotted).href).toBe(base)
    expect(normaliseProductUrl(dotted)).toBeNull()

    // Short enough typed, too long once its spaces are escaped.
    const spaced = base + ' '.repeat(MAX_URL_LENGTH - base.length - 1) + 'a'
    expect(spaced.length).toBeLessThanOrEqual(MAX_URL_LENGTH)
    expect(normaliseProductUrl(spaced)).toBeNull()

    // Bare, it is the stored form that counts: https:// takes eight more.
    const bare = 'brand.com.au/' + 'a'.repeat(MAX_URL_LENGTH - 13)
    expect(bare.length).toBe(MAX_URL_LENGTH)
    expect(normaliseProductUrl(bare)).toBeNull()
  })
})

describe('a product name', () => {
  test('folds to one key whatever the case and spacing', () => {
    const key = nameKeyOf('Termidor Residual')
    expect(key).toBe('termidor residual')
    for (const typed of [
      'termidor residual',
      '  TERMIDOR RESIDUAL ',
      'Termidor   Residual',
      'Termidor\tResidual',
      'Termidor\u00a0Residual',
    ]) {
      expect(nameKeyOf(typed), JSON.stringify(typed)).toBe(key)
    }
    expect(nameKeyOf('Termidor Residual 2')).not.toBe(key)
  })

  test('is stored trimmed, with its inner spacing as typed', () => {
    expect(cleanProductName('  Termidor  Residual ')).toBe('Termidor  Residual')
  })

  test('is required, and fits MAX_NAME_LENGTH once trimmed', () => {
    expect(cleanProductName('')).toBeNull()
    expect(cleanProductName('   ')).toBeNull()
    expect(cleanProductName('x'.repeat(MAX_NAME_LENGTH))).toBe(
      'x'.repeat(MAX_NAME_LENGTH),
    )
    expect(cleanProductName(` ${'x'.repeat(MAX_NAME_LENGTH)} `)).toBe(
      'x'.repeat(MAX_NAME_LENGTH),
    )
    expect(cleanProductName('x'.repeat(MAX_NAME_LENGTH + 1))).toBeNull()
  })
})

describe('a product description', () => {
  test('is trimmed, and blank is none at all', () => {
    expect(cleanDescription('  Termite barrier.  ')).toBe('Termite barrier.')
    expect(cleanDescription('')).toBeUndefined()
    expect(cleanDescription(' \n ')).toBeUndefined()
  })

  test('fits MAX_DESCRIPTION_LENGTH once trimmed', () => {
    const longest = 'x'.repeat(MAX_DESCRIPTION_LENGTH)
    expect(cleanDescription(`\n${longest}\n`)).toBe(longest)
    expect(cleanDescription(`${longest}x`)).toBeNull()
  })
})

describe('a PDF’s file name', () => {
  test('is the name it had on the phone', () => {
    expect(cleanPdfFileName('Termidor SDS 2024.pdf', 'Termidor')).toBe(
      'Termidor SDS 2024.pdf',
    )
  })

  test('always ends in a lower-case .pdf', () => {
    expect(cleanPdfFileName('Termidor SDS', 'Termidor')).toBe(
      'Termidor SDS.pdf',
    )
    expect(cleanPdfFileName('LABEL.PDF', 'Termidor')).toBe('LABEL.pdf')
    expect(cleanPdfFileName('scan.pdf.jpg', 'Termidor')).toBe(
      'scan.pdf.jpg.pdf',
    )
  })

  test('has no path in it, and no control characters', () => {
    expect(cleanPdfFileName('../../etc/passwd', 'Termidor')).toBe(
      '..-..-etc-passwd.pdf',
    )
    expect(cleanPdfFileName('C:\\fakepath\\sds.pdf', 'Termidor')).toBe(
      'C:-fakepath-sds.pdf',
    )
    expect(cleanPdfFileName('sds\u0000\u001b[31m\u007f.pdf', 'Termidor')).toBe(
      'sds[31m.pdf',
    )
    expect(cleanPdfFileName('  sds \r\n.pdf ', 'Termidor')).toBe('sds.pdf')
  })

  test('has none of the other invisible characters that break or turn a name around', () => {
    // C1 controls (NEL among them, which `trim` leaves alone), the Unicode
    // line and paragraph separators, and the bidi controls — an RLO in
    // "sds\u202efdp.exe" shows a share sheet "sdsexe.pdf".
    for (const [typed, kept] of [
      ['SDS\u0085v2.pdf', 'SDSv2.pdf'],
      ['Label\u0080\u0090\u009f.pdf', 'Label.pdf'],
      ['SDS\u2028v2\u2029.pdf', 'SDSv2.pdf'],
      ['sds\u202efdp.exe', 'sdsfdp.exe.pdf'],
      ['\u202a\u202b\u202c\u202d\u202eSDS.pdf', 'SDS.pdf'],
      ['\u2066\u2067\u2068\u2069SDS.pdf', 'SDS.pdf'],
      ['\u200eSDS\u200f\u061c.pdf', 'SDS.pdf'],
      ['\u0085 SDS \u0085', 'SDS.pdf'],
    ]) {
      expect(cleanPdfFileName(typed, 'Termidor'), JSON.stringify(typed)).toBe(
        kept,
      )
    }
    // Nothing but those is no name at all: the product's.
    expect(cleanPdfFileName('\u0085\u2028\u202e', 'Termidor')).toBe(
      'Termidor.pdf',
    )
    // And the fallback is tidied the same way.
    expect(cleanPdfFileName('', 'Termidor\u202e')).toBe('Termidor.pdf')

    // What is left is ordinary text: accents, other scripts and emoji stay.
    expect(cleanPdfFileName('Fiche sécurité — 防蟻 🐜.pdf', 'Termidor')).toBe(
      'Fiche sécurité — 防蟻 🐜.pdf',
    )
  })

  test('falls back to the product’s own name, tidied the same way', () => {
    expect(cleanPdfFileName('', 'Termidor')).toBe('Termidor.pdf')
    expect(cleanPdfFileName('   ', 'Termidor')).toBe('Termidor.pdf')
    expect(cleanPdfFileName('.pdf', 'Termidor')).toBe('Termidor.pdf')
    expect(cleanPdfFileName('...', 'Termidor')).toBe('Termidor.pdf')
    expect(cleanPdfFileName('\u0000', 'Termidor')).toBe('Termidor.pdf')
    expect(cleanPdfFileName('', 'Termidor 100 g/L')).toBe(
      'Termidor 100 g-L.pdf',
    )
    // A product called nothing but dots still gets a file name.
    expect(cleanPdfFileName('', '...')).toBe('Product.pdf')
  })

  test('fits MAX_FILE_NAME_LENGTH, .pdf included', () => {
    const long = 'x'.repeat(500)
    const cut = cleanPdfFileName(`${long}.pdf`, 'Termidor')
    expect(cut).toHaveLength(MAX_FILE_NAME_LENGTH)
    expect(cut.endsWith('x.pdf')).toBe(true)
    expect(cleanPdfFileName(long, 'Termidor')).toBe(cut)

    const exact = `${'x'.repeat(MAX_FILE_NAME_LENGTH - 4)}.pdf`
    expect(cleanPdfFileName(exact, 'Termidor')).toBe(exact)
  })

  test('is never cut through the middle of a character', () => {
    // Each emoji is two UTF-16 units; 195 x's leave one unit of room.
    const name = `${'x'.repeat(MAX_FILE_NAME_LENGTH - 5)}🐜🐜.pdf`
    const cut = cleanPdfFileName(name, 'Termidor')
    expect(cut).toBe(`${'x'.repeat(MAX_FILE_NAME_LENGTH - 5)}.pdf`)
    expect(cut.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH)
    expect(cleanPdfFileName('🐜 bait.pdf', 'Termidor')).toBe('🐜 bait.pdf')
  })
})

describe('a file for a product', () => {
  test('a PDF is application/pdf, or says nothing', () => {
    expect(checkPdfFile({ contentType: 'application/pdf', size: 1 })).toBeNull()
    expect(
      checkPdfFile({ contentType: 'Application/PDF; charset=binary', size: 1 }),
    ).toBeNull()
    // convex-test, and a browser that did not know the type, store none.
    expect(checkPdfFile({ size: 1 })).toBeNull()
    expect(checkPdfFile({ contentType: '', size: 1 })).toBeNull()

    for (const contentType of [
      'image/jpeg',
      'text/html',
      'application/octet-stream',
      'application/x-pdf-but-not',
      'image/svg+xml',
    ]) {
      expect(checkPdfFile({ contentType, size: 1 }), contentType).toBe(
        'WRONG_FILE_TYPE',
      )
    }
  })

  test('a PDF may be MAX_PDF_BYTES and not a byte more', () => {
    expect(checkPdfFile({ size: MAX_PDF_BYTES })).toBeNull()
    expect(
      checkPdfFile({ contentType: 'application/pdf', size: MAX_PDF_BYTES }),
    ).toBeNull()
    expect(checkPdfFile({ size: MAX_PDF_BYTES + 1 })).toBe('FILE_TOO_LARGE')
  })

  test('a photo is any image but SVG, or says nothing', () => {
    for (const contentType of [
      'image/jpeg',
      'image/png',
      'image/heic',
      'image/webp',
      'IMAGE/JPEG',
      undefined,
    ]) {
      expect(checkPhotoFile({ contentType, size: 1 }), contentType).toBeNull()
    }
    for (const contentType of [
      'image/svg+xml',
      'application/pdf',
      'text/html',
      'video/mp4',
      'imagex/png',
    ]) {
      expect(checkPhotoFile({ contentType, size: 1 }), contentType).toBe(
        'WRONG_FILE_TYPE',
      )
    }
  })

  test('a photo may be MAX_PHOTO_BYTES and not a byte more', () => {
    expect(checkPhotoFile({ size: MAX_PHOTO_BYTES })).toBeNull()
    expect(checkPhotoFile({ size: MAX_PHOTO_BYTES + 1 })).toBe('FILE_TOO_LARGE')
    // A PDF's allowance is not a photo's.
    expect(checkPhotoFile({ size: MAX_PDF_BYTES })).toBe('FILE_TOO_LARGE')
  })

  test('the wrong kind of file is refused as that, whatever its size', () => {
    expect(
      checkPdfFile({ contentType: 'image/jpeg', size: MAX_PDF_BYTES + 1 }),
    ).toBe('WRONG_FILE_TYPE')
    expect(
      checkPhotoFile({
        contentType: 'application/pdf',
        size: MAX_PHOTO_BYTES + 1,
      }),
    ).toBe('WRONG_FILE_TYPE')
  })
})
