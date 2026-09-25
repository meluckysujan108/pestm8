import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  DAMAGED,
  LOADING,
  askPassword,
  checkPassword,
  downloadFailed,
} from './documentState'
import { openPdf } from './pdfjs'
import type { DocumentState } from './documentState'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from './pdfjs'
import type { DocumentSource } from './types'
import type { PageSize } from './layout'

export type { DocumentState } from './documentState'

/**
 * Fetches the bytes and opens them with pdf.js, for one `source.key` at a
 * time.
 *
 * Everything is keyed by the source (and by `attempt`, which "Try again"
 * bumps): when the key changes — someone replaced the file while it was open
 * — the old download is aborted and the old document destroyed, and the new
 * one starts from nothing. State from a previous key is never shown: it is
 * stored with the key it belongs to, and a mismatch reads as loading.
 *
 * The Blob is kept for Share and Save, which need the file itself. pdf.js
 * gets a copy of its bytes, because it detaches (empties) the buffer it is
 * handed.
 */
export function usePdfDocument(
  source: DocumentSource,
  attempt: number,
): {
  state: DocumentState
  blob: Blob | null
  submitPassword: (password: string) => void
} {
  const token = `${attempt}\n${source.key}`
  const [snapshot, setSnapshot] = useState<{
    token: string
    state: DocumentState
    blob: Blob | null
  } | null>(null)
  const passwordRef = useRef<((password: string) => void) | null>(null)

  // The caller may pass a new `load` function every render; only the key
  // decides when to load again.
  const loadRef = useRef(source.load)
  useLayoutEffect(() => {
    loadRef.current = source.load
  })

  useEffect(() => {
    const run = { cancelled: false }
    const controller = new AbortController()
    let task: PDFDocumentLoadingTask | null = null
    let blob: Blob | null = null
    const show = (state: DocumentState) => {
      if (!run.cancelled) setSnapshot({ token, state, blob })
    }

    const go = async () => {
      try {
        blob = await loadRef.current(
          // A progress report that straggles in after the file has arrived
          // would put the viewer back to "Loading" with nothing to end it.
          (progress) => {
            if (!blob) show({ phase: 'loading', progress })
          },
          controller.signal,
        )
      } catch (error) {
        show(downloadFailed(error))
        return
      }
      // Share and Save work from here on, even if pdf.js then cannot read it.
      show(LOADING)
      try {
        const data = new Uint8Array(await blob.arrayBuffer())
        if (run.cancelled) return
        task = openPdf(data, ({ wrong, submit }) => {
          passwordRef.current = submit
          show(askPassword(wrong))
        })
        const doc = await task.promise
        const first = (await doc.getPage(1)).getViewport({ scale: 1 })
        show({
          phase: 'ready',
          doc,
          firstPage: { width: first.width, height: first.height },
        })
      } catch {
        show(DAMAGED)
      }
    }
    void go()

    return () => {
      run.cancelled = true
      controller.abort()
      passwordRef.current = null
      // Destroys the document too, and terminates its worker.
      void task?.destroy()
    }
  }, [token])

  const current = snapshot?.token === token ? snapshot : null

  const submitPassword = useCallback(
    (password: string) => {
      const submit = passwordRef.current
      if (!submit) return
      // One try per question: pdf.js asks again (with a new `submit`) if
      // this one is wrong.
      passwordRef.current = null
      setSnapshot((prev) =>
        prev && prev.token === token
          ? { ...prev, state: checkPassword(prev.state) }
          : prev,
      )
      submit(password)
    },
    [token],
  )

  return {
    state: current?.state ?? LOADING,
    blob: current?.blob ?? null,
    submitPassword,
  }
}

const NO_PAGES: PageSize[] = []

/**
 * Every page's size. Page 1's is known before the viewer shows anything;
 * the rest are read in the background, and until each arrives it is assumed
 * to be page 1's shape — right for nearly every safety data sheet, and the
 * scroller keeps its place when an estimate is corrected.
 *
 * Takes no document (and returns no pages) until one is open, so the viewer
 * can call it unconditionally.
 */
export function usePageSizes(
  doc: PDFDocumentProxy | null,
  firstPage: PageSize | null,
): PageSize[] {
  const estimate = useMemo(
    () =>
      doc && firstPage
        ? Array.from({ length: doc.numPages }, () => firstPage)
        : NO_PAGES,
    [doc, firstPage],
  )
  const [loaded, setLoaded] = useState<{
    doc: PDFDocumentProxy
    sizes: PageSize[]
  } | null>(null)

  useEffect(() => {
    if (!doc) return
    const run = { cancelled: false }
    const go = async () => {
      const sizes = estimate.slice()
      let changed = false
      let flushedAt = performance.now()
      for (let i = 1; i < doc.numPages; i++) {
        const viewport = (await doc.getPage(i + 1)).getViewport({ scale: 1 })
        if (run.cancelled) return
        if (
          viewport.width !== sizes[i].width ||
          viewport.height !== sizes[i].height
        ) {
          sizes[i] = { width: viewport.width, height: viewport.height }
          changed = true
        }
        // In batches: each one is a re-layout.
        if (changed && performance.now() - flushedAt > 250) {
          setLoaded({ doc, sizes: sizes.slice() })
          changed = false
          flushedAt = performance.now()
        }
      }
      if (changed) setLoaded({ doc, sizes: sizes.slice() })
    }
    // A page that will not open keeps its estimate; the renderer reports it.
    go().catch(() => {})
    return () => {
      run.cancelled = true
    }
  }, [doc, estimate])

  return doc && loaded?.doc === doc ? loaded.sizes : estimate
}
