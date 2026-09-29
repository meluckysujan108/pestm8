import { describe, expect, test, vi } from 'vitest'
import { CLAIM_WINDOW_MS } from '../../../convex/lib/products'
import { MAX_LICENCE_PDF_BYTES } from '../../../convex/lib/licences'
import {
  UPLOAD_FRESH_MS,
  prepareLicenceFile,
  stageText,
  uploadStagedFiles,
  withinMs,
} from './licenceUpload'
import type { LicenceUploadMemo } from './licenceUpload'

// `licenceUpload` keeps files on the phone (`keptLicence`), which reads who is
// signed in through the root state — and that sets up the auth server, which
// needs a deployment's URL this test has none of. As `keptLicence.test.ts`.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

/**
 * The steps a licence file takes on its way up, shared by a licence's own
 * page and Add new. Only what needs no canvas and no network: a photo's
 * shrinking and the upload itself are covered end to end by the licence spec.
 */

describe('a picked file, made ready to send', () => {
  test('a PDF goes as it is', async () => {
    const pdf = new File(['%PDF-1.4'], 'Certificate of currency.pdf', {
      type: 'application/pdf',
    })
    const prepared = await prepareLicenceFile(pdf)
    expect(prepared.blob).toBe(pdf)
    expect(prepared.type).toEqual({
      kind: 'pdf',
      contentType: 'application/pdf',
    })
    expect(prepared.fileName).toBe('Certificate of currency.pdf')
  })

  test('a file that is not a PDF, PNG or JPG is turned away before anything else', async () => {
    const word = new File(['x'], 'Licence.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    let preparing = false
    await expect(
      prepareLicenceFile(word, () => {
        preparing = true
      }),
    ).rejects.toMatchObject({ data: 'WRONG_FILE_TYPE' })
    // Refused on its type alone: nothing was made smaller.
    expect(preparing).toBe(false)
  })

  test('a PDF past the limit is refused as too big, not sent to find out', async () => {
    const scan = new File(
      [new Uint8Array(MAX_LICENCE_PDF_BYTES + 1)],
      'Scan.pdf',
      { type: 'application/pdf' },
    )
    await expect(prepareLicenceFile(scan)).rejects.toMatchObject({
      data: 'FILE_TOO_LARGE',
    })
  })
})

describe('an upload kept for a second Add', () => {
  test('is sent again before the server would refuse it as too old', () => {
    expect(UPLOAD_FRESH_MS).toBeLessThan(CLAIM_WINDOW_MS)
    expect(UPLOAD_FRESH_MS).toBeGreaterThan(0)
  })
})

describe('where a batch of files is up to', () => {
  test('one file says only what is happening', () => {
    expect(stageText({ step: 'preparing', n: 1, of: 1 })).toBe(
      'Preparing photo…',
    )
    expect(stageText({ step: 'uploading', n: 1, of: 1 })).toBe('Uploading…')
  })

  test('several say which', () => {
    expect(stageText({ step: 'uploading', n: 2, of: 3 })).toBe(
      'Uploading 2 of 3…',
    )
  })
})

describe('an answer that does not come', () => {
  test('one in time is passed on', async () => {
    await expect(withinMs(Promise.resolve('done'), 1_000)).resolves.toBe('done')
  })

  test('one too late is given up on, in the words asked for', async () => {
    const never = new Promise<string>(() => {})
    await expect(
      withinMs(never, 5, () => new Error('ADD_FILE_UNCONFIRMED')),
    ).rejects.toThrow('ADD_FILE_UNCONFIRMED')
  })

  test('a refusal is passed on as it came', async () => {
    const refused = Promise.reject(new Error('NO_ACCESS'))
    await expect(withinMs(refused, 1_000)).rejects.toThrow('NO_ACCESS')
  })
})

describe('sending the files picked on Add new', () => {
  const file = (name: string) => ({ name, blob: new Blob([name]) })

  test('each goes up once, in order, and is remembered', async () => {
    const memo: LicenceUploadMemo = new WeakMap()
    const sent: Array<string> = []
    const front = file('front')
    const back = file('back')
    await uploadStagedFiles(
      [front, back],
      memo,
      (f, n, of) => {
        sent.push(`${f.name} ${n}/${of}`)
        return Promise.resolve(`id-${f.name}`)
      },
      () => 1_000,
    )
    expect(sent).toEqual(['front 1/2', 'back 2/2'])
    expect(memo.get(front.blob)).toEqual({ storageId: 'id-front', at: 1_000 })
    expect(memo.get(back.blob)).toEqual({ storageId: 'id-back', at: 1_000 })
  })

  test('a second Add sends only what did not get there', async () => {
    const memo: LicenceUploadMemo = new WeakMap()
    const front = file('front')
    const back = file('back')
    memo.set(front.blob, { storageId: 'id-front', at: 1_000 })
    const sent: Array<string> = []
    await uploadStagedFiles(
      [front, back],
      memo,
      (f) => {
        sent.push(f.name)
        return Promise.resolve(`id-${f.name}`)
      },
      () => 2_000,
    )
    expect(sent).toEqual(['back'])
    expect(memo.get(front.blob)?.storageId).toBe('id-front')
  })

  test('one that has aged past the claim window goes up again', async () => {
    const memo: LicenceUploadMemo = new WeakMap()
    const front = file('front')
    memo.set(front.blob, { storageId: 'old', at: 0 })
    await uploadStagedFiles(
      [front],
      memo,
      () => Promise.resolve('new'),
      () => UPLOAD_FRESH_MS,
    )
    expect(memo.get(front.blob)).toEqual({
      storageId: 'new',
      at: UPLOAD_FRESH_MS,
    })
  })

  test('a photo that aged while a big PDF went up is sent again, once', async () => {
    const memo: LicenceUploadMemo = new WeakMap()
    const photo = file('photo')
    const pdf = file('pdf')
    let clock = 0
    const sent: Array<string> = []
    await uploadStagedFiles(
      [photo, pdf],
      memo,
      (f) => {
        sent.push(f.name)
        // The PDF, the first time, takes longer than the window.
        if (f.name === 'pdf' && sent.length === 2) clock += UPLOAD_FRESH_MS
        return Promise.resolve(`id-${f.name}-${sent.length}`)
      },
      () => clock,
    )
    expect(sent).toEqual(['photo', 'pdf', 'photo'])
    expect(memo.get(photo.blob)?.storageId).toBe('id-photo-3')
    expect(memo.get(pdf.blob)?.storageId).toBe('id-pdf-2')
  })

  test('a failed upload stops the Add, and what went up before it is kept', async () => {
    const memo: LicenceUploadMemo = new WeakMap()
    const front = file('front')
    const back = file('back')
    await expect(
      uploadStagedFiles(
        [front, back],
        memo,
        (f) =>
          f.name === 'back'
            ? Promise.reject(new Error('UPLOAD_STALLED'))
            : Promise.resolve('id-front'),
        () => 1_000,
      ),
    ).rejects.toThrow('UPLOAD_STALLED')
    expect(memo.get(front.blob)?.storageId).toBe('id-front')
    expect(memo.has(back.blob)).toBe(false)
  })
})
