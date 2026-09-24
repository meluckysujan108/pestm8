import { readKeptPdf } from '#/lib/keptProducts'
import { fetchWithProgress, isAbortError } from '#/lib/pdfFiles'
import { recallPdf, rememberPdf } from '#/lib/pdfMemory'
import { pdfKeyOf } from './model'
import type { DocumentSource } from '#/components/pdf/types'
import type { ShownProduct } from './model'

/**
 * How long a download may go with no bytes arriving, when a kept copy is
 * waiting to stand in for it, before it is given up for that copy.
 *
 * One bar of signal stalls rather than fails (`FetchOptions.stallMs` has the
 * detail): with no limit the fallback below would come only when the
 * connection finally errors, a quarter of an hour later on Android, while the
 * person watches "Loading PDF… 12%" with the older copy already on the phone.
 * Counted from the last bytes, so a slow download that is still arriving is
 * never cut off. With nothing kept there is nothing better to offer, so there
 * is no limit then: the person can wait, or tap Done.
 */
export const KEPT_FALLBACK_STALL_MS = 15_000

/**
 * Where the viewer gets a product's PDF from, in the order that costs the
 * least: bytes already in memory this visit (the sheet read the kept copy,
 * an earlier Share fetched it, or this phone just uploaded it), then the copy
 * kept on this phone — when it is the current file, or when there is no
 * signal to fetch the current one — and only then the network.
 *
 * And when the network fails, or stalls (`KEPT_FALLBACK_STALL_MS`), the kept
 * copy after all, even one from before the file was replaced.
 * `navigator.onLine` only ever reliably says "no": a phone with one bar in a
 * roof void still says online, and the older label is a better answer there
 * than an error.
 *
 * Null when there is no PDF to open anywhere.
 */
export function pdfSourceFor(
  businessId: string,
  product: ShownProduct,
  isOnline: () => boolean,
): DocumentSource | null {
  const key = pdfKeyOf(product)
  if (key === null) return null
  const url = product.pdf?.url ?? null
  const kept = product.kept

  const readKept = async (acceptStale: boolean): Promise<Blob | null> => {
    if (!kept) return null
    const copy = await readKeptPdf(businessId, product.id)
    if (!copy) return null
    if (!acceptStale && url !== null && copy.pdfUrl !== url) return null
    rememberPdf(copy.pdfUrl, copy.blob)
    return copy.blob
  }

  return {
    key,
    load: async (onProgress, signal) => {
      const held = recallPdf(key, product.id)
      if (held) return held

      if (kept && (url === null || kept.pdfUrl === url || !isOnline())) {
        const copy = await readKept(!isOnline())
        if (copy) return copy
      }
      if (url === null) throw new Error('This PDF is no longer available.')

      try {
        const blob = await fetchWithProgress(
          url,
          onProgress,
          signal,
          kept ? { stallMs: KEPT_FALLBACK_STALL_MS } : undefined,
        )
        rememberPdf(url, blob)
        return blob
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        const copy = await readKept(true)
        if (copy) return copy
        throw error
      }
    },
  }
}
