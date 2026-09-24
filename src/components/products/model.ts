import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'
import type { KeptProduct } from '#/lib/keptProducts'
import type { ProductBaseline } from '#/lib/productForm'

/** One product as `products.list` sends it. */
export type LiveProductRow = FunctionReturnType<
  typeof api.products.list
>[number]

/**
 * A product as the page shows it, from either of its two sources: the live
 * list, or — with no signal — the copy kept on this phone. The sheet, the
 * cards and the viewer read this one shape, so none of them has to ask which
 * it was given except where the answer changes what may be done.
 */
export type ShownProduct = {
  id: string
  name: string
  description: string | null
  url: string | null
  /** The live photo's URL. Null for none, and always null for a kept copy,
   * whose photo is read from the phone instead (`hasKeptPhoto`). */
  photoUrl: string | null
  hasKeptPhoto: boolean
  pdf: { url: string | null; fileName: string; size: number | null } | null
  /** The creator or the owner, per the server. Never true for a kept copy. */
  canEdit: boolean
  /** The row from the server; null when this came from the kept copy. Every
   * write takes its id from here, never from the address bar. */
  live: LiveProductRow | null
  /** What is kept on this phone for it, if anything. */
  kept: KeptProduct | null
}

export function fromLive(
  row: LiveProductRow,
  kept: KeptProduct | null,
): ShownProduct {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: row.url,
    photoUrl: row.photoUrl,
    hasKeptPhoto: false,
    pdf: row.pdf,
    canEdit: row.canEdit,
    live: row,
    kept,
  }
}

export function fromKept(entry: KeptProduct): ShownProduct {
  return {
    id: entry.productId,
    name: entry.name,
    description: entry.description,
    url: entry.url,
    photoUrl: null,
    hasKeptPhoto: entry.photoUrl !== null,
    pdf: { url: entry.pdfUrl, fileName: entry.fileName, size: entry.size },
    canEdit: false,
    live: null,
    kept: entry,
  }
}

/**
 * The identity of the PDF's bytes: its URL, or — for a PDF whose file is gone
 * from storage but was kept here first — the URL the kept copy came from.
 * Null when there is no PDF to open at all.
 */
export function pdfKeyOf(product: ShownProduct): string | null {
  if (!product.pdf) return null
  return product.pdf.url ?? product.kept?.pdfUrl ?? null
}

/** Whether the PDF can be opened from somewhere: the network or the phone. */
export function pdfAvailable(product: ShownProduct): boolean {
  return pdfKeyOf(product) !== null
}

/** Whether the kept copy is the PDF as it is now, not one since replaced. */
export function keptIsCurrent(product: ShownProduct): boolean {
  if (!product.kept || !product.pdf) return false
  return product.pdf.url === null || product.kept.pdfUrl === product.pdf.url
}

export function baselineOf(row: LiveProductRow): ProductBaseline {
  return {
    name: row.name,
    description: row.description,
    url: row.url,
    hasPhoto: row.photoUrl !== null,
    hasPdf: row.pdf !== null,
  }
}

/** "PDF · 1.2 MB", or just "PDF" when the size is not known. */
export function pdfMeta(
  size: number | null,
  formatBytes: (bytes: number) => string,
): string {
  return size === null ? 'PDF' : `PDF · ${formatBytes(size)}`
}
