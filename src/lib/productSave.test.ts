import { ConvexError } from 'convex/values'
import { describe, expect, test, vi } from 'vitest'
import { UPLOAD_FRESH_MS, createUploadMemo, saveProduct } from './productSave'
import { EMPTY_DRAFT, draftFrom } from './productForm'
import type { ProductWrite, SaveDeps } from './productSave'
import type { ProductBaseline, ProductDraft } from './productForm'

const LOADED: ProductBaseline = {
  name: 'Termidor',
  description: 'Fipronil 100 g/L',
  url: 'https://termidor.com.au/',
  hasPhoto: true,
  hasPdf: true,
}

const pdf = () =>
  new File(['%PDF-1.7'], 'Termidor SDS.pdf', { type: 'application/pdf' })
const photo = () => new Blob(['jpeg'], { type: 'image/jpeg' })

const MINUTE = 60 * 1000

/** A clock that only moves when a test moves it. */
function fakeClock() {
  let time = 0
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
  }
}

function fakes(write?: (fields: ProductWrite) => Promise<string>) {
  let next = 0
  const clock = fakeClock()
  const uploadFile = vi.fn(async (_blob: Blob, _type: string) => {
    next += 1
    return `storage-${next}`
  })
  const writes: Array<ProductWrite> = []
  const phases: Array<string> = []
  const deps: SaveDeps<string> = {
    uploadFile,
    write: async (fields) => {
      writes.push(fields)
      return write ? write(fields) : 'product-1'
    },
    uploads: createUploadMemo(),
    onPhase: (phase) => phases.push(phase),
    now: clock.now,
  }
  return { deps, uploadFile, writes, phases, clock }
}

