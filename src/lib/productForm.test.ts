import { describe, expect, test } from 'vitest'
import {
  EMPTY_DRAFT,
  URL_PROBLEM,
  baselineForSave,
  changesAnything,
  draftFrom,
  draftProblems,
  hasProblems,
  pdfPickRefusal,
  photoPickRefusal,
  productChanges,
} from './productForm'
import type { ProductBaseline, ProductDraft } from './productForm'

const LOADED: ProductBaseline = {
  name: 'Termidor',
  description: 'Fipronil 100 g/L',
  url: 'https://termidor.com.au/',
  hasPhoto: true,
  hasPdf: true,
}

const pdf = new File(['%PDF-1.7'], 'Termidor SDS.pdf', {
  type: 'application/pdf',
})
const photo = new Blob(['jpeg'], { type: 'image/jpeg' })

describe('draftProblems', () => {
  test('a name is needed', () => {
    expect(draftProblems({ ...EMPTY_DRAFT, name: '   ' })).toEqual({
      name: 'Give the product a name.',
    })
  })

  test('the server limits, as the server counts them', () => {
    const problems = draftProblems({
      ...EMPTY_DRAFT,
      name: 'x'.repeat(121),
      description: 'y'.repeat(2001),
    })
    expect(problems.name).toBe('That name is too long.')
    expect(problems.description).toBe('That description is too long.')
  })

  test('a link that is not a web page', () => {
    expect(
      draftProblems({ ...EMPTY_DRAFT, name: 'A', url: 'javascript:alert(1)' }),
    ).toEqual({ url: URL_PROBLEM })
    expect(
      draftProblems({ ...EMPTY_DRAFT, name: 'A', url: 'intranet' }).url,
    ).toBe(URL_PROBLEM)
  })

  test('a bare site and a blank link are both fine', () => {
    expect(
      hasProblems(
        draftProblems({ ...EMPTY_DRAFT, name: 'A', url: 'brand.com.au/sds' }),
      ),
    ).toBe(false)
    expect(hasProblems(draftProblems({ ...EMPTY_DRAFT, name: 'A' }))).toBe(
      false,
    )
  })
})

describe('productChanges for a new product', () => {
  test('sends the name, and the words only when there are some', () => {
    expect(
      productChanges(null, { ...EMPTY_DRAFT, name: '  Advion  ' }),
    ).toEqual({ name: 'Advion', photo: 'keep', pdf: 'keep' })
  })

  test('tidies the description and the link', () => {
    expect(
      productChanges(null, {
        ...EMPTY_DRAFT,
        name: 'Advion',
        description: '  Gel bait \n',
        url: 'syngenta.com.au',
      }),
    ).toEqual({
      name: 'Advion',
      description: 'Gel bait',
      url: 'https://syngenta.com.au/',
      photo: 'keep',
      pdf: 'keep',
    })
  })

  test('picked files are uploaded; a removed one that was never there is nothing', () => {
    expect(
      productChanges(null, {
        ...EMPTY_DRAFT,
        name: 'A',
        photo: { kind: 'new', file: photo },
        pdf: { kind: 'remove' },
      }),
    ).toMatchObject({ photo: 'upload', pdf: 'keep' })
  })
})

