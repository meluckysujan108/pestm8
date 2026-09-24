import { useCallback, useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { uploadToStorage } from '#/lib/pdfFiles'
import {
  forgetUpload,
  rememberNewProductUpload,
  rememberUpload,
} from '#/lib/pdfMemory'
import { productErrorMessage } from '#/lib/productErrors'
import { baselineForSave } from '#/lib/productForm'
import { createUploadMemo, saveProduct } from '#/lib/productSave'
import { baselineOf } from './model'
import type { ProductBaseline, ProductDraft } from '#/lib/productForm'
import type { SavePhase } from '#/lib/productSave'
import type { Id } from '../../../convex/_generated/dataModel'
import type { LiveProductRow } from './model'

/**
 * Upload ids by the Blob they came from, for every form on the page.
 *
 * Module-wide rather than per sheet because the draft outlives the sheet (the
 * page holds it, so a sheet swiped shut by accident comes back as it was),
 * and so should what its files already cost: a Save that failed on the
 * signal, retried after the sheet was closed and reopened, reuses the upload
 * instead of sending the same PDF again. A WeakMap, so it lets go of a file
 * as soon as the draft does.
 */
const uploads = createUploadMemo()

export type SaveState = { phase: 'idle' | SavePhase; error: string | null }

/**
 * Saving the product form, new or edited: upload what was picked, write what
 * changed (`saveProduct`), and put any refusal into words.
 */
export function useProductSave(businessId: Id<'businesses'>) {
  const generateUploadUrl = useConvexMutation(api.products.generateUploadUrl)
  const create = useConvexMutation(api.products.create)
  const update = useConvexMutation(api.products.update)
  const [state, setState] = useState<SaveState>({ phase: 'idle', error: null })

  const uploadFile = useCallback(
    async (blob: Blob, contentType: string) =>
      uploadToStorage(
        await generateUploadUrl({ businessId }),
        blob,
        contentType,
      ),
    [businessId, generateUploadUrl],
  )

  const onPhase = useCallback(
    (phase: SavePhase) => setState({ phase, error: null }),
    [],
  )

  /** Adds a product. Resolves with its id, or null when it did not save. */
  const saveNew = useCallback(
    async (draft: ProductDraft): Promise<Id<'products'> | null> => {
      setState({ phase: 'idle', error: null })
      try {
        const saved = await saveProduct(null, draft, {
          uploadFile,
          uploads,
          onPhase,
          write: (fields) =>
            create({
              businessId,
              name: fields.name ?? '',
              description: fields.description ?? undefined,
              url: fields.url ?? undefined,
              photoStorageId: (fields.photoStorageId ?? undefined) as
                Id<'_storage'> | undefined,
              pdf: fields.pdf
                ? {
                    storageId: fields.pdf.storageId as Id<'_storage'>,
                    fileName: fields.pdf.fileName,
                  }
                : undefined,
            }),
        })
        setState({ phase: 'idle', error: null })
        if (!saved.written) return null
        // Its PDF is on this phone already: opening it should not fetch it.
        if (saved.pdf) rememberNewProductUpload(saved.result, saved.pdf)
        return saved.result
      } catch (error) {
        setState({ phase: 'idle', error: productErrorMessage(error, 'save') })
        return null
      }
    },
    [businessId, create, onPhase, uploadFile],
  )

  /**
   * Saves an edit of `row`. Its words are measured against the product as it
   * was when editing began (`baseline` — not the row now, which someone else
   * may have renamed since; only what THIS person changed is sent), its files
   * against the row now, which is what the form showed them
   * (`baselineForSave`). True once saved, or when there was nothing to save.
   */
  const saveEdit = useCallback(
    async (
      row: LiveProductRow,
      baseline: ProductBaseline,
      draft: ProductDraft,
    ): Promise<boolean> => {
      setState({ phase: 'idle', error: null })
      const newPdf = draft.pdf.kind === 'new' ? draft.pdf.file : null
      try {
        await saveProduct(baselineForSave(baseline, baselineOf(row)), draft, {
          uploadFile,
          uploads,
          onPhase,
          write: async (fields) => {
            // Before the write: the new URL may arrive ahead of its answer.
            if (fields.pdf && newPdf) {
              rememberUpload(row.id, row.pdf?.url ?? null, newPdf)
            }
            try {
              await update({
                businessId,
                productId: row.id,
                ...(fields.name !== undefined && { name: fields.name }),
                ...(fields.description !== undefined && {
                  description: fields.description,
                }),
                ...(fields.url !== undefined && { url: fields.url }),
                ...(fields.photoStorageId !== undefined && {
                  photoStorageId:
                    fields.photoStorageId as Id<'_storage'> | null,
                }),
                ...(fields.pdf !== undefined && {
                  pdf: fields.pdf && {
                    storageId: fields.pdf.storageId as Id<'_storage'>,
                    fileName: fields.pdf.fileName,
                  },
                }),
              })
            } catch (error) {
              if (fields.pdf) forgetUpload(row.id)
              throw error
            }
          },
        })
        setState({ phase: 'idle', error: null })
        return true
      } catch (error) {
        setState({ phase: 'idle', error: productErrorMessage(error, 'save') })
        return false
      }
    },
    [businessId, onPhase, update, uploadFile],
  )

  const clearError = useCallback(
    () => setState((prev) => ({ ...prev, error: null })),
    [],
  )

  return { ...state, saveNew, saveEdit, clearError }
}
