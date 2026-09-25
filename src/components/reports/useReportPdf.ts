import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useConvexAction } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import {
  PdfProblem,
  createInFlight,
  phoneIsOffline,
  reportPdfProblem,
} from './reportPdfModel'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * One render per report at a time, for everyone on the page who asks — the
 * PDF tab as it opens, the viewer as it loads (`createInFlight` has why).
 * Module-wide rather than per component, so a viewer opened straight from a
 * link, before the tab has ever mounted, still shares with the tab after.
 */
const generating = createInFlight<string>()

export type ReportPdfStatus =
  | { phase: 'ready'; url: string }
  | { phase: 'preparing' }
  | { phase: 'failed'; problem: string }

export type ReportPdf = {
  status: ReportPdfStatus
  /**
   * The PDF's URL: the one the page has, or the one render for this report,
   * started now or joined if someone else started it. Rejects with the
   * server's refusal; `status` then carries it in plain words.
   */
  ensure: () => Promise<string>
}

/**
 * A finalised report's PDF, as the page knows it.
 *
 * `reports.get` hands back `pdfUrl` only while the stored file is one the
 * current painter drew. Null is the signal to go and draw it — the first
 * look at a report, and the first after `RENDER_VERSION` is bumped — which is
 * `reportPdf.generate`. The URL that comes back is held here until the
 * report's subscription catches up with the same file.
 */
export function useReportPdf({
  businessId,
  reportId,
  pdfUrl,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  pdfUrl: string | null
}): ReportPdf {
  const generate = useConvexAction(api.reportPdf.generate)
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const url = pdfUrl ?? generatedUrl

  // Read when asked, not when `ensure` was made: the viewer calls it from a
  // load that outlives the render that built it.
  const latest = useRef({ url, generate })
  useLayoutEffect(() => {
    latest.current = { url, generate }
  })

  const ensure = useCallback((): Promise<string> => {
    const known = latest.current.url
    if (known) return Promise.resolve(known)
    setProblem(null)
    return generating(reportId, async () => {
      const result = await latest.current.generate({ businessId, reportId })
      if (!result.url) throw new PdfProblem('NO_URL')
      return result.url
    }).then(
      (made) => {
        setGeneratedUrl(made)
        return made
      },
      (error: unknown) => {
        setProblem(reportPdfProblem(error, phoneIsOffline()))
        throw error
      },
    )
  }, [businessId, reportId])

  const status: ReportPdfStatus = url
    ? { phase: 'ready', url }
    : problem !== null
      ? { phase: 'failed', problem }
      : { phase: 'preparing' }

  return { status, ensure }
}