describe('productChanges for an edit', () => {
  test('nothing changed sends nothing', () => {
    const changes = productChanges(LOADED, draftFrom(LOADED))
    expect(changes).toEqual({ photo: 'keep', pdf: 'keep' })
    expect(changesAnything(changes)).toBe(false)
  })

  test('the same link typed the short way is not a change', () => {
    const draft = { ...draftFrom(LOADED), url: 'termidor.com.au' }
    expect(changesAnything(productChanges(LOADED, draft))).toBe(false)
  })

  test('a trailing space is not a change; capitals are', () => {
    expect(
      changesAnything(
        productChanges(LOADED, { ...draftFrom(LOADED), name: 'Termidor ' }),
      ),
    ).toBe(false)
    expect(
      productChanges(LOADED, { ...draftFrom(LOADED), name: 'TERMIDOR' }),
    ).toEqual({ name: 'TERMIDOR', photo: 'keep', pdf: 'keep' })
  })

  test('blanking a field clears it with null', () => {
    const draft: ProductDraft = {
      ...draftFrom(LOADED),
      description: '  ',
      url: '',
    }
    expect(productChanges(LOADED, draft)).toEqual({
      description: null,
      url: null,
      photo: 'keep',
      pdf: 'keep',
    })
  })

  test('a field that was empty and still is sends nothing', () => {
    const bare = { ...LOADED, description: null, url: null }
    expect(productChanges(bare, draftFrom(bare))).toEqual({
      photo: 'keep',
      pdf: 'keep',
    })
  })

  test('removing and replacing files', () => {
    expect(
      productChanges(LOADED, {
        ...draftFrom(LOADED),
        photo: { kind: 'remove' },
        pdf: { kind: 'new', file: pdf },
      }),
    ).toEqual({ photo: 'remove', pdf: 'upload' })
  })

  test('removing a file the product never had is nothing', () => {
    const bare = { ...LOADED, hasPhoto: false, hasPdf: false }
    expect(
      productChanges(bare, {
        ...draftFrom(bare),
        photo: { kind: 'remove' },
        pdf: { kind: 'remove' },
      }),
    ).toEqual({ photo: 'keep', pdf: 'keep' })
  })
})

describe('baselineForSave', () => {
  const bare: ProductBaseline = { ...LOADED, hasPhoto: false, hasPdf: false }

  test('a file someone else added during the edit can be removed', () => {
    // Editing began with no photo or PDF; another member then added both,
    // and the form (which shows the live row) offered Remove for them.
    const draft: ProductDraft = {
      ...draftFrom(bare),
      photo: { kind: 'remove' },
      pdf: { kind: 'remove' },
    }
    expect(productChanges(bare, draft)).toEqual({ photo: 'keep', pdf: 'keep' })
    expect(
      productChanges(
        baselineForSave(bare, { hasPhoto: true, hasPdf: true }),
        draft,
      ),
    ).toEqual({ photo: 'remove', pdf: 'remove' })
  })

  test('a file someone else removed during the edit is not removed twice', () => {
    const draft: ProductDraft = {
      ...draftFrom(LOADED),
      photo: { kind: 'remove' },
    }
    expect(
      productChanges(
        baselineForSave(LOADED, { hasPhoto: false, hasPdf: true }),
        draft,
      ),
    ).toEqual({ photo: 'keep', pdf: 'keep' })
  })

  test('words are still measured from when the edit began', () => {
    // Someone renamed it meanwhile; this person changed only the link.
    const started = baselineForSave(LOADED, { hasPhoto: true, hasPdf: true })
    expect(started.name).toBe('Termidor')
    expect(
      productChanges(started, { ...draftFrom(LOADED), url: 'fmc.com.au' }),
    ).toEqual({ url: 'https://fmc.com.au/', photo: 'keep', pdf: 'keep' })
  })
})

describe('pdfPickRefusal', () => {
  test('a PDF within the limit', () => {
    expect(pdfPickRefusal({ type: 'application/pdf', size: 1000 })).toBeNull()
  })

  test('a picker that did not know the type is left to the byte check', () => {
    expect(pdfPickRefusal({ type: '', size: 1000 })).toBeNull()
    expect(
      pdfPickRefusal({ type: 'application/octet-stream', size: 1000 }),
    ).toBeNull()
  })

  test('the wrong type, and too big', () => {
    expect(pdfPickRefusal({ type: 'image/png', size: 1000 })).toBe(
      'WRONG_FILE_TYPE',
    )
    expect(
      pdfPickRefusal({ type: 'application/pdf', size: 20 * 1024 * 1024 + 1 }),
    ).toBe('FILE_TOO_LARGE')
  })
})

describe('photoPickRefusal', () => {
  test('pictures, but not SVG or anything else', () => {
    expect(photoPickRefusal({ type: 'image/jpeg', size: 1000 })).toBeNull()
    expect(photoPickRefusal({ type: 'image/heic', size: 1000 })).toBeNull()
    expect(photoPickRefusal({ type: 'image/svg+xml', size: 1000 })).toBe(
      'WRONG_FILE_TYPE',
    )
    expect(photoPickRefusal({ type: 'application/pdf', size: 1000 })).toBe(
      'WRONG_FILE_TYPE',
    )
  })

  test('too big', () => {
    expect(
      photoPickRefusal({ type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 }),
    ).toBe('FILE_TOO_LARGE')
  })
})
