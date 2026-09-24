import { describe, expect, test } from 'vitest'
import {
  filterProducts,
  linkParts,
  matchesProductSearch,
  productSearchText,
} from './productSearch'

const TERMIDOR = {
  name: 'Termidor Residual',
  description: 'Fipronil 100 g/L. Soil treatment for subterranean termites.',
  url: 'https://www.termidor.com.au/products/residual?region=au',
  pdf: { fileName: 'Termidor SDS 2024.pdf' },
}

const BAIT = {
  name: 'Advion Cockroach Gel',
  description: null,
  url: null,
  pdf: null,
}

describe('linkParts', () => {
  test('drops www. from the host and keeps the rest', () => {
    expect(linkParts(TERMIDOR.url)).toEqual({
      host: 'termidor.com.au',
      rest: '/products/residual?region=au',
    })
  })

  test('a bare site has no rest', () => {
    expect(linkParts('https://bayer.com.au/')).toEqual({
      host: 'bayer.com.au',
      rest: '',
    })
  })

  test('keeps a port with the host', () => {
    expect(linkParts('https://brand.com.au:8080/sds')?.host).toBe(
      'brand.com.au:8080',
    )
  })

  test('decodes escapes in the path for show', () => {
    expect(linkParts('https://brand.com.au/Label%20Sheet.pdf')?.rest).toBe(
      '/Label Sheet.pdf',
    )
  })

  test('leaves a stray percent as stored', () => {
    expect(linkParts('https://brand.com.au/100%25/a%zz')?.rest).toBe(
      '/100%25/a%zz',
    )
  })

  test('null for something that is not a link', () => {
    expect(linkParts('not a link')).toBeNull()
  })
})

describe('matchesProductSearch', () => {
  test('finds by name, any case', () => {
    expect(matchesProductSearch(TERMIDOR, 'termidor')).toBe(true)
  })

  test('finds by a word in the description', () => {
    expect(matchesProductSearch(TERMIDOR, 'fipronil')).toBe(true)
  })

  test("finds by the link's host, but not its path", () => {
    expect(matchesProductSearch(TERMIDOR, 'termidor.com.au')).toBe(true)
    expect(matchesProductSearch(BAIT, 'termidor.com.au')).toBe(false)
    expect(matchesProductSearch({ ...TERMIDOR, name: 'X' }, 'region')).toBe(
      false,
    )
  })

  test('finds by the PDF file name', () => {
    expect(matchesProductSearch(TERMIDOR, 'sds 2024')).toBe(true)
  })

  test('every word must appear, in any order', () => {
    expect(matchesProductSearch(TERMIDOR, 'termites residual')).toBe(true)
    expect(matchesProductSearch(TERMIDOR, 'termites cockroach')).toBe(false)
  })

  test('a product with nothing but a name is still searchable', () => {
    expect(productSearchText(BAIT)).toBe('Advion Cockroach Gel')
    expect(matchesProductSearch(BAIT, 'gel')).toBe(true)
  })
})

describe('filterProducts', () => {
  test('blank keeps everything, in order', () => {
    expect(filterProducts([TERMIDOR, BAIT], '  ')).toEqual([TERMIDOR, BAIT])
  })

  test('narrows to the matches', () => {
    expect(filterProducts([TERMIDOR, BAIT], 'advion')).toEqual([BAIT])
  })
})
