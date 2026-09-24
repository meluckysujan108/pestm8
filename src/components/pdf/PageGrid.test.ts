import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drawThumbnails } from './PageGrid'
import type { PDFDocumentProxy } from './pdfjs'

/**
 * The page grid's thumbnails, drawn with a stand-in for pdf.js and the DOM.
 *
 * What is checked is what the grid gives back. A pdf.js render keeps the
 * page's decoded images until `page.cleanup()` — for a scanned SDS, one
 * full-size image per page — so a grid that never calls it holds every page
 * it has shown, and an iPhone kills the app long before the viewer closes.
 */

type FakePage = {
  cleanup: ReturnType<typeof vi.fn>
  finish: () => void
  cancelled: boolean
}

function fakeDoc(pageCount: number, { hold = false } = {}) {
  const pages: Array<FakePage> = []
  for (let i = 0; i < pageCount; i++) {
    let finish = () => {}
    let fail: (error: Error) => void = () => {}
    const promise = new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    if (!hold) finish()
    const page: FakePage = {
      cleanup: vi.fn(),
      finish,
      cancelled: false,
    }
    Object.assign(page, {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: () => ({
        promise,
        cancel: () => {
          page.cancelled = true
          const error = new Error('Rendering cancelled')
          error.name = 'RenderingCancelledException'
          fail(error)
        },
      }),
    })
    pages.push(page)
  }
  const doc = {
    getPage: (n: number) => Promise.resolve(pages[n - 1]),
  } as unknown as PDFDocumentProxy
  return { doc, pages }
}

function fakeRoot(count: number) {
  const els = Array.from({ length: count }, (_, i) => ({
    dataset: { thumb: String(i) },
    clientWidth: 120,
    appendChild: vi.fn(),
  }))
  return {
    root: { querySelectorAll: () => els } as unknown as HTMLElement,
    els,
  }
}

function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    style: { cssText: '' },
    setAttribute: () => {},
    remove: () => {},
  }
}

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.stubGlobal('document', { createElement: fakeCanvas })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('drawThumbnails', () => {
  it('lets pdf.js free each page once its thumbnail is drawn', async () => {
    const { doc, pages } = fakeDoc(4)
    const { root, els } = fakeRoot(4)
    const stop = drawThumbnails(doc, root)
    await settle()
    // Drawn — two at a time, so all four took a few turns.
    for (const el of els) expect(el.appendChild).toHaveBeenCalledTimes(1)
    for (const page of pages) expect(page.cleanup).toHaveBeenCalled()
    stop()
  })

  it('lets pdf.js free a page whose draw was cut short by the grid closing', async () => {
    const { doc, pages } = fakeDoc(2, { hold: true })
    const { root } = fakeRoot(2)
    const stop = drawThumbnails(doc, root)
    await settle()
    for (const page of pages) expect(page.cleanup).not.toHaveBeenCalled()
    stop()
    await settle()
    for (const page of pages) {
      expect(page.cancelled).toBe(true)
      expect(page.cleanup).toHaveBeenCalled()
    }
  })
})
