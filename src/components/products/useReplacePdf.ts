import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { PDF_TYPE, looksLikePdf, uploadToStorage } from '#/lib/pdfFiles'
import { forgetUpload, rememberUpload } from '#/lib/pdfMemory'
import { pdfPickRefusal } from '#/lib/productForm'
import { pickRefusalMessage, productErrorMessage } from '#/lib/productErrors'
import type { ChangeEvent } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'
import type { LiveProductRow } from './model'

/**
 * Replace PDF, from the product sheet or from inside the viewer.
 *
 * One hidden file input, owned by the page rather than by either of them:
 * the viewer knows nothing about products (`types.ts`), and the sheet is
 * closed while the viewer is open. `pick` has to be called from the tap
 * itself — a browser opens a file picker only for a click the person made.
 *
 * The file is checked on the phone (size, type, and that its bytes really
 * start like a PDF) before a byte is uploaded, then uploaded and saved as the
 * product's PDF straight away: unlike the edit form there is nothing else to
 * fill in, so choosing the file is the Save. Its bytes are also handed to the
 * page's memory (`rememberUpload`), so the viewer — which reloads on its own
 * when the product's PDF URL changes — opens the new file without downloading
 * what this phone just sent.
 */

export type ReplaceStatus =
  | { productId: string; phase: 'checking' | 'uploading' | 'saving' | 'done' }
  | { productId: string; phase: 'failed'; message: string }

/** How long "New PDF saved" and a failure stay up. */
const DONE_MS = 2500
const FAILED_MS = 8000

export function replaceStatusText(status: ReplaceStatus): string {
  switch (status.phase) {
    case 'checking':
      return 'Checking the PDF…'
    case 'uploading':
      return 'Uploading new PDF…'
    case 'saving':
      return 'Saving…'
    case 'done':
      return 'New PDF saved'
    case 'failed':
      return status.message
  }
}

export function useReplacePdf(businessId: Id<'businesses'>) {
  const inputRef = useRef<HTMLInputElement>(null)
  const target = useRef<LiveProductRow | null>(null)
  const [status, setStatus] = useState<ReplaceStatus | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const busy =
    status !== null && status.phase !== 'done' && status.phase !== 'failed'

  const generateUploadUrl = useConvexMutation(api.products.generateUploadUrl)
  const update = useConvexMutation(api.products.update)

  useEffect(() => () => clearTimeout(timer.current), [])

  const show = useCallback((next: ReplaceStatus | null) => {
    clearTimeout(timer.current)
    setStatus(next)
    if (next?.phase === 'done' || next?.phase === 'failed') {
      timer.current = setTimeout(
        () => setStatus(null),
        next.phase === 'done' ? DONE_MS : FAILED_MS,
      )
    }
  }, [])

  /** Opens the picker for this product. Call from the tap. */
  const pick = useCallback(
    (row: LiveProductRow) => {
      const input = inputRef.current
      if (!input || busy) return
      target.current = row
      input.value = ''
      input.click()
    },
    [busy],
  )

  const onChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      const row = target.current
      if (!file || !row) return
      const productId = row.id

      show({ productId, phase: 'checking' })
      const refusal = pdfPickRefusal(file)
      if (refusal) {
        show({
          productId,
          phase: 'failed',
          message: pickRefusalMessage('pdf', refusal),
        })
        return
      }
      if (!(await looksLikePdf(file))) {
        show({
          productId,
          phase: 'failed',
          message: pickRefusalMessage('pdf', 'NOT_A_PDF'),
        })
        return
      }

      try {
        show({ productId, phase: 'uploading' })
        const uploadUrl = await generateUploadUrl({ businessId })
        const storageId = await uploadToStorage(uploadUrl, file, PDF_TYPE)
        show({ productId, phase: 'saving' })
        // Before the write, not after: the new URL can reach the page ahead
        // of the mutation's answer, and the viewer reloads the moment it does.
        rememberUpload(productId, row.pdf?.url ?? null, file)
        try {
          await update({
            businessId,
            productId,
            pdf: {
              storageId: storageId as Id<'_storage'>,
              fileName: file.name,
            },
          })
        } catch (error) {
          forgetUpload(productId)
          throw error
        }
        show({ productId, phase: 'done' })
      } catch (error) {
        show({
          productId,
          phase: 'failed',
          message: productErrorMessage(error, 'replace'),
        })
      }
    },
    [businessId, generateUploadUrl, show, update],
  )

  return {
    /** Spread onto an <input> the page renders once. */
    inputProps: {
      ref: inputRef,
      type: 'file',
      accept: 'application/pdf,.pdf',
      className: 'hidden',
      tabIndex: -1,
      'aria-hidden': true,
      onChange: (event: ChangeEvent<HTMLInputElement>) => void onChange(event),
    } as const,
    pick,
    status,
    busy,
  }
}
