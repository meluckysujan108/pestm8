import { fetchWithProgress, isAbortError } from '#/lib/pdfFiles'
import { recallPdf, rememberPdf } from '#/lib/pdfMemory'
import {
  PdfProblem,
  isSignalProblem,
  phoneIsOffline,
  previewProblem,
  reportPdfProblem,
} from './reportPdfModel'
import type { DocumentSource } from '#/components/pdf/types'

/**
 * Where the viewer gets a report's bytes from — a finalised report's PDF, or
 * a draft's watermarked preview. Plain functions rather than hooks, so the
 * page can build one once and the viewer can call it whenever it loads.
 *
 * Both reject with plain words (`reportPdfModel.ts`) and let an abort through
 * untouched: the viewer gave up, and there is nothing to say.
 */

/**
 * A finalised report's PDF.
 *
 * `key` is the report, not the file's URL. The URL flips when the report's
 * subscription catches up with a render this page asked for — null, then the
 * generated URL, then the same file from `reports.get` — and the viewer starts
 * over whenever its key changes. The document behind a finalised report never
 * changes (a correction is a new report), so the report IS the identity of the
 * bytes: it keeps the reading position, and it keeps the viewer steady.
 *
 * `ensureUrl` hands back the URL the page has now, or starts (or joins) the
 * one render for the report — read when the viewer loads, not when this was
 * made. The bytes are kept in the page's PDF memory under that URL, so
 * opening the viewer again this visit costs no second download, and Share
 * has the file in hand inside the tap.
 */
export function reportPdfSource(
  reportId: string,
  ensureUrl: () => Promise<string>,
): DocumentSource {
  return {
    key: `report:${reportId}`,
    load: async (onProgress, signal) => {
      let url: string
      try {
        url = await ensureUrl()
      } catch (error) {
        throw new Error(reportPdfProblem(error, phoneIsOffline()), {
          cause: error,
        })
      }
      const held = recallPdf(url)
      if (held) return held
      try {
        const blob = await fetchWithProgress(url, onProgress, signal)
        rememberPdf(url, blob)
        return blob
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        throw new Error(reportPdfProblem(error, phoneIsOffline()), {
          cause: error,
        })
      }
    },
  }
}

/**
 * A draft's preview: the answers on screen saved first, then drawn on the
 * server with DRAFT across every page, then downloaded.
 *
 * `key` is new for every opening (the caller's nonce): a preview is drawn
 * from the answers as they are at that moment, so a second look after an edit
 * must not come back as the first one. Not kept in the PDF memory either —
 * nobody shares a preview, and it would push out a real document someone is
 * about to.
 *
 * `refused` hears of every failure that is not the signal's
 * (`isSignalProblem`), in words, before the load rejects. The viewer's error
 * screen has one line for every failure — check your signal — and a preview
 * has no card behind it to say better, so a report locked meanwhile, or
 * answers the server would not take, would read as a bad connection with a
 * Try again that never works. The caller closes the viewer and says it where
 * the preview was asked for.
 */
export function draftPreviewSource(
  key: string,
  steps: {
    /** Saves the answers on screen; false when that failed. */
    flush: () => Promise<boolean>
    /** Draws the preview; its URL, or null when the file went missing. */
    render: () => Promise<{ url: string | null }>
    /** A failure the viewer would misreport as signal, in plain words. */
    refused?: (words: string) => void
  },
): DocumentSource {
  return {
    key,
    load: async (onProgress, signal) => {
      try {
        if (!(await steps.flush())) throw new PdfProblem('SAVE_FAILED')
        const { url } = await steps.render()
        if (!url) throw new PdfProblem('NO_URL')
        return await fetchWithProgress(url, onProgress, signal)
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        const offline = phoneIsOffline()
        const words = previewProblem(error, offline)
        if (!isSignalProblem(error, offline)) steps.refused?.(words)
        throw new Error(words, { cause: error })
      }
    },
  }
}
