import {
  checkPdfFile,
  checkPhotoFile,
  cleanDescription,
  cleanProductName,
  normaliseProductUrl,
} from '../../convex/lib/products'
import type { PickRefusal } from './productErrors'

/**
 * The product form's draft, and what a Save of it should send.
 *
 * Pure, so the rule that matters most here can be tested: `products.update`
 * reads a field left out as "leave it alone" and `null` as "clear it", so a
 * Save must send exactly what changed and nothing else. Sending every field
 * back would work today (the server skips a file it already holds) but would
 * also rename a product someone else renamed a minute ago back to what this
 * phone loaded — the last Save wins on every field it sends.
 *
 * The checks are the server's own (`convex/lib/products`, imported the way
 * `AbnInput` imports `lib/abn`), so the form refuses exactly what a Save would
 * be refused for, before a byte is uploaded.
 */

/** A file slot in the draft: left as it is, emptied, or a file picked here. */
export type DraftFile<T extends Blob> =
  { kind: 'keep' } | { kind: 'remove' } | { kind: 'new'; file: T }

export type ProductDraft = {
  name: string
  description: string
  url: string
  /** A picked photo is already through `prepareUpload`: upright, shrunk. */
  photo: DraftFile<Blob>
  pdf: DraftFile<File>
}

/** The product as it was loaded — what "changed" is measured against. */
export type ProductBaseline = {
  name: string
  description: string | null
  url: string | null
  hasPhoto: boolean
  hasPdf: boolean
}

export const EMPTY_DRAFT: ProductDraft = {
  name: '',
  description: '',
  url: '',
  photo: { kind: 'keep' },
  pdf: { kind: 'keep' },
}

export function draftFrom(product: ProductBaseline): ProductDraft {
  return {
    name: product.name,
    description: product.description ?? '',
    url: product.url ?? '',
    photo: { kind: 'keep' },
    pdf: { kind: 'keep' },
  }
}

export type DraftProblems = {
  name?: string
  description?: string
  url?: string
}

export const URL_PROBLEM =
  "That doesn't look like a web page. Try something like brand.com.au/product."

/** What is wrong with a link as typed, or undefined when nothing is. */
export function urlProblem(url: string): string | undefined {
  return normaliseProductUrl(url) === null ? URL_PROBLEM : undefined
}

/** Every field's problem, by the server's rules. Empty when it can be saved. */
export function draftProblems(draft: ProductDraft): DraftProblems {
  const problems: DraftProblems = {}
  if (cleanProductName(draft.name) === null) {
    problems.name =
      draft.name.trim() === ''
        ? 'Give the product a name.'
        : 'That name is too long.'
  }
  if (cleanDescription(draft.description) === null) {
    problems.description = 'That description is too long.'
  }
  const url = urlProblem(draft.url)
  if (url) problems.url = url
  return problems
}

export function hasProblems(problems: DraftProblems): boolean {
  return Object.values(problems).some(Boolean)
}

/** What happens to a file slot on Save. */
export type FileChange = 'keep' | 'remove' | 'upload'

/**
 * A Save, worked out: the words to send (each left out when unchanged; `null`
 * clears it, on an update) and what to do with each file. Assumes the draft
 * has no problems.
 */
export type ProductChanges = {
  name?: string
  description?: string | null
  url?: string | null
  photo: FileChange
  pdf: FileChange
}

function fileChange(slot: DraftFile<Blob>, had: boolean): FileChange {
  if (slot.kind === 'new') return 'upload'
  if (slot.kind === 'remove' && had) return 'remove'
  return 'keep'
}

/**
 * What to send for a draft: to `create` when there is no baseline, to
 * `update` when there is one.
 *
 * A new product sends its name, and its description and link only when they
 * are not blank. An edit sends a word field only when its cleaned value
 * differs from what was loaded — cleaned, so a trailing space or "brand.com.au"
 * against the stored "https://brand.com.au/" is not a change — and a blank one
 * that had a value as `null`, which clears it.
 */
export function productChanges(
  baseline: ProductBaseline | null,
  draft: ProductDraft,
): ProductChanges {
  const name = cleanProductName(draft.name) ?? draft.name.trim()
  const description = cleanDescription(draft.description) ?? null
  const url = normaliseProductUrl(draft.url) ?? null

  if (baseline === null) {
    return {
      name,
      ...(description !== null && { description }),
      ...(url !== null && { url }),
      photo: fileChange(draft.photo, false),
      pdf: fileChange(draft.pdf, false),
    }
  }

  return {
    ...(name !== baseline.name && { name }),
    ...(description !== baseline.description && { description }),
    ...(url !== baseline.url && { url }),
    photo: fileChange(draft.photo, baseline.hasPhoto),
    pdf: fileChange(draft.pdf, baseline.hasPdf),
  }
}

/**
 * What an edit's Save is measured against: the words as they were when
 * editing began, but the files as the product holds them NOW.
 *
 * The two differ on purpose. A word field this person did not touch must not
 * be sent, or someone else's rename a minute ago is undone — so words are
 * measured from where this edit started. But the form shows, and offers to
 * remove, the files the product has now (the live row), including a photo
 * another member added while this edit was open. "Remove photo" on that must
 * clear it, and measured from the start (no photo then) it would read as
 * "nothing to remove" and quietly send nothing.
 */
export function baselineForSave(
  started: ProductBaseline,
  now: Pick<ProductBaseline, 'hasPhoto' | 'hasPdf'>,
): ProductBaseline {
  return { ...started, hasPhoto: now.hasPhoto, hasPdf: now.hasPdf }
}

/** Whether a Save would change anything at all. */
export function changesAnything(changes: ProductChanges): boolean {
  return (
    changes.name !== undefined ||
    changes.description !== undefined ||
    changes.url !== undefined ||
    changes.photo !== 'keep' ||
    changes.pdf !== 'keep'
  )
}

/**
 * Whether a picked PDF may go on a product, by size and declared type — the
 * server's `checkPdfFile`. A picker that did not know the type says '' or
 * `application/octet-stream`; neither is a refusal here, because the bytes
 * are checked next (`looksLikePdf`) and it is uploaded as a PDF once they
 * pass.
 */
export function pdfPickRefusal(file: {
  type: string
  size: number
}): PickRefusal | null {
  const type = file.type.trim().toLowerCase()
  const declared =
    type === '' || type === 'application/octet-stream' ? undefined : type
  return checkPdfFile({ contentType: declared, size: file.size })
}

/** Whether a photo, as it will be uploaded, may go on a product. */
export function photoPickRefusal(file: {
  type: string
  size: number
}): PickRefusal | null {
  return checkPhotoFile({
    contentType: file.type.trim() === '' ? undefined : file.type,
    size: file.size,
  })
}
