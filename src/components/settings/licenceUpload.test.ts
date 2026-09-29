import { describe, expect, test } from 'vitest'
import { CLAIM_WINDOW_MS } from '../../../convex/lib/products'
import { MAX_LICENCE_PDF_BYTES } from '../../../convex/lib/licences'
import {
  UPLOAD_FRESH_MS,
  prepareLicenceFile,
  stageText,
  withinMs,
} from './licenceUpload'

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
