import { useEffect, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Segmented } from '../../primitives/Segmented'
import { AnnotationOverlay } from './AnnotationOverlay'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * Self-hosted, not a CDN — this app already compresses photos client-side
 * specifically because technicians are often on patchy mobile data, and a
 * third-party round trip just to make the viewer function would contradict
 * that. `pdfjs-dist` is pinned to the exact version `react-pdf` bundles
 * internally (see package.json) — a mismatch between this worker and
 * react-pdf's own API throws at runtime, it doesn't degrade gracefully.
 */
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const ZOOM_STOPS = [
  { value: 'fit' as const, label: 'Fit' },
  { value: 'medium' as const, label: '1.5x' },
  { value: 'large' as const, label: '2x' },
]
type Zoom = (typeof ZOOM_STOPS)[number]['value']
const ZOOM_FACTOR: Record<Zoom, number> = { fit: 1, medium: 1.5, large: 2 }

/**
 * Only ever rendered client-side, lazily, from `ReportActionBar.tsx` — never
 * imported during SSR. `pdfjs-dist` touches browser globals (`DOMMatrix`,
 * worker construction) that don't exist under Node, so this isn't a
 * degraded-experience risk if it slips into the server render, it's a crash.
 */
export function PdfViewer({
  businessId,
  reportId,
  url,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  url: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [failed, setFailed] = useState(false)
  const [renderedSize, setRenderedSize] = useState<{
    width: number
    height: number
  } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setContainerWidth(width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={containerRef}
        className="overflow-auto rounded-xl border border-hairline bg-surface-3"
      >
        <Document
          file={url}
          onLoadSuccess={(doc) => setNumPages(doc.numPages)}
          onLoadError={() => setFailed(true)}
          loading={
            <p className="p-8 text-center text-caption text-muted">
              Loading PDF…
            </p>
          }
          error={
            <p className="p-8 text-center text-caption text-amber-ink">
              Could not load the PDF.
            </p>
          }
        >
          {containerWidth > 0 && (
            <div className="relative inline-block">
              <Page
                pageNumber={page}
                width={containerWidth * ZOOM_FACTOR[zoom]}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                onRenderSuccess={(rendered) =>
                  setRenderedSize({ width: rendered.width, height: rendered.height })
                }
              />
              {renderedSize && (
                <AnnotationOverlay
                  key={`${page}-${zoom}`}
                  businessId={businessId}
                  reportId={reportId}
                  page={page}
                  width={renderedSize.width}
                  height={renderedSize.height}
                />
              )}
            </div>
          )}
        </Document>
      </div>

      {failed && (
        <p role="alert" className="text-center text-caption text-amber-ink">
          Could not load the PDF. Check your connection and try again.
        </p>
      )}

      {numPages > 0 && (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            aria-label="Previous page"
            className="flex size-9 items-center justify-center rounded-full bg-surface-2 text-ink transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
          <span className="text-caption text-muted">
            Page {page} of {numPages}
          </span>
          <button
            type="button"
            disabled={page >= numPages}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next page"
            className="flex size-9 items-center justify-center rounded-full bg-surface-2 text-ink transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronRight size={16} strokeWidth={2} />
          </button>
        </div>
      )}

      <Segmented label="Zoom" value={zoom} options={ZOOM_STOPS} onChange={setZoom} />
    </div>
  )
}
