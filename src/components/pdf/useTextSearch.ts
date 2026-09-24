import { useEffect, useMemo, useRef, useState } from 'react'
import { findInPage, foldQuery, indexPageText, rangeRect } from './textSearch'
import type { PDFDocumentProxy, PDFPageProxy } from './pdfjs'
import type { PageRect, PageTextIndex, ViewportLike } from './textSearch'

type ContentItem = Awaited<
  ReturnType<PDFPageProxy['getTextContent']>
>['items'][number]
type TextItem = Extract<ContentItem, { str: string }>
type FontStyle = { ascent?: number; vertical?: boolean }

type PageText = {
  items: TextItem[]
  index: PageTextIndex
  viewport: ViewportLike
  styles: Record<string, FontStyle | undefined>
}

export type SearchMatch = {
  /** 0-based. */
  page: number
  /** Where to highlight, one rectangle per text item the match touches. */
  rects: PageRect[]
}

export type SearchResult = {
  /** In reading order. Grows while pages are still being read. */
  matches: SearchMatch[]
  /** Pages read so far, of `total`. */
  searched: number
  total: number
  done: boolean
  /** False once every page has been read and none had any text: a scan. */
  hasText: boolean
}

const NOTHING_FOUND: SearchResult = {
  matches: [],
  searched: 0,
  total: 0,
  done: false,
  hasText: true,
}

const NO_TEXT: PageText = {
  items: [],
  index: indexPageText([]),
  viewport: { transform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 },
  styles: {},
}

/** One page's text, or none if it cannot be read — it is then not searched. */
async function readPage(doc: PDFDocumentProxy, i: number): Promise<PageText> {
  try {
    const page = await doc.getPage(i + 1)
    const content = await page.getTextContent()
    const items = content.items.filter(
      (item): item is TextItem => 'str' in item,
    )
    const viewport = page.getViewport({ scale: 1 })
    return {
      items,
      index: indexPageText(items),
      viewport: {
        transform: viewport.transform,
        width: viewport.width,
        height: viewport.height,
      },
      styles: content.styles,
    }
  } catch {
    return NO_TEXT
  }
}

/**
 * Search across the whole document.
 *
 * Text is read lazily — nothing until search is first opened, then every
 * page in the background, in order, a page at a time with a pause between so
 * scrolling never stutters behind it — and kept for as long as the document
 * is open, so the next search is instant. Results grow as pages arrive; the
 * pages already matched for the current search are not matched again.
 */
export function useTextSearch(
  doc: PDFDocumentProxy | null,
  active: boolean,
  query: string,
): SearchResult {
  const pagesRef = useRef<{
    doc: PDFDocumentProxy
    pages: Map<number, PageText>
  } | null>(null)
  const matchesRef = useRef<{
    doc: PDFDocumentProxy
    query: string
    pages: Map<number, SearchMatch[]>
  } | null>(null)
  // Bumped as pages are read, so the matches below are recomputed.
  const [version, setVersion] = useState(0)

  const pagesFor = (d: PDFDocumentProxy) => {
    if (pagesRef.current?.doc !== d) {
      pagesRef.current = { doc: d, pages: new Map() }
    }
    return pagesRef.current.pages
  }

  useEffect(() => {
    if (!active || !doc) return
    let cancelled = false
    // A function, so each check re-reads the flag after an `await` rather
    // than trusting what it was before it.
    const stopped = () => cancelled
    const pages = pagesFor(doc)
    const go = async () => {
      let bumpedAt = performance.now()
      for (let i = 0; i < doc.numPages; i++) {
        if (pages.has(i)) continue
        pages.set(i, await readPage(doc, i))
        if (stopped()) return
        if (performance.now() - bumpedAt > 120) {
          setVersion((v) => v + 1)
          bumpedAt = performance.now()
        }
        // Let a frame of scrolling through between pages.
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (stopped()) return
      }
      setVersion((v) => v + 1)
    }
    void go()
    return () => {
      cancelled = true
    }
  }, [doc, active])

  return useMemo(() => {
    if (!doc) return NOTHING_FOUND
    const pages = pagesFor(doc)
    const folded = foldQuery(query)
    if (
      matchesRef.current?.doc !== doc ||
      matchesRef.current.query !== folded
    ) {
      matchesRef.current = { doc, query: folded, pages: new Map() }
    }
    const cache = matchesRef.current.pages
    const matches: SearchMatch[] = []
    let hasText = false
    for (let i = 0; i < doc.numPages; i++) {
      const text = pages.get(i)
      if (!text) continue
      if (text.index.hasText) hasText = true
      if (!folded) continue
      let found = cache.get(i)
      if (!found) {
        found = findInPage(text.index, text.items, folded).map((match) => ({
          page: i,
          rects: match.ranges.map(({ item, from, to }) => {
            const source = text.items[item]
            const style = text.styles[source.fontName]
            return rangeRect(source, from, to, text.viewport, {
              ascent: style?.ascent,
              vertical: style?.vertical,
            })
          }),
        }))
        cache.set(i, found)
      }
      // A loop, not push(...found): "e" can match tens of thousands of times.
      for (const match of found) matches.push(match)
    }
    return {
      matches,
      searched: pages.size,
      total: doc.numPages,
      done: pages.size >= doc.numPages,
      hasText,
    }
    // `version` is how this learns that `pages` has grown.
  }, [doc, query, version])
}
