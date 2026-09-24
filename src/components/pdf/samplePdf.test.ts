import { describe, expect, it } from 'vitest'
import { samplePdf, samplePdfHeading } from '../../../e2e/fixtures/pdf'

/**
 * The e2e fixture PDF, read back by the same pdf.js the viewer uses.
 *
 * Every viewer spec leans on this file being a real PDF — a page count, text
 * on each page, an em dash that survives the trip — so a malformed one would
 * show up as a flaky viewer rather than a broken fixture. Parsing it here,
 * with pdf.js told to stop at the first error instead of repairing around it,
 * keeps the blame where it belongs.
 */

async function open(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise
}

async function pageText(bytes: Uint8Array, page: number): Promise<string> {
  const doc = await open(bytes)
  const content = await (await doc.getPage(page)).getTextContent()
  const text = content.items
    .map((item) => ('str' in item ? item.str : ''))
    .join(' ')
  await doc.destroy()
  return text.replace(/\s+/g, ' ')
}

describe('samplePdf', () => {
  it('opens with two pages by default', async () => {
    const doc = await open(samplePdf())
    expect(doc.numPages).toBe(2)
    const viewport = (await doc.getPage(1)).getViewport({ scale: 1 })
    expect([viewport.width, viewport.height]).toEqual([595, 842])
    await doc.destroy()
  })

  it('prints a heading, em dash included, on each page', async () => {
    const bytes = samplePdf()
    expect(await pageText(bytes, 1)).toContain('Page 1 — First aid measures')
    expect(await pageText(bytes, 2)).toContain(
      'Page 2 — Personal protective equipment',
    )
    expect(samplePdfHeading(2)).toBe('Page 2 — Personal protective equipment')
  })

  it('keeps one phrase to page 1, for a search that wants one match', async () => {
    const bytes = samplePdf()
    expect(await pageText(bytes, 1)).toContain('Do NOT induce vomiting')
    expect(await pageText(bytes, 2)).not.toContain('vomiting')
  })

  it('builds as many pages as asked, at the size asked', async () => {
    const doc = await open(samplePdf({ pages: 12, width: 842, height: 595 }))
    expect(doc.numPages).toBe(12)
    const viewport = (await doc.getPage(12)).getViewport({ scale: 1 })
    expect([viewport.width, viewport.height]).toEqual([842, 595])
    await doc.destroy()
  })

  it('escapes parentheses and backslashes in custom text', async () => {
    const bytes = samplePdf({
      pages: 1,
      lines: () => ['Section (4) \\ first aid', 'Café – “quoted”'],
    })
    const text = await pageText(bytes, 1)
    expect(text).toContain('Section (4) \\ first aid')
    expect(text).toContain('Café – “quoted”')
  })

  it('refuses a character the standard fonts cannot print', () => {
    expect(() => samplePdf({ lines: () => ['Ω'] })).toThrow(/WinAnsi/)
  })

  it('points every cross-reference entry at its object', () => {
    const text = Buffer.from(samplePdf({ pages: 3 })).toString('latin1')
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')

    const entries = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n \n/g)]
    expect(entries).toHaveLength(3 * 2 + 3)
    entries.forEach(([, offset], i) => {
      expect(text.slice(Number(offset)).startsWith(`${i + 1} 0 obj\n`)).toBe(
        true,
      )
    })
  })
})
