import { useCallback, useEffect, useRef, useState } from 'react'
import {
  keepRequestFor,
  readKeptPdf,
  useKeptProducts,
} from '#/lib/keptProducts'
import {
  FileTransferError,
  asPdfFile,
  fetchWithProgress,
  isAbortError,
  savePdf,
  sharePdf,
  shareProduct,
} from '#/lib/pdfFiles'
import { recallPdf, rememberPdf } from '#/lib/pdfMemory'
import {
  heldPdfUsable,
  isGestureExpired,
  preparingLabel,
} from '#/lib/shareGesture'
import { KEPT_FALLBACK_STALL_MS } from './pdfSource'
import type { LoadProgress } from '#/components/pdf/types'
import type { KeepOutcome } from '#/lib/keptProducts'
import type { ShareOutcome } from '#/lib/pdfFiles'
import type { HeldPdf } from '#/lib/shareGesture'
import type { ShareSupport } from '#/components/pdf/host/useShareSupport'
import type { ShownProduct } from './model'

/**
 * Share, Save and Share product from the product sheet — the three taps that
 * hand the PDF itself to another app.
 *
 * ── Why this is fiddly ────────────────────────────────────────────────────
 *
 * Safari opens the share sheet only from inside the tap that asked for it
 * (the top of `pdfFiles.ts` has the detail). So:
 *
 *  - When the PDF's bytes are already on hand — read from the kept copy when
 *    the sheet opened, fetched by an earlier tap, opened in the viewer, or
 *    just uploaded from this phone — the tap shares them at once, with
 *    NOTHING awaited between the tap and `navigator.share()`. That is the
 *    common case, and the only one that always works on an iPhone.
 *  - When they are not, the tap starts the download and the button counts it
 *    ("Preparing… 40%"), then shares. A small PDF on good signal arrives
 *    while the tap still counts and the sheet opens. When it has expired,
 *    `share()` refuses with NotAllowedError and nothing appears — so the
 *    button turns into "Tap to share", and that next tap shares instantly
 *    from memory.
 *
 * Save is the same on an iPhone, where it IS the share sheet ("Save to
 * Files"); elsewhere it is a download, which needs no tap, and simply
 * happens when the bytes arrive.
 *
 * A tap on a button that is preparing cancels the download.
 */

export type PdfPurpose = 'share' | 'save' | 'product'

export type PdfPrep =
  | { phase: 'idle' }
  | { phase: 'preparing'; purpose: PdfPurpose; progress: LoadProgress | null }
  /** The bytes are here; the tap that asked for them has expired. */
  | { phase: 'again'; purpose: PdfPurpose }
  /** Said on the button for a moment: "Copied". */
  | { phase: 'done'; purpose: PdfPurpose; message: string }
  | { phase: 'failed'; purpose: PdfPurpose; message: string }

const IDLE: PdfPrep = { phase: 'idle' }

/** `shareProduct` answers 'failed' rather than throwing; this carries it. */
class ShareFailed extends Error {
  constructor() {
    super('The share did not go through.')
    this.name = 'ShareFailed'
  }
}

const FAILED_WORDS: Record<PdfPurpose, string> = {
  share: 'Could not share this PDF.',
  save: 'Could not save this PDF.',
  product: 'Could not share this product.',
}

