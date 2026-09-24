import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ConvexError } from 'convex/values'
import { FileTransferError, fetchWithProgress } from '#/lib/pdfFiles'
import { recallPdf } from '#/lib/pdfMemory'
import { draftPreviewSource, reportPdfSource } from './reportPdfSources'
import type * as PdfFilesModule from '#/lib/pdfFiles'

// The network, stood in for: what is under test is where the viewer is sent
// for the bytes, what is kept, and what it is told when that fails.
vi.mock('#/lib/pdfFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof PdfFilesModule>()),
  fetchWithProgress: vi.fn(),
}))

const fetchMock = vi.mocked(fetchWithProgress)

let serial = 0
/** Fresh URLs per test: the page's PDF memory outlives each one. */
const nextUrl = () => {
  serial += 1
  return `https://files.example/report-${serial}.pdf`
}

const pdf = (text = '%PDF-1.7') => new Blob([text], { type: 'application/pdf' })
const noProgress = () => {}
const abortError = () =>
  Object.assign(new Error('The operation was aborted.'), {
    name: 'AbortError',
  })

beforeEach(() => {
  fetchMock.mockReset()
})

describe('reportPdfSource', () => {
  test('is keyed by the report, not by the URL of the moment', () => {
    const source = reportPdfSource('r1', () => Promise.resolve(nextUrl()))
    expect(source.key).toBe('report:r1')
  })

  test('downloads the URL it is handed, and keeps the bytes for the visit', async () => {
    const url = nextUrl()
    const bytes = pdf()
    fetchMock.mockResolvedValueOnce(bytes)
    const ensure = vi.fn(() => Promise.resolve(url))
    const source = reportPdfSource('r2', ensure)

    const signal = new AbortController().signal
    await expect(source.load(noProgress, signal)).resolves.toBe(bytes)
    expect(fetchMock).toHaveBeenCalledWith(url, noProgress, signal)
    // Share can hand these over inside the tap now.
    expect(recallPdf(url)).toBe(bytes)

    // Opened again this visit: no second download.
    await expect(source.load(noProgress, signal)).resolves.toBe(bytes)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  test("says why when the PDF can't be prepared", async () => {
    const source = reportPdfSource('r3', () =>
      Promise.reject(new ConvexError('PDF_UNAVAILABLE')),
    )
    await expect(
      source.load(noProgress, new AbortController().signal),
    ).rejects.toThrow('The PDF didn’t finish drawing. Try again in a moment.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('lets an abort through untouched: the viewer gave up', async () => {
    const controller = new AbortController()
    const aborted = abortError()
    fetchMock.mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(aborted)
    })
    const source = reportPdfSource('r4', () => Promise.resolve(nextUrl()))
    await expect(source.load(noProgress, controller.signal)).rejects.toBe(
      aborted,
    )
  })
})

describe('draftPreviewSource', () => {
  test('saves the answers, draws the preview, downloads it — and keeps nothing', async () => {
    const url = nextUrl()
    const bytes = pdf('%PDF draft')
    fetchMock.mockResolvedValueOnce(bytes)
    const order: Array<string> = []
    const source = draftPreviewSource('draft-preview:r5:1', {
      flush: () => {
        order.push('flush')
        return Promise.resolve(true)
      },
      render: () => {
        order.push('render')
        return Promise.resolve({ url })
      },
    })
    expect(source.key).toBe('draft-preview:r5:1')
    await expect(
      source.load(noProgress, new AbortController().signal),
    ).resolves.toBe(bytes)
    expect(order).toEqual(['flush', 'render'])
    // Not in the memory Share draws on: a preview is never shared.
    expect(recallPdf(url)).toBeNull()
  })

  test('answers that did not save stop it before anything is drawn', async () => {
    const render = vi.fn(() => Promise.resolve({ url: nextUrl() }))
    const source = draftPreviewSource('draft-preview:r6:1', {
      flush: () => Promise.resolve(false),
      render,
    })
    await expect(
      source.load(noProgress, new AbortController().signal),
    ).rejects.toThrow(/haven’t saved/)
    expect(render).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a failure the viewer would call signal is said where the preview was asked for', async () => {
    // The viewer's error screen says "Check your signal" whatever it is
    // handed; a preview has no card behind it to say better.
    const refused = vi.fn()
    const locked = draftPreviewSource('draft-preview:r8:1', {
      flush: () => Promise.resolve(true),
      render: () => Promise.reject(new ConvexError('REPORT_FINALISED')),
      refused,
    })
    await expect(
      locked.load(noProgress, new AbortController().signal),
    ).rejects.toThrow(/has just been locked/)
    expect(refused).toHaveBeenCalledWith(
      'This report has just been locked. Close this and open the finished document.',
    )

    // Answers the server would not take (a clash, most often) are a refusal,
    // never signal: a Convex save waits out a lost connection.
    refused.mockClear()
    const unsaved = draftPreviewSource('draft-preview:r8:2', {
      flush: () => Promise.resolve(false),
      render: () => Promise.resolve({ url: nextUrl() }),
      refused,
    })
    await expect(
      unsaved.load(noProgress, new AbortController().signal),
    ).rejects.toThrow(/haven’t saved/)
    expect(refused).toHaveBeenCalledTimes(1)
    expect(refused.mock.calls[0][0]).toMatch(/haven’t saved/)
  })

  test('a lost connection stays with the viewer, whose Try again may mend it', async () => {
    const refused = vi.fn()
    fetchMock.mockRejectedValueOnce(
      new FileTransferError(
        'network',
        'The download stopped arriving. Check your signal and try again.',
      ),
    )
    const dropped = draftPreviewSource('draft-preview:r9:1', {
      flush: () => Promise.resolve(true),
      render: () => Promise.resolve({ url: nextUrl() }),
      refused,
    })
    await expect(
      dropped.load(noProgress, new AbortController().signal),
    ).rejects.toThrow(/signal/)

    const lost = draftPreviewSource('draft-preview:r9:2', {
      flush: () => Promise.resolve(true),
      render: () =>
        Promise.reject(new Error('Connection lost while action was in flight')),
      refused,
    })
    await expect(
      lost.load(noProgress, new AbortController().signal),
    ).rejects.toThrow('No signal. Try again when you have some.')
    expect(refused).not.toHaveBeenCalled()
  })

  test('closing the viewer mid-load is not a failure to report', async () => {
    const refused = vi.fn()
    const controller = new AbortController()
    const source = draftPreviewSource('draft-preview:r10:1', {
      flush: () => Promise.resolve(true),
      render: () => {
        controller.abort()
        return Promise.reject(new ConvexError('REPORT_FINALISED'))
      },
      refused,
    })
    await expect(source.load(noProgress, controller.signal)).rejects.toThrow(
      ConvexError,
    )
    expect(refused).not.toHaveBeenCalled()
  })

  test('a drawing with no file, or a report locked meanwhile, is said plainly', async () => {
    const noFile = draftPreviewSource('draft-preview:r7:1', {
      flush: () => Promise.resolve(true),
      render: () => Promise.resolve({ url: null }),
    })
    await expect(
      noFile.load(noProgress, new AbortController().signal),
    ).rejects.toThrow('The preview didn’t finish drawing. Try again.')

    const locked = draftPreviewSource('draft-preview:r7:2', {
      flush: () => Promise.resolve(true),
      render: () => Promise.reject(new ConvexError('REPORT_FINALISED')),
    })
    await expect(
      locked.load(noProgress, new AbortController().signal),
    ).rejects.toThrow(/has just been locked/)
  })
})
