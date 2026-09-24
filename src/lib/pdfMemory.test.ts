import { describe, expect, test } from 'vitest'
import {
  createPdfMemory,
  createUploadedPdfs,
  forgetUpload,
  recallPdf,
  rememberPdf,
  rememberUpload,
} from './pdfMemory'

const bytes = (size: number) => new Blob([new Uint8Array(size)])

describe('createPdfMemory', () => {
  test('gives back what it was given, by key', () => {
    const memory = createPdfMemory()
    const blob = bytes(10)
    memory.set('a', blob)
    expect(memory.get('a')).toBe(blob)
    expect(memory.get('b')).toBeNull()
  })

  test('drops the least recently used past the file cap', () => {
    const memory = createPdfMemory({ maxFiles: 2 })
    memory.set('a', bytes(1))
    memory.set('b', bytes(1))
    memory.get('a') // a is now the newer of the two
    memory.set('c', bytes(1))
    expect(memory.keys()).toEqual(['a', 'c'])
  })

  test('drops the oldest past the byte cap', () => {
    const memory = createPdfMemory({ maxFiles: 10, maxBytes: 100 })
    memory.set('a', bytes(60))
    memory.set('b', bytes(30))
    memory.set('c', bytes(30))
    expect(memory.keys()).toEqual(['b', 'c'])
  })

  test('always keeps the newest, however big', () => {
    const memory = createPdfMemory({ maxBytes: 100 })
    memory.set('a', bytes(10))
    memory.set('huge', bytes(500))
    expect(memory.keys()).toEqual(['huge'])
  })

  test('setting a key again replaces it without counting it twice', () => {
    const memory = createPdfMemory({ maxFiles: 2 })
    const newer = bytes(2)
    memory.set('a', bytes(1))
    memory.set('b', bytes(1))
    memory.set('a', newer)
    expect(memory.keys()).toEqual(['b', 'a'])
    expect(memory.get('a')).toBe(newer)
  })

  test('delete and clear', () => {
    const memory = createPdfMemory()
    memory.set('a', bytes(1))
    memory.set('b', bytes(1))
    memory.delete('a')
    expect(memory.keys()).toEqual(['b'])
    memory.clear()
    expect(memory.keys()).toEqual([])
  })
})

describe('the shared memory', () => {
  test('recalls by key, and nothing for no key', () => {
    const blob = bytes(3)
    rememberPdf('https://files.example/x', blob)
    expect(recallPdf('https://files.example/x')).toBe(blob)
    expect(recallPdf(null)).toBeNull()
    expect(recallPdf(undefined)).toBeNull()
    expect(recallPdf('')).toBeNull()
  })
})

describe('createUploadedPdfs', () => {
  test('waits while the product is still asked for under its old key', () => {
    const uploads = createUploadedPdfs()
    const blob = bytes(4)
    uploads.expect('p1', 'https://files.example/old', blob)
    expect(uploads.claim('p1', 'https://files.example/old')).toBeNull()
    expect(uploads.claim('p1', 'https://files.example/new')).toBe(blob)
    // Claimed once: the memory holds it from here on.
    expect(uploads.claim('p1', 'https://files.example/newer')).toBeNull()
  })

  test('a product that had no PDF takes the first key it is asked under', () => {
    const uploads = createUploadedPdfs()
    const blob = bytes(4)
    uploads.expect('p1', null, blob)
    expect(uploads.claim('p1', 'https://files.example/first')).toBe(blob)
  })

  test('a dropped upload is never claimed', () => {
    const uploads = createUploadedPdfs()
    uploads.expect('p1', 'https://files.example/old', bytes(1))
    uploads.drop('p1')
    expect(uploads.claim('p1', 'https://files.example/new')).toBeNull()
  })

  test('is per product', () => {
    const uploads = createUploadedPdfs()
    uploads.expect('p1', null, bytes(1))
    expect(uploads.claim('p2', 'https://files.example/x')).toBeNull()
  })
})

describe('recallPdf with a product', () => {
  test('adopts the bytes a save just uploaded under the new URL', () => {
    const blob = bytes(5)
    rememberUpload('p9', 'https://files.example/v1', blob)
    expect(recallPdf('https://files.example/v1', 'p9')).toBeNull()
    expect(recallPdf('https://files.example/v2', 'p9')).toBe(blob)
    // Now an ordinary memory entry, found without the product too.
    expect(recallPdf('https://files.example/v2')).toBe(blob)
  })

  test('a save that failed leaves nothing to claim', () => {
    rememberUpload('p11', 'https://files.example/a', bytes(5))
    forgetUpload('p11')
    expect(recallPdf('https://files.example/b', 'p11')).toBeNull()
  })

  test('without a product, only the memory is read', () => {
    rememberUpload('p10', null, bytes(5))
    expect(recallPdf('https://files.example/p10')).toBeNull()
  })
})