export function usePdfInHand({
  businessId,
  product,
  online,
  support,
}: {
  businessId: string
  product: ShownProduct
  online: boolean
  support: ShareSupport
}) {
  const [prep, setPrep] = useState<PdfPrep>(IDLE)
  const abort = useRef<AbortController | null>(null)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Bytes this sheet fetched or read itself, for the URL they are handed
   * over as — found again by "Tap to share" even when they are an older kept
   * copy the memory holds under its own URL. An older copy is not handed
   * over once the signal is back (`heldPdfUsable`). */
  const held = useRef<HeldPdf | null>(null)

  const url = product.pdf?.url ?? null
  const keptUrl = product.kept?.pdfUrl ?? null
  // Read in handlers and in the download's callbacks, which outlive the
  // render that started them.
  const latest = useRef({ product, online, url, prep })
  useEffect(() => {
    latest.current = { product, online, url, prep }
  })

  // A new file (replaced while the sheet was open), or a new product: what
  // was being prepared is for bytes nobody will want.
  useEffect(() => {
    held.current = null
    setPrep(IDLE)
    return () => {
      abort.current?.abort()
      abort.current = null
      clearTimeout(doneTimer.current)
    }
  }, [product.id, url])

  // The kept copy, into memory as the sheet opens, so Share works on the
  // first tap. Only the current file — or, with no signal, whatever is kept.
  useEffect(() => {
    if (keptUrl === null) return
    const current = url === null || url === keptUrl
    if (!current && online) return
    if (recallPdf(keptUrl)) return
    let live = true
    void readKeptPdf(businessId, product.id).then((copy) => {
      if (!copy) return
      rememberPdf(copy.pdfUrl, copy.blob)
      if (live && (copy.pdfUrl === url || url === null || !online)) {
        held.current = { url, blob: copy.blob, current: copy.pdfUrl === url }
      }
    })
    return () => {
      live = false
    }
  }, [businessId, product.id, url, keptUrl, online])

  /** The bytes, if they are on hand right now. Synchronous by design. */
  const bytesNow = useCallback((): Blob | null => {
    const now = latest.current
    const usable = heldPdfUsable(held.current, {
      url: now.url,
      online: now.online,
      again: now.prep.phase === 'again',
    })
    if (usable && held.current) return held.current.blob
    const fresh = recallPdf(now.url, now.product.id, now.product.pdf?.size)
    if (fresh) return fresh
    const kept = now.product.kept
    if (kept && (now.url === null || !now.online)) return recallPdf(kept.pdfUrl)
    return null
  }, [])

  const settle = useCallback((purpose: PdfPurpose, outcome: unknown) => {
    clearTimeout(doneTimer.current)
    if (outcome === 'copied') {
      setPrep({ phase: 'done', purpose, message: 'Copied' })
      doneTimer.current = setTimeout(() => setPrep(IDLE), 1500)
    } else {
      setPrep(IDLE)
    }
  }, [])

  /**
   * Hands the bytes over. `fresh` is whether this is still the tap that asked
   * (nothing was awaited): a refusal then is a real failure, while after a
   * download it is most likely the tap having expired.
   */
  const deliver = useCallback(
    (purpose: PdfPurpose, blob: Blob, fresh: boolean) => {
      const { product: now } = latest.current
      const file = asPdfFile(blob, now.pdf?.fileName ?? now.name)
      let pending: Promise<ShareOutcome | void>
      // Each of these calls `navigator.share()` before its first await.
      try {
        pending =
          purpose === 'share'
            ? sharePdf(file, { title: now.name })
            : purpose === 'save'
              ? Promise.resolve(savePdf(file))
              : shareProduct({
                  name: now.name,
                  description: now.description,
                  url: now.url,
                  file,
                }).then((outcome) => {
                  if (outcome === 'failed') throw new ShareFailed()
                  return outcome
                })
      } catch (error) {
        pending = Promise.reject(error)
      }
      pending.then(
        (outcome) => settle(purpose, outcome),
        (error: unknown) => {
          const expired =
            isGestureExpired(error) || error instanceof ShareFailed
          setPrep(
            !fresh && expired
              ? { phase: 'again', purpose }
              : { phase: 'failed', purpose, message: FAILED_WORDS[purpose] },
          )
        },
      )
    },
    [settle],
  )

  /** What each button's tap calls. Never awaits before sharing. */
  const run = useCallback(
    (purpose: PdfPurpose) => {
      if (abort.current) {
        // A tap while preparing: stop.
        abort.current.abort()
        abort.current = null
        setPrep(IDLE)
        return
      }
      const { product: now } = latest.current

      // Words only: nothing to attach (no PDF, or one gone from the server
      // with no copy here), or a share sheet that takes no files — where a
      // download first would only cost data.
      const attachable =
        now.pdf !== null && (now.pdf.url !== null || now.kept !== null)
      if (purpose === 'product' && (!attachable || !support.files)) {
        void shareProduct({
          name: now.name,
          description: now.description,
          url: now.url,
        }).then((outcome) =>
          outcome === 'failed'
            ? setPrep({
                phase: 'failed',
                purpose,
                message: FAILED_WORDS.product,
              })
            : settle(purpose, outcome),
        )
        return
      }

      const blob = bytesNow()
      if (blob) {
        setPrep(IDLE)
        deliver(purpose, blob, true)
        return
      }

      const from = latest.current.url
      if (from === null) {
        setPrep({
          phase: 'failed',
          purpose,
          message: 'This PDF is no longer available.',
        })
        return
      }

      const controller = new AbortController()
      // A function, not the flag: it is read again after each await.
      const stopped = () => controller.signal.aborted
      abort.current = controller
      setPrep({ phase: 'preparing', purpose, progress: null })
      fetchWithProgress(
        from,
        (progress) => {
          if (!stopped()) {
            setPrep({ phase: 'preparing', purpose, progress })
          }
        },
        controller.signal,
        // A kept copy to fall back on: don't sit on one bar for a quarter of
        // an hour first (see KEPT_FALLBACK_STALL_MS).
        now.kept ? { stallMs: KEPT_FALLBACK_STALL_MS } : undefined,
      )
        .then((fetched) => {
          rememberPdf(from, fetched)
          if (stopped()) return
          abort.current = null
          held.current = { url: from, blob: fetched, current: true }
          deliver(purpose, fetched, false)
        })
        .catch(async (error: unknown) => {
          if (stopped() || isAbortError(error)) return
          // No signal after all: a kept copy, even an older one, will do.
          const copy = latest.current.product.kept
            ? await readKeptPdf(businessId, latest.current.product.id)
            : null
          if (stopped()) return
          abort.current = null
          if (copy) {
            rememberPdf(copy.pdfUrl, copy.blob)
            held.current = {
              url: from,
              blob: copy.blob,
              current: copy.pdfUrl === from,
            }
            deliver(purpose, copy.blob, false)
            return
          }
          setPrep({
            phase: 'failed',
            purpose,
            message:
              error instanceof FileTransferError
                ? error.message
                : 'Could not download the PDF. Check your signal and try again.',
          })
        })
    },
    [businessId, bytesNow, deliver, settle, support.files],
  )

  /** The words on a button for `purpose`, given what it says when idle. */
  const label = useCallback(
    (purpose: PdfPurpose, idle: string): string => {
      if (prep.phase === 'idle' || prep.purpose !== purpose) return idle
      switch (prep.phase) {
        case 'preparing':
          return preparingLabel(prep.progress)
        case 'again':
          return purpose === 'save' ? 'Tap to save' : 'Tap to share'
        case 'done':
          return prep.message
        case 'failed':
          return idle
      }
    },
    [prep],
  )

  return { prep, run, label }
}

