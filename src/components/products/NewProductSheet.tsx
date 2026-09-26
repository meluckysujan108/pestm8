import { Drawer } from 'vaul'
import { SheetShell } from '#/components/primitives/Sheet'
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
    <SheetShell open={open} onClose={onClose}>
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
    </SheetShell>
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
