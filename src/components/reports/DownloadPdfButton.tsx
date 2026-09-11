import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexAction } from '@convex-dev/react-query'
import { Download } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * PDF generation moved server-side (Phase 5) — `@react-pdf/renderer` runs
 * inside a Convex Node action now, which is what makes a fixed header/footer
 * and real `Page X of Y` numbers possible at all (see `layout.tsx`; both
 * silently render as nothing in the browser build this button used to import
 * on click). A finalised report's data never changes, so the action's output
 * is cached on `reports.pdfStorageId` — `pdfUrl` is null only the first time
 * anyone downloads a given report.
 */
export function DownloadPdfButton({
  businessId,
  reportId,
  pdfUrl,
  fileName,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  pdfUrl: string | null
  fileName: string
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const convexGenerate = useConvexAction(api.reportPdf.generate)
  const generate = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
    }) => convexGenerate(args),
  })

  async function onDownload() {
    setBusy(true)
    setFailed(false)
    try {
      const url =
        pdfUrl ?? (await generate.mutateAsync({ businessId, reportId })).url
      if (!url) throw new Error('no pdf url')

      const res = await fetch(url)
      if (!res.ok) throw new Error('fetch failed')
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)

      const link = document.createElement('a')
      link.href = objectUrl
      link.download = fileName
      link.click()

      URL.revokeObjectURL(objectUrl)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onDownload}
        disabled={busy}
        className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-[17px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
      >
        <Download size={17} strokeWidth={1.7} />
        {busy ? 'Preparing…' : 'Download PDF'}
      </button>
      {failed && (
        <p
          role="alert"
          className="mt-2 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          Could not generate the PDF. Try again once you have signal.
        </p>
      )}
    </>
  )
}