/** Lets every settled promise run on before the next line. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('saveProduct — a new product', () => {
  test('sends the name and only the words that were given', async () => {
    const { deps, writes, uploadFile, phases } = fakes()
    const result = await saveProduct(
      null,
      { ...EMPTY_DRAFT, name: '  Termidor ', url: 'termidor.com.au' },
      deps,
    )
    expect(result).toEqual({ written: true, result: 'product-1', pdf: null })
    expect(writes).toEqual([
      { name: 'Termidor', url: 'https://termidor.com.au/' },
    ])
    expect(uploadFile).not.toHaveBeenCalled()
    // Nothing to upload: straight to saving.
    expect(phases).toEqual(['saving'])
  })

  test('uploads the photo and the PDF, each as what it is', async () => {
    const { deps, writes, uploadFile, phases } = fakes()
    const file = pdf()
    const picture = photo()
    const result = await saveProduct(
      null,
      {
        ...EMPTY_DRAFT,
        name: 'Termidor',
        photo: { kind: 'new', file: picture },
        pdf: { kind: 'new', file },
      },
      deps,
    )
    expect(uploadFile).toHaveBeenCalledTimes(2)
    expect(uploadFile).toHaveBeenCalledWith(picture, 'image/jpeg')
    expect(uploadFile).toHaveBeenCalledWith(file, 'application/pdf')
    expect(phases).toEqual(['uploading', 'saving'])
    const [fields] = writes
    expect(fields.name).toBe('Termidor')
    expect(typeof fields.photoStorageId).toBe('string')
    expect(fields.pdf).toEqual({
      storageId: expect.any(String),
      fileName: 'Termidor SDS.pdf',
    })
    expect(fields.pdf?.storageId).not.toBe(fields.photoStorageId)
    expect(result.written && result.pdf).toBe(file)
  })

  test('a PDF the picker gave no type is still sent as a PDF', async () => {
    const { deps, uploadFile } = fakes()
    const untyped = new File(['%PDF-1.4'], 'label.pdf')
    await saveProduct(
      null,
      { ...EMPTY_DRAFT, name: 'Label', pdf: { kind: 'new', file: untyped } },
      deps,
    )
    expect(uploadFile).toHaveBeenCalledWith(untyped, 'application/pdf')
  })
})

describe('saveProduct — an edit', () => {
  test('nothing changed: nothing sent at all', async () => {
    const { deps, writes, uploadFile, phases } = fakes()
    const result = await saveProduct(LOADED, draftFrom(LOADED), deps)
    expect(result).toEqual({ written: false })
    expect(writes).toEqual([])
    expect(uploadFile).not.toHaveBeenCalled()
    expect(phases).toEqual([])
  })

  test('only the field that changed', async () => {
    const { deps, writes } = fakes()
    await saveProduct(
      LOADED,
      { ...draftFrom(LOADED), description: 'Fipronil 100 g/L. Mix 6 mL/L.' },
      deps,
    )
    expect(writes).toEqual([{ description: 'Fipronil 100 g/L. Mix 6 mL/L.' }])
  })

  test('removing sends null, which clears', async () => {
    const { deps, writes } = fakes()
    const draft: ProductDraft = {
      ...draftFrom(LOADED),
      url: '',
      photo: { kind: 'remove' },
      pdf: { kind: 'remove' },
    }
    await saveProduct(LOADED, draft, deps)
    expect(writes).toEqual([{ url: null, photoStorageId: null, pdf: null }])
  })

  test('removing what was never there sends nothing', async () => {
    const { deps, writes } = fakes()
    const bare: ProductBaseline = { ...LOADED, hasPhoto: false, hasPdf: false }
    const result = await saveProduct(
      bare,
      {
        ...draftFrom(bare),
        photo: { kind: 'remove' },
        pdf: { kind: 'remove' },
      },
      deps,
    )
    expect(result).toEqual({ written: false })
    expect(writes).toEqual([])
  })

  test('a replaced PDF is uploaded and sent with its name', async () => {
    const { deps, writes } = fakes()
    const file = pdf()
    await saveProduct(
      LOADED,
      { ...draftFrom(LOADED), pdf: { kind: 'new', file } },
      deps,
    )
    expect(writes).toEqual([
      { pdf: { storageId: 'storage-1', fileName: 'Termidor SDS.pdf' } },
    ])
  })
})

describe('saveProduct — trying again', () => {
  test('a refused write keeps its uploads for the retry', async () => {
    let refuse = true
    const { deps, uploadFile, writes } = fakes(async () => {
      if (refuse) throw new ConvexError('PRODUCT_EXISTS')
      return 'product-2'
    })
    const draft: ProductDraft = {
      ...EMPTY_DRAFT,
      name: 'Termidor',
      pdf: { kind: 'new', file: pdf() },
    }
    await expect(saveProduct(null, draft, deps)).rejects.toThrow()
    refuse = false
    await saveProduct(null, { ...draft, name: 'Termidor 2' }, deps)
    // The PDF went up once; the retry reused its id.
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(writes[1].pdf?.storageId).toBe(writes[0].pdf?.storageId)
  })

  test('an upload the server cannot find is sent afresh and the write retried, once', async () => {
    let refusals = 1
    const { deps, uploadFile, writes } = fakes(async () => {
      if (refusals-- > 0) throw new ConvexError('FILE_NOT_FOUND')
      return 'product-3'
    })
    const draft: ProductDraft = {
      ...EMPTY_DRAFT,
      name: 'Termidor',
      pdf: { kind: 'new', file: pdf() },
    }
    const result = await saveProduct(null, draft, deps)
    expect(result).toMatchObject({ written: true, result: 'product-3' })
    expect(uploadFile).toHaveBeenCalledTimes(2)
    expect(writes).toHaveLength(2)
    expect(writes[1].pdf?.storageId).not.toBe(writes[0].pdf?.storageId)
  })

  test('refused twice: the error comes back, and the next Save sends it afresh', async () => {
    let refuse = true
    const { deps, uploadFile, writes } = fakes(async () => {
      if (refuse) throw new ConvexError('FILE_NOT_FOUND')
      return 'product-3'
    })
    const file = pdf()
    const draft: ProductDraft = {
      ...EMPTY_DRAFT,
      name: 'Termidor',
      pdf: { kind: 'new', file },
    }
    await expect(saveProduct(null, draft, deps)).rejects.toThrow()
    // One write, one retry — never a loop.
    expect(writes).toHaveLength(2)
    expect(deps.uploads.has(file)).toBe(false)
    refuse = false
    uploadFile.mockClear()
    await saveProduct(null, draft, deps)
    expect(uploadFile).toHaveBeenCalledTimes(1)
  })

  test('a file already on a product is forgotten, not retried', async () => {
    const { deps, writes } = fakes(async () => {
      throw new ConvexError('ALREADY_ATTACHED')
    })
    const file = pdf()
    await expect(
      saveProduct(
        null,
        { ...EMPTY_DRAFT, name: 'Termidor', pdf: { kind: 'new', file } },
        deps,
      ),
    ).rejects.toThrow()
    expect(writes).toHaveLength(1)
    expect(deps.uploads.has(file)).toBe(false)
  })

  test('one upload failing keeps the one that got through', async () => {
    const { deps, uploadFile } = fakes()
    const file = pdf()
    const picture = photo()
    uploadFile.mockImplementationOnce(async () => 'photo-ok')
    uploadFile.mockImplementationOnce(async () => {
      throw new Error('signal dropped')
    })
    const draft: ProductDraft = {
      ...EMPTY_DRAFT,
      name: 'Termidor',
      photo: { kind: 'new', file: picture },
      pdf: { kind: 'new', file },
    }
    await expect(saveProduct(null, draft, deps)).rejects.toThrow(
      'signal dropped',
    )
    uploadFile.mockClear()
    await saveProduct(null, draft, deps)
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(uploadFile).toHaveBeenCalledWith(file, 'application/pdf')
  })

  test('once written, the uploads are spent', async () => {
    const { deps } = fakes()
    const file = pdf()
    await saveProduct(
      null,
      { ...EMPTY_DRAFT, name: 'Termidor', pdf: { kind: 'new', file } },
      deps,
    )
    expect(deps.uploads.has(file)).toBe(false)
  })
})

describe('saveProduct — the server takes an upload for 15 minutes', () => {
  test('a photo that went up long before a slow PDF goes again before the write', async () => {
    const { deps, uploadFile, writes, clock } = fakes()
    const file = pdf()
    const picture = photo()
    uploadFile.mockImplementation(async (blob: Blob) => {
      if (blob === file) {
        // The photo lands first; the PDF takes 20 minutes on one bar.
        await tick()
        clock.advance(20 * MINUTE)
        return 'pdf-1'
      }
      return `photo-${uploadFile.mock.calls.length}`
    })
    await saveProduct(
      null,
      {
        ...EMPTY_DRAFT,
        name: 'Termidor',
        photo: { kind: 'new', file: picture },
        pdf: { kind: 'new', file },
      },
      deps,
    )
    // The photo twice, the PDF once — never the 20 MB again.
    expect(uploadFile.mock.calls.map(([blob]) => blob)).toEqual([
      picture,
      file,
      picture,
    ])
    expect(writes).toHaveLength(1)
    expect(writes[0].pdf?.storageId).toBe('pdf-1')
    expect(writes[0].photoStorageId).toBe('photo-3')
  })

  test('an upload kept from an earlier Save that has since aged goes again', async () => {
    let refuse = true
    const { deps, uploadFile, writes, clock } = fakes(async () => {
      if (refuse) throw new ConvexError('PRODUCT_EXISTS')
      return 'product-4'
    })
    const draft: ProductDraft = {
      ...EMPTY_DRAFT,
      name: 'Termidor',
      pdf: { kind: 'new', file: pdf() },
    }
    await expect(saveProduct(null, draft, deps)).rejects.toThrow()
    // Still fresh: reused.
    clock.advance(UPLOAD_FRESH_MS - MINUTE)
    await expect(saveProduct(null, draft, deps)).rejects.toThrow()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    // Aged past the window, less the margin: sent again, not risked.
    clock.advance(2 * MINUTE)
    refuse = false
    await saveProduct(null, draft, deps)
    expect(uploadFile).toHaveBeenCalledTimes(2)
    expect(writes[2].pdf?.storageId).not.toBe(writes[0].pdf?.storageId)
  })

  test('refused as too old: only the upload that aged goes again, then the write is retried', async () => {
    let refusals = 1
    const { deps, uploadFile, writes, clock } = fakes(async () => {
      // The write sat in a queue on no signal for a few minutes.
      clock.advance(4 * MINUTE)
      if (refusals-- > 0) throw new ConvexError('FILE_NOT_FOUND')
      return 'product-5'
    })
    const file = pdf()
    const picture = photo()
    uploadFile.mockImplementation(async (blob: Blob) => {
      if (blob === file) {
        await tick()
        // Slow, but not so slow the photo aged past the margin.
        clock.advance(10 * MINUTE)
      }
      return `storage-${uploadFile.mock.calls.length}`
    })
    const result = await saveProduct(
      null,
      {
        ...EMPTY_DRAFT,
        name: 'Termidor',
        photo: { kind: 'new', file: picture },
        pdf: { kind: 'new', file },
      },
      deps,
    )
    expect(result).toMatchObject({ written: true, result: 'product-5' })
    expect(writes).toHaveLength(2)
    // The PDF (4 minutes old) was kept; the photo (14) went again.
    expect(writes[1].pdf?.storageId).toBe(writes[0].pdf?.storageId)
    expect(writes[1].photoStorageId).not.toBe(writes[0].photoStorageId)
    expect(uploadFile).toHaveBeenCalledTimes(3)
    expect(uploadFile).toHaveBeenLastCalledWith(picture, 'image/jpeg')
  })
})
