import { Drawer } from 'vaul'
import { X } from 'lucide-react'
import { ProductForm } from './ProductForm'
import { useProductSave } from './useProductSave'
import type { ProductDraft } from '#/lib/productForm'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Adding a product, from the page's "+". The same form the product sheet
 * edits with, in a sheet of its own.
 *
 * The draft belongs to the page (see `ProductForm`): swipe this shut with a
 * photo taken and a PDF picked, tap "+" again, and they are still there. It
 * is emptied only once the product is saved.
 */
export function NewProductSheet({
  businessId,
  open,
  draft,
  onDraft,
  hydrated,
  onClose,
  onCreated,
}: {
  businessId: Id<'businesses'>
  open: boolean
  draft: ProductDraft
  onDraft: (update: (prev: ProductDraft) => ProductDraft) => void
  hydrated: boolean
  onClose: () => void
  /** Saved: the page empties the draft and opens the new product. */
  onCreated: (productId: Id<'products'>) => void
}) {
  return (
    <Drawer.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3">
            <Drawer.Title className="pr-10 text-sheet-title text-ink">
              New product
            </Drawer.Title>
            <Drawer.Description className="mt-0.5 pr-10 text-caption text-muted">
              Everyone in the business can see it and open its PDF.
            </Drawer.Description>
            <NewProductForm
              businessId={businessId}
              draft={draft}
              onDraft={onDraft}
              hydrated={hydrated}
              onCreated={onCreated}
            />
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="tap-target absolute right-3 top-3 flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function NewProductForm({
  businessId,
  draft,
  onDraft,
  hydrated,
  onCreated,
}: {
  businessId: Id<'businesses'>
  draft: ProductDraft
  onDraft: (update: (prev: ProductDraft) => ProductDraft) => void
  hydrated: boolean
  onCreated: (productId: Id<'products'>) => void
}) {
  const save = useProductSave(businessId)
  return (
    <ProductForm
      mode="new"
      draft={draft}
      onDraft={onDraft}
      existing={null}
      hydrated={hydrated}
      save={save}
      onSubmit={() => {
        void save.saveNew(draft).then((id) => id && onCreated(id))
      }}
    />
  )
}
