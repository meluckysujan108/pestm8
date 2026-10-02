import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FileTransferError,
  asPdfFile,
  fetchWithProgress,
  isAbortError,
  savePdf,
  sharePdf,
} from '#/lib/pdfFiles'
import { recallPdf, rememberPdf } from '#/lib/pdfMemory'
import { isGestureExpired, preparingLabel } from '#/lib/shareGesture'
import type { LoadProgress } from '#/components/pdf/types'
import type { ReportPdf } from './useReportPdf'

/**
 * Share (or, where the phone has no share sheet for files, Download) from the
 * finished report's own page — one tap, where it was three (the PDF tab,
 * View PDF, then Share in the viewer).
 *
 * The same rule as the Products page (`products/usePdfActions.ts` has the
 * detail): Safari opens the share sheet only inside the tap that asked, so
 *
 *  - bytes already on the phone (the viewer opened earlier this visit, or an
 *    earlier tap here) are handed over at once, nothing awaited first;
 *  - otherwise the tap downloads them, the button counts ("Preparing… 40%"),
 *    and they are handed over when they land. If that tap has expired by
 *    then, the button asks for one more ("Tap to share"), which shares from
 *    memory at once.
 *
 * The bytes are kept in the page's PDF memory under their URL, which is where
 * the viewer looks first: sharing and then opening costs one download.
 */

export type HandOverPurpose = 'share' | 'save'

type Prep =
  | { phase: 'idle' }
  | { phase: 'preparing'; progress: LoadProgress | null }
  /** The bytes are here; the tap that asked for them has expired. */
  | { phase: 'again' }
  | { phase: 'failed'; problem: string }

const IDLE: Prep = { phase: 'idle' }

const FAILED: Record<HandOverPurpose, string> = {
  share:
    'Could not share the PDF. Try again, or open it and share it from there.',
  save: 'Could not save the PDF. Try again, or open it and save it from there.',
}

export function useReportHandOver({
  pdf,
  fileName,
  title,
  purpose,
}: {
  pdf: ReportPdf
  fileName: string
  title: string
  purpose: HandOverPurpose
}) {
  const [prep, setPrep] = useState<Prep>(IDLE)
  const abort = useRef<AbortController | null>(null)
  // Read in handlers and in the download's callbacks, which outlive the
  // render that started them.
  const latest = useRef({ pdf, fileName, title, purpose, prep })
  useEffect(() => {
    latest.current = { pdf, fileName, title, purpose, prep }
  })

  useEffect(
    () => () => {
      abort.current?.abort()
      abort.current = null
    },
    [],
  )

  /**
   * Hands the bytes over. `fresh` is whether this is still the tap that asked
   * (nothing was awaited): a refusal then is a real failure, while after a
   * download it is most likely the tap having expired.
   */
  const deliver = useCallback((blob: Blob, fresh: boolean) => {
    const now = latest.current
    const file = asPdfFile(blob, now.fileName)
    let pending: Promise<unknown>
    // Each of these calls `navigator.share()` before its first await.
    try {
      pending =
        now.purpose === 'share'
          ? sharePdf(file, { title: now.title })
          : Promise.resolve(savePdf(file))
    } catch (error) {
      pending = Promise.reject(error)
    }
    pending.then(
      () => setPrep(IDLE),
      (error: unknown) =>
        setPrep(
          !fresh && isGestureExpired(error)
            ? { phase: 'again' }
            : { phase: 'failed', problem: FAILED[latest.current.purpose] },
        ),
    )
  }, [])

  /** What the button's tap calls. Never awaits before handing over. */
  const run = useCallback(() => {
    if (abort.current) {
      // A tap while preparing: stop.
      abort.current.abort()
      abort.current = null
      setPrep(IDLE)
      return
    }
    const now = latest.current
    const known = now.pdf.status.phase === 'ready' ? now.pdf.status.url : null
    const held = recallPdf(known)
    if (held) {
      setPrep(IDLE)
      deliver(held, true)
      return
    }

    const controller = new AbortController()
    const stopped = () => controller.signal.aborted
    abort.current = controller
    setPrep({ phase: 'preparing', progress: null })
    now.pdf
      .ensure()
      .then(
        async (url) => {
          const blob =
            recallPdf(url) ??
            (await fetchWithProgress(
              url,
              (progress) => {
                if (!stopped()) setPrep({ phase: 'preparing', progress })
              },
              controller.signal,
            ))
          rememberPdf(url, blob)
          if (stopped()) return
          abort.current = null
          deliver(blob, false)
        },
        () => {
          // The PDF could not be prepared at all: the card already says so,
          // with its own Try again, and a second "could not" here would
          // outlive that one's success.
          if (stopped()) return
          abort.current = null
          setPrep(IDLE)
        },
      )
      .catch((error: unknown) => {
        if (stopped() || isAbortError(error)) return
        abort.current = null
        setPrep({
          phase: 'failed',
          problem:
            error instanceof FileTransferError
              ? error.message
              : 'Could not download the PDF. Check your signal and try again.',
        })
      })
  }, [deliver])

  /** The button's words, given what it says when idle. */
  const label = (idle: string): string => {
    switch (prep.phase) {
      case 'preparing':
        return preparingLabel(prep.progress)
      case 'again':
        return purpose === 'save' ? 'Tap to save' : 'Tap to share'
      default:
        return idle
    }
  }

  return {
    run,
    label,
    preparing: prep.phase === 'preparing',
    problem: prep.phase === 'failed' ? prep.problem : null,
  }
}