/**
 * "Keep on this phone" for one product, for the sheet and the viewer alike.
 * Hands the keep the PDF's bytes when they are already in memory, so keeping
 * a PDF just viewed costs no second download.
 *
 * Only a product from the live list can be kept — keeping needs its current
 * URLs — and only a kept one forgotten; with no signal the kept list is
 * read-only (see the Products page).
 */
export function useKeepToggle(
  businessId: string,
  product: ShownProduct | null,
) {
  const kept = useKeptProducts(businessId)
  const [error, setError] = useState<string | null>(null)
  /** What this toggle last started, for its busy words; a sync refreshing
   * the copy in the background is busy too, with neither. */
  const [action, setAction] = useState<'keep' | 'forget' | null>(null)
  const productId = product?.id ?? null
  useEffect(() => {
    setError(null)
    setAction(null)
  }, [productId])

  const isKept =
    product !== null && kept.entries !== null && kept.isKept(product.id)
  const busy = product !== null && kept.busy.has(product.id)
  const request = product?.live ? keepRequestFor(product.live) : null
  const available =
    kept.supported &&
    kept.entries !== null &&
    product?.live != null &&
    (isKept || request !== null)

  const toggle = useCallback(async (): Promise<KeepOutcome | null> => {
    if (!product) return null
    setError(null)
    let outcome: KeepOutcome
    if (isKept) {
      setAction('forget')
      outcome = await kept.forget(product.id)
    } else if (request) {
      setAction('keep')
      outcome = await kept.keep(
        request,
        recallPdf(request.pdfUrl, product.id, product.pdf?.size) ?? undefined,
      )
    } else {
      return null
    }
    setAction(null)
    if (!outcome.ok && outcome.reason !== 'cancelled') setError(outcome.message)
    return outcome
  }, [isKept, kept, product, request])

  /** The button's words. */
  const label = busy
    ? action === 'forget'
      ? 'Removing…'
      : action === 'keep'
        ? 'Keeping…'
        : 'Updating…'
    : isKept
      ? 'Remove from phone'
      : 'Keep on this phone'

  return { available, kept: isKept, busy, error, toggle, label }
}
