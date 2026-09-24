import type { LoadProgress } from '#/components/pdf/types'

/**
 * The words and the one test behind "Tap to share" on the Products page.
 *
 * Safari opens the share sheet only inside the tap that asked for it (see the
 * top of `pdfFiles.ts`). A Share tapped before the PDF is on the phone has to
 * download it first, and by the time the bytes arrive that tap may have
 * expired: `navigator.share()` then rejects with `NotAllowedError` and no
 * sheet appears. The page keeps the bytes it just fetched and asks for one
 * more tap, which shares at once. These helpers are the pure half of that, so
 * the rule for which error means "tap again" is written down and tested.
 */

/**
 * Whether a share (or an iPhone "Save to Files", which is a share) was refused
 * because the tap that asked for it had expired — as opposed to failing for a
 * reason another tap would not fix.
 *
 * `NotAllowedError` is what WebKit and Chrome both throw for a share without a
 * live user activation. Checked by name, not `instanceof DOMException`: the
 * edge runtime the tests run in, and some older WebKits, do not make the
 * error a DOMException.
 */
export function isGestureExpired(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotAllowedError'
  )
}

/**
 * "Preparing…", or "Preparing… 40%" once the size is known: what a Share or
 * Save button says while it downloads the PDF it is about to hand over. The
 * percentage never reads 100 before the last byte — a button that says 100%
 * and then sits there looks stuck.
 */
export function preparingLabel(progress: LoadProgress | null): string {
  if (!progress || progress.total === null || progress.total <= 0) {
    return 'Preparing…'
  }
  const fraction = progress.loaded / progress.total
  const percent =
    fraction >= 1 ? 100 : Math.min(99, Math.floor(Math.max(0, fraction) * 100))
  return `Preparing… ${percent}%`
}

/**
 * PDF bytes a product sheet has in hand to share or save, and the URL they
 * are handed over as. `current` says whether they ARE that file, or an older
 * copy kept on the phone standing in for it — read while there was no signal,
 * or fallen back on when a download failed.
 */
export type HeldPdf = { url: string | null; blob: Blob; current: boolean }

/**
 * Whether the bytes a sheet holds may be handed over, synchronously, for the
 * PDF it shows now.
 *
 * They must be for the same URL. An older kept copy standing in for the
 * current file is used only while it is still the best there is: with no
 * signal, for a PDF gone from the server (no URL), or for the "Tap to share"
 * that was offered for exactly these bytes (`again`). Once the signal is
 * back, a fresh tap downloads the current file instead — a superseded safety
 * data sheet sent under the new one's name is worse than a short wait.
 */
export function heldPdfUsable(
  held: HeldPdf | null,
  now: { url: string | null; online: boolean; again: boolean },
): boolean {
  if (!held || held.url !== now.url) return false
  return held.current || now.url === null || !now.online || now.again
}
