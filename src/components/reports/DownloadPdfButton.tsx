import { useState } from 'react'
import { Download } from 'lucide-react'
import type { PdfReport } from './pdf/ReportPdf'

/**
 * @react-pdf/renderer is a large dependency and only matters at the moment
 * someone actually exports, so it is imported on click rather than shipped in
 * the bundle every field tech loads on mobile data.
 */
export function DownloadPdfButton({
  report,
  fileName,
}: {
  report: PdfReport
  fileName: string
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onDownload() {
    setBusy(true)
    setFailed(false)
    try {
      const [{ pdf }, { ReportPdf }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./pdf/ReportPdf'),
      ])

      const blob = await pdf(<ReportPdf report={report} />).toBlob()
      const url = URL.createObjectURL(blob)

      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      link.click()

      URL.revokeObjectURL(url)
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
