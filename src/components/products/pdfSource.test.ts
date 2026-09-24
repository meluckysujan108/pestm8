import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchWithProgress } from '#/lib/pdfFiles'
import { readKeptPdf } from '#/lib/keptProducts'
import { KEPT_FALLBACK_STALL_MS, pdfSourceFor } from './pdfSource'
import type * as PdfFilesModule from '#/lib/pdfFiles'
import type { KeptProduct } from '#/lib/keptProducts'
import type { ShownProduct } from './model'

// The network and the phone's storage, stood in for: what is under test is
// which one the viewer is sent to, and how patient it is on the way.
vi.mock('#/lib/keptProducts', () => ({ readKeptPdf: vi.fn() }))
vi.mock('#/lib/pdfFiles', async (importOriginal) => ({
  ...(await importOriginal<PdfFiles>()),
  fetchWithProgress: vi.fn(),
}))

type PdfFiles = typeof PdfFilesModule

const fetchMock = vi.mocked(fetchWithProgress)
const readKeptMock = vi.mocked(readKeptPdf)

let serial = 0
/** Fresh URLs per test: the page's PDF memory outlives each one. */
const nextUrl = () => {
  serial += 1
  return `https://files.example/pdf-${serial}`
}

function product(
  url: string,
  keptUrl: string | null,
): { shown: ShownProduct; keptBlob: Blob | null } {
  const kept: KeptProduct | null = keptUrl
    ? {
        productId: `p-${serial}`,
        businessId: 'b1',
        name: 'Termidor',
        description: null,
        url: null,
        fileName: 'Termidor SDS.pdf',
        size: 8,
        pdfUrl: keptUrl,
        photoUrl: null,
        keptAt: 0,
      }
    : null
  const keptBlob = keptUrl
    ? new Blob(['%PDF-old'], { type: 'application/pdf' })
    : null
  readKeptMock.mockResolvedValue(
    keptBlob && keptUrl ? { blob: keptBlob, pdfUrl: keptUrl } : null,
  )
  return {
    keptBlob,
    shown: {
      id: `p-${serial}`,
      name: 'Termidor',
      description: null,
      url: null,
      photoUrl: null,
      hasKeptPhoto: false,
      pdf: { url, fileName: 'Termidor SDS.pdf', size: 8 },
      canEdit: false,
      live: null,
      kept,
    },
  }
}

const noProgress = () => {}

beforeEach(() => {
  fetchMock.mockReset()
  readKeptMock.mockReset()
})

describe('pdfSourceFor', () => {
  test('a superseded kept copy waits behind the download, which may not stall for long', async () => {
    const url = nextUrl()
    const { shown, keptBlob } = product(url, nextUrl())
    // One bar: the download stops arriving and the stall limit gives up.
    fetchMock.mockRejectedValue(new Error('The download stopped arriving.'))
    const source = pdfSourceFor('b1', shown, () => true)
    const blob = await source?.load(noProgress, new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      noProgress,
      expect.any(AbortSignal),
      { stallMs: KEPT_FALLBACK_STALL_MS },
    )
    // The older copy, rather than an error.
    expect(blob).toBe(keptBlob)
  })

  test('with nothing kept there is nothing to fall back on, so no limit', async () => {
    const url = nextUrl()
    const { shown } = product(url, null)
    const fresh = new Blob(['%PDF-new'], { type: 'application/pdf' })
    fetchMock.mockResolvedValue(fresh)
    const source = pdfSourceFor('b1', shown, () => true)
    const blob = await source?.load(noProgress, new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      noProgress,
      expect.any(AbortSignal),
      undefined,
    )
    expect(blob).toBe(fresh)
  })

  test('with no signal a superseded kept copy opens without trying the network', async () => {
    const { shown, keptBlob } = product(nextUrl(), nextUrl())
    const source = pdfSourceFor('b1', shown, () => false)
    const blob = await source?.load(noProgress, new AbortController().signal)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(blob).toBe(keptBlob)
  })

  test('a kept copy of the current file opens without the network', async () => {
    const url = nextUrl()
    const { shown, keptBlob } = product(url, url)
    const source = pdfSourceFor('b1', shown, () => true)
    const blob = await source?.load(noProgress, new AbortController().signal)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(blob).toBe(keptBlob)
  })

  test('closing the viewer mid-download is not answered with the kept copy', async () => {
    const { shown } = product(nextUrl(), nextUrl())
    const controller = new AbortController()
    fetchMock.mockImplementation(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
    const source = pdfSourceFor('b1', shown, () => true)
    await expect(
      source?.load(noProgress, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(readKeptMock).not.toHaveBeenCalled()
  })
})
