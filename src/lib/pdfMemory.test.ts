import { describe, expect, test } from 'vitest'
import {
  createPdfMemory,
  createUploadedPdfs,
  forgetUpload,
  noteListedPdfs,
  recallPdf,
  rememberNewProductUpload,
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

  test('is handed over when the list shows the new key, opened or not', () => {
    const uploads = createUploadedPdfs()
    const blob = bytes(4)
    uploads.listed('p1', 'https://files.example/old')
    uploads.expect('p1', 'https://files.example/old', blob)
    expect(uploads.listed('p1', 'https://files.example/old')).toBeNull()
    expect(uploads.listed('p1', 'https://files.example/new')).toEqual({
      key: 'https://files.example/new',
      blob,
    })
    // Replaced again, from somewhere else: not these bytes.
    expect(uploads.listed('p1', 'https://files.example/newer')).toBeNull()
    expect(uploads.claim('p1', 'https://files.example/newer')).toBeNull()
  })

  test('a file someone else put there during the upload is not this one', () => {
    const uploads = createUploadedPdfs()
    const blob = bytes(4)
    // The row the person tapped Replace on still said "old"; the list
    // moved on while the upload crawled.
    uploads.listed('p1', 'https://files.example/theirs')
    uploads.expect('p1', 'https://files.example/old', blob)
    expect(uploads.claim('p1', 'https://files.example/theirs')).toBeNull()
    expect(uploads.listed('p1', 'https://files.example/mine')?.blob).toBe(blob)
  })

  test('a PDF removed by someone else ends the wait', () => {
    const uploads = createUploadedPdfs()
    uploads.listed('p1', 'https://files.example/old')
    uploads.expect('p1', 'https://files.example/old', bytes(1))
    expect(uploads.listed('p1', null)).toBeNull()
    expect(uploads.claim('p1', 'https://files.example/later')).toBeNull()
  })

  // The page was not watching the list when the upload's own file landed —
  // it had unmounted — so the first NEW key it sees can be a later file
  // from someone else. The size the server reports for that file tells them
  // apart: a different size is a different file, and the wait is over.
  test('a later file of another size is never handed these bytes', () => {
    const uploads = createUploadedPdfs()
    uploads.expect('p1', 'https://files.example/old', bytes(4))
    expect(uploads.claim('p1', 'https://files.example/theirs', 9)).toBeNull()
    // Over for good: not even a same-size file after it gets them.
    expect(uploads.claim('p1', 'https://files.example/later', 4)).toBeNull()

    const listing = createUploadedPdfs()
    listing.expect('p2', 'https://files.example/old', bytes(4))
    expect(listing.listed('p2', 'https://files.example/theirs', 9)).toBeNull()
    expect(listing.claim('p2', 'https://files.example/later', 4)).toBeNull()
  })

  // A Save retried after its first write had in fact landed re-sends the id
  // the product already holds, which the server treats as no change: the
  // bytes wait under the key that already IS theirs. A later, different file
  // must not inherit them.
  test('a retried save waiting under its own key refuses a different file', () => {
    const uploads = createUploadedPdfs()
    uploads.listed('p1', 'https://files.example/mine', 4)
    uploads.expect('p1', 'https://files.example/mine', bytes(4))
    expect(uploads.listed('p1', 'https://files.example/theirs', 9)).toBeNull()
    expect(uploads.claim('p1', 'https://files.example/theirs', 9)).toBeNull()
  })

  test('a matching size, or no size to compare, still hands them over', () => {
    const sized = createUploadedPdfs()
    const blob = bytes(4)
    sized.expect('p1', 'https://files.example/old', blob)
    expect(sized.claim('p1', 'https://files.example/new', 4)).toBe(blob)

    const unsized = createUploadedPdfs()
    unsized.expect('p1', 'https://files.example/old', blob)
    expect(unsized.listed('p1', 'https://files.example/new', null)?.blob).toBe(
      blob,
    )
  })

  test("a new product's bytes take the first key the list shows", () => {
    const listedFirst = createUploadedPdfs()
    const blob = bytes(3)
    listedFirst.listed('p1', 'https://files.example/first')
    expect(listedFirst.expectNew('p1', blob)).toEqual({
      key: 'https://files.example/first',
      blob,
    })
    expect(listedFirst.claim('p1', 'https://files.example/later')).toBeNull()

    const listedAfter = createUploadedPdfs()
    expect(listedAfter.expectNew('p1', blob)).toBeNull()
    expect(listedAfter.listed('p1', 'https://files.example/first')?.blob).toBe(
      blob,
    )
    expect(listedAfter.claim('p1', 'https://files.example/later')).toBeNull()
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

  // The review's case: a product saved with a PDF nobody opened here, whose
  // PDF was later replaced from another phone.
  test('an upload nothing opened is never handed out as a later file', () => {
    const mine = bytes(6)
    rememberNewProductUpload('p12', mine)
    noteListedPdfs([{ id: 'p12', pdf: { url: 'https://files.example/u1' } }])
    noteListedPdfs([{ id: 'p12', pdf: { url: 'https://files.example/u2' } }])
    expect(recallPdf('https://files.example/u2', 'p12')).toBeNull()
    expect(recallPdf('https://files.example/u2')).toBeNull()
    // Where it belongs, though.
    expect(recallPdf('https://files.example/u1')).toBe(mine)
  })

  test('an upload left waiting is refused by a later file of another size', () => {
    const mine = bytes(8)
    rememberUpload('p14', 'https://files.example/s0', mine)
    // Nothing watched the list while this file landed; the next thing asked
    // for is someone else's later file.
    expect(recallPdf('https://files.example/s2', 'p14', 11)).toBeNull()
    noteListedPdfs([
      { id: 'p15', pdf: { url: 'https://files.example/t0', size: 3 } },
    ])
    rememberUpload('p15', 'https://files.example/t0', bytes(8))
    noteListedPdfs([
      { id: 'p15', pdf: { url: 'https://files.example/t2', size: 11 } },
    ])
    expect(recallPdf('https://files.example/t2', 'p15', 11)).toBeNull()
    expect(recallPdf('https://files.example/t2')).toBeNull()
  })

  test('the same, for a Replace', () => {
    const mine = bytes(7)
    noteListedPdfs([{ id: 'p13', pdf: { url: 'https://files.example/r0' } }])
    rememberUpload('p13', 'https://files.example/r0', mine)
    noteListedPdfs([{ id: 'p13', pdf: { url: 'https://files.example/r1' } }])
    noteListedPdfs([{ id: 'p13', pdf: { url: 'https://files.example/r2' } }])
    expect(recallPdf('https://files.example/r2', 'p13')).toBeNull()
    expect(recallPdf('https://files.example/r1')).toBe(mine)
  })
})
