import { useId, useRef, useState } from 'react'
import { Camera, FileText, LoaderCircle, Package, Trash2 } from 'lucide-react'
import { prepareUpload } from '#/lib/images/prepareUpload'
import { formatBytes, looksLikePdf } from '#/lib/pdfFiles'
import {
  draftProblems,
  hasProblems,
  pdfPickRefusal,
  photoPickRefusal,
  urlProblem,
} from '#/lib/productForm'
import { pickRefusalMessage } from '#/lib/productErrors'
import { useObjectUrl } from './hooks'
import { pdfMeta } from './model'
import type { ReactNode } from 'react'
import type { ProductDraft } from '#/lib/productForm'
import type { SaveState } from './useProductSave'
import {
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from '#/components/primitives/buttons'
import { FIELD_SURFACE } from '#/components/forms/FormField'
import { FormAlert } from '#/components/forms/FormAlert'

/**
 * The product form, for a new product and for editing one.
 *
 * The draft is not held here. The sheet mounts its body only while it is
 * open, so a form that owned its draft would lose a half-typed product — a
 * photo taken, a PDF picked — to one accidental swipe down. The page holds
 * it, and this only renders it and reports changes.
 *
 * Files are picked into the draft and uploaded on Save, never on pick: a
 * technician trying three photos should not spend three uploads. Each is
 * checked the moment it is picked, by the server's own rules
 * (`pdfPickRefusal`, `photoPickRefusal`) and, for a PDF, by its first bytes
 * (`looksLikePdf`), so a file that would be refused never costs any data.
 *
 * Every field is 16px: iOS zooms the page into any smaller field it focuses.
 */

const INPUT = `w-full ${FIELD_SURFACE}`

export type ExistingFiles = {
  photoUrl: string | null
  pdf: { fileName: string; size: number | null } | null
}

export function ProductForm({
  mode,
  draft,
  onDraft,
  existing,
  hydrated,
  save,
  onSubmit,
  onCancel,
  after,
}: {
  mode: 'new' | 'edit'
  draft: ProductDraft
  onDraft: (update: (prev: ProductDraft) => ProductDraft) => void
  /** What the product holds now; null for a new one. */
  existing: ExistingFiles | null
  hydrated: boolean
  save: SaveState
  onSubmit: () => void
  onCancel?: () => void
  /** Below the buttons: Delete, for an edit. */
  after?: ReactNode
}) {
  const ids = useId()
  const photoInput = useRef<HTMLInputElement>(null)
  const pdfInput = useRef<HTMLInputElement>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [urlTouched, setUrlTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const problems = draftProblems(draft)
  const saving = save.phase !== 'idle'
  const busy = saving || photoBusy || pdfBusy
  const set = (patch: Partial<ProductDraft>) =>
    onDraft((prev) => ({ ...prev, ...patch }))

  const pickedPhoto = draft.photo.kind === 'new' ? draft.photo.file : null
  const pickedPreview = useObjectUrl(pickedPhoto)
  const photoSrc =
    draft.photo.kind === 'new'
      ? pickedPreview
      : draft.photo.kind === 'keep'
        ? (existing?.photoUrl ?? null)
        : null
  const hasPhoto =
    draft.photo.kind === 'new' ||
    (draft.photo.kind === 'keep' && existing?.photoUrl != null)

  const shownPdf =
    draft.pdf.kind === 'new'
      ? { fileName: draft.pdf.file.name, size: draft.pdf.file.size }
      : draft.pdf.kind === 'keep'
        ? (existing?.pdf ?? null)
        : null

  const onPhotoPicked = async (file: File) => {
    setPhotoError(null)
    setPhotoBusy(true)
    try {
      // Upright, shrunk and stripped of its location, as every photo in the
      // app is — the product photo is shown to the whole business.
      const prepared = await prepareUpload(file)
      const refusal = photoPickRefusal({
        type: prepared.blob.type || file.type,
        size: prepared.blob.size,
      })
      if (refusal) {
        setPhotoError(pickRefusalMessage('photo', refusal))
        return
      }
      set({ photo: { kind: 'new', file: prepared.blob } })
    } finally {
      setPhotoBusy(false)
    }
  }

  const onPdfPicked = async (file: File) => {
    setPdfError(null)
    const refusal = pdfPickRefusal(file)
    if (refusal) {
      setPdfError(pickRefusalMessage('pdf', refusal))
      return
    }
    setPdfBusy(true)
    try {
      if (!(await looksLikePdf(file))) {
        setPdfError(pickRefusalMessage('pdf', 'NOT_A_PDF'))
        return
      }
      set({ pdf: { kind: 'new', file } })
    } finally {
      setPdfBusy(false)
    }
  }

  const nameProblem = submitted ? problems.name : undefined
  const urlShown = submitted || urlTouched ? urlProblem(draft.url) : undefined
  // Objective, and not the person's fault until they keep typing: always.
  const descriptionProblem = problems.description

  return (
    <form
      noValidate
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        setSubmitted(true)
        if (busy || hasProblems(problems)) return
        onSubmit()
      }}
    >
      {/* ── Photo ─────────────────────────────────────────────────────── */}
      <h3 className="section-label mb-1.5 mt-4">Photo</h3>
      <div className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface p-3 shadow-elevation">
        <span className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-muted">
          {photoBusy ? (
            <LoaderCircle
              aria-hidden
              size={22}
              strokeWidth={1.7}
              className="animate-spin"
            />
          ) : photoSrc ? (
            <img src={photoSrc} alt="" className="size-full object-cover" />
          ) : (
            <Package aria-hidden size={28} strokeWidth={1.7} />
          )}
        </span>
        {/* Every button here is 44px tall, for a gloved thumb. */}
        <div className="flex min-w-0 flex-1 flex-col items-start">
          <button
            type="button"
            disabled={!hydrated || busy}
            onClick={() => photoInput.current?.click()}
            className="flex h-11 items-center gap-1.5 rounded-full bg-surface-2 px-4 text-body font-semibold text-blue transition active:scale-[.97] disabled:opacity-50"
          >
            <Camera aria-hidden size={16} strokeWidth={2} />
            {photoBusy
              ? 'Preparing photo…'
              : hasPhoto
                ? 'Change photo'
                : 'Take or choose photo'}
          </button>
          {hasPhoto && (
            <button
              type="button"
              disabled={!hydrated || busy}
              onClick={() => {
                setPhotoError(null)
                set({ photo: { kind: existing?.photoUrl ? 'remove' : 'keep' } })
              }}
              className="flex min-h-11 items-center px-1 text-body font-semibold text-red disabled:opacity-50"
            >
              Remove photo
            </button>
          )}
        </div>
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void onPhotoPicked(file)
          }}
        />
      </div>
      {photoError && <FieldError>{photoError}</FieldError>}

      {/* ── Words ─────────────────────────────────────────────────────── */}
      <label htmlFor={`${ids}-name`} className="section-label mb-1.5 mt-5">
        Name
      </label>
      <input
        id={`${ids}-name`}
        type="text"
        value={draft.name}
        onChange={(event) => set({ name: event.target.value })}
        disabled={saving}
        autoComplete="off"
        enterKeyHint="next"
        placeholder="Termidor Residual Termiticide"
        aria-invalid={nameProblem ? true : undefined}
        aria-describedby={nameProblem ? `${ids}-name-problem` : undefined}
        className={`${INPUT} h-12`}
      />
      {nameProblem && (
        <FieldError id={`${ids}-name-problem`}>{nameProblem}</FieldError>
      )}

      <label
        htmlFor={`${ids}-description`}
        className="section-label mb-1.5 mt-4"
      >
        Description
      </label>
      <textarea
        id={`${ids}-description`}
        value={draft.description}
        onChange={(event) => set({ description: event.target.value })}
        disabled={saving}
        rows={4}
        placeholder="What it’s for, the active, how the team uses it."
        aria-invalid={descriptionProblem ? true : undefined}
        aria-describedby={
          descriptionProblem ? `${ids}-description-problem` : undefined
        }
        className={`${INPUT} min-h-[96px] resize-y py-3 leading-snug`}
      />
      {descriptionProblem && (
        <FieldError id={`${ids}-description-problem`}>
          {descriptionProblem}
        </FieldError>
      )}

      <label htmlFor={`${ids}-url`} className="section-label mb-1.5 mt-4">
        Website
      </label>
      <input
        id={`${ids}-url`}
        type="text"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        value={draft.url}
        onChange={(event) => set({ url: event.target.value })}
        onBlur={() => setUrlTouched(true)}
        disabled={saving}
        placeholder="brand.com.au/product"
        aria-invalid={urlShown ? true : undefined}
        aria-describedby={urlShown ? `${ids}-url-problem` : undefined}
        className={`${INPUT} h-12`}
      />
      {urlShown && (
        <FieldError id={`${ids}-url-problem`}>{urlShown}</FieldError>
      )}

      {/* ── PDF ───────────────────────────────────────────────────────── */}
      <h3 className="section-label mb-1.5 mt-5">PDF</h3>
      <div className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface p-3 shadow-elevation">
        <PdfTile />
        <div className="min-w-0 flex-1">
          {shownPdf ? (
            <>
              <p className="truncate text-body font-semibold text-ink">
                {shownPdf.fileName}
              </p>
              <p className="text-caption text-muted">
                {pdfMeta(shownPdf.size, formatBytes)}
                {draft.pdf.kind === 'new' && ' · uploads when you save'}
              </p>
            </>
          ) : (
            <p className="text-body text-muted">
              {draft.pdf.kind === 'remove'
                ? 'The PDF will be removed.'
                : 'No PDF — add the label or the safety data sheet.'}
            </p>
          )}
          {/* Text buttons, but 44px tall for a gloved thumb. The negative
              margin lets the last row's box reach into the card's padding
              instead of adding to it. */}
          <div className="-mb-3 flex flex-wrap items-center gap-x-3">
            <button
              type="button"
              disabled={!hydrated || busy}
              onClick={() => pdfInput.current?.click()}
              className="flex min-h-11 items-center text-body font-semibold text-blue disabled:opacity-50"
            >
              {pdfBusy
                ? 'Checking…'
                : shownPdf
                  ? 'Choose another PDF'
                  : 'Choose PDF'}
            </button>
            {(shownPdf || draft.pdf.kind === 'remove') && (
              <button
                type="button"
                disabled={!hydrated || busy}
                onClick={() => {
                  setPdfError(null)
                  // "Remove" on a picked file goes back to what was there;
                  // on the product's own PDF, it clears it on Save. A second
                  // tap on a removal undoes it.
                  set({
                    pdf:
                      draft.pdf.kind === 'keep' && existing?.pdf
                        ? { kind: 'remove' }
                        : { kind: 'keep' },
                  })
                }}
                className="flex min-h-11 items-center text-body font-semibold text-red disabled:opacity-50"
              >
                {draft.pdf.kind === 'remove'
                  ? 'Keep the PDF'
                  : draft.pdf.kind === 'new' && existing?.pdf
                    ? 'Keep the current PDF'
                    : 'Remove PDF'}
              </button>
            )}
          </div>
        </div>
        <input
          ref={pdfInput}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void onPdfPicked(file)
          }}
        />
      </div>
      {pdfError && <FieldError>{pdfError}</FieldError>}

      {save.error && <FormAlert className="mt-4">{save.error}</FormAlert>}

      <div className="mt-5 flex gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className={`${SECONDARY_BUTTON} flex-1`}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={!hydrated || busy}
          className={`${PRIMARY_BUTTON} flex-[2]`}
        >
          {save.phase === 'uploading'
            ? 'Uploading…'
            : save.phase === 'saving'
              ? 'Saving…'
              : mode === 'new'
                ? 'Add product'
                : 'Save'}
        </button>
      </div>

      {after}
    </form>
  )
}

/** The red document tile, as Files draws a PDF. */
export function PdfTile({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-14 w-11' : 'h-12 w-10'
  return (
    <span
      aria-hidden
      className={`flex ${box} shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg bg-red-bg text-red`}
    >
      <FileText size={size === 'lg' ? 22 : 18} strokeWidth={1.7} />
      <span className="text-tab-label font-bold leading-none tracking-wide">
        PDF
      </span>
    </span>
  )
}

function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1.5 text-caption text-amber-ink">
      {children}
    </p>
  )
}

/** Delete, below an edit form: the confirm lives with the sheet. */
export function DeleteProductButton({
  disabled,
  onClick,
}: {
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="mt-6 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-body font-semibold text-red transition active:scale-[.975] disabled:opacity-50"
    >
      <Trash2 aria-hidden size={16} strokeWidth={2} />
      Delete product
    </button>
  )
}
