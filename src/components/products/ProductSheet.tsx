import { useEffect, useRef, useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import { SHEET_BODY, SheetShell } from '#/components/primitives/Sheet'
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Pencil,
  RefreshCw,
  Share,
  Smartphone,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { SheetPending } from '#/components/shell/Pending'
import { copyText, formatBytes, shareLink } from '#/lib/pdfFiles'
import { productErrorMessage } from '#/lib/productErrors'
import { linkParts } from '#/lib/productSearch'
import { Chip } from './ProductCard'
import { DeleteProductButton, PdfTile, ProductForm } from './ProductForm'
import { ProductHero } from './ProductPhoto'
import { pdfAvailable, pdfMeta } from './model'
import { useKeepToggle, usePdfInHand } from './usePdfActions'
import { useProductSave } from './useProductSave'
import { replaceStatusText } from './useReplacePdf'
import { prefetchViewer } from '#/components/pdf/host/viewerChunk'
import type { ReactNode } from 'react'
import type { ProductBaseline, ProductDraft } from '#/lib/productForm'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ShareSupport } from '#/components/pdf/host/useShareSupport'
import type { LiveProductRow, ShownProduct } from './model'
import type { ReplaceStatus } from './useReplacePdf'
import {
  NEUTRAL_BUTTON,
  SECONDARY_BUTTON,
} from '#/components/primitives/buttons'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { FormAlert } from '#/components/forms/FormAlert'

/**
 * One product, in a bottom sheet: its photo, name and words, its web page
 * (copy, share, open), and its PDF (view, share, save, keep, replace) — and,
 * for the person who added it or the owner, the same sheet turned into its
 * edit form.
 *
 * The sheet is closed whenever the viewer is open (the page decides, from the
 * URL). Both are modal — a vaul sheet traps focus and turns off pointer
 * events on the page behind — so one on top of the other is two traps
 * fighting, and the phone's back gesture would have two things to close.
 *
 * What it shows comes from the page as a `ShownProduct`: the live row, or,
 * with no signal, the copy kept on this phone, which is read-only (no Edit,
 * no Replace, no Delete — none of them could be saved).
 */

export type SheetStatus = 'loading' | 'found' | 'missing'

/** An edit in progress, held by the page so a closed sheet does not lose it. */
export type EditState = {
  productId: string
  /** The product as it was when Edit was tapped: what "changed" means. */
  baseline: ProductBaseline
  draft: ProductDraft
}

export function ProductSheet({
  businessId,
  open,
  status,
  product,
  online,
  hydrated,
  support,
  onClose,
  onView,
  onReplace,
  replaceStatus,
  edit,
  onEdit,
  onEditDraft,
  onEditDone,
  onDeleted,
}: {
  businessId: Id<'businesses'>
  open: boolean
  status: SheetStatus
  product: ShownProduct | null
  online: boolean
  hydrated: boolean
  support: ShareSupport
  onClose: () => void
  onView: () => void
  /** Offered to editors with signal. Opens the page's PDF picker. */
  onReplace?: (row: LiveProductRow) => void
  replaceStatus: ReplaceStatus | null
  /** The edit in progress for THIS product, if any. */
  edit: EditState | null
  onEdit: (row: LiveProductRow) => void
  onEditDraft: (update: (prev: ProductDraft) => ProductDraft) => void
  onEditDone: () => void
  onDeleted: (productId: string) => void
}) {
  // What the sheet last showed, kept on screen while it slides away — the
  // product can vanish from the list (deleted) a frame before the sheet
  // closes, and a sheet that empties itself on the way out looks broken.
  const [last, setLast] = useState<ShownProduct | null>(product)
  if (product !== null && product !== last) setLast(product)
  const shown = product ?? (open ? null : last)

  return (
    <SheetShell open={open} onClose={onClose}>
      {shown ? (
        edit && edit.productId === shown.id && shown.live ? (
          <EditBody
            key={shown.id}
            businessId={businessId}
            row={shown.live}
            product={shown}
            edit={edit}
            hydrated={hydrated}
            onEditDraft={onEditDraft}
            onEditDone={onEditDone}
            onDeleted={onDeleted}
          />
        ) : (
          <DetailsBody
            key={shown.id}
            businessId={businessId}
            product={shown}
            online={online}
            hydrated={hydrated}
            support={support}
            onView={onView}
            onReplace={onReplace}
            replaceStatus={
              replaceStatus?.productId === shown.id ? replaceStatus : null
            }
            replaceElsewhere={
              replaceBusy(replaceStatus) &&
              replaceStatus?.productId !== shown.id
            }
            onEdit={onEdit}
          />
        )
      ) : status === 'missing' ? (
        <div className="px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3">
          <Drawer.Title className="pr-10 text-sheet-title text-ink">
            Not found
          </Drawer.Title>
          <Drawer.Description className="mt-1 text-body text-muted">
            This product has been deleted.
          </Drawer.Description>
          <button
            type="button"
            onClick={onClose}
            className={`${SECONDARY_BUTTON} mt-5 w-full`}
          >
            Close
          </button>
        </div>
      ) : (
        <>
          <Drawer.Description className="sr-only">
            Loading the product
          </Drawer.Description>
          <SheetPending
            title={<Drawer.Title className="sr-only">Product</Drawer.Title>}
          />
        </>
      )}
    </SheetShell>
  )
}

// ───────────────────────────────────────────────────────────────── details

function DetailsBody({
  businessId,
  product,
  online,
  hydrated,
  support,
  onView,
  onReplace,
  replaceStatus,
  replaceElsewhere,
  onEdit,
}: {
  businessId: Id<'businesses'>
  product: ShownProduct
  online: boolean
  hydrated: boolean
  support: ShareSupport
  onView: () => void
  onReplace?: (row: LiveProductRow) => void
  /** This product's Replace, if one is running or just ended. */
  replaceStatus: ReplaceStatus | null
  /** Another product's new PDF is still going up. The page has one picker
   * and one upload at a time, so Replace here waits for it — visibly. */
  replaceElsewhere: boolean
  onEdit: (row: LiveProductRow) => void
}) {
  const pdf = usePdfInHand({ businessId, product, online, support })
  const keep = useKeepToggle(businessId, product)
  const canEdit = product.canEdit && product.live !== null
  const available = pdfAvailable(product)

  // View PDF should open at once: fetch the viewer while they read this.
  useEffect(() => {
    if (available) prefetchViewer()
  }, [available])

  const failed = pdf.prep.phase === 'failed' ? pdf.prep : null
  const preparing = pdf.prep.phase === 'preparing' ? pdf.prep.purpose : null
  const readOnly = product.live === null

  return (
    <>
      {/* Level with the close button, which sits over this row. The buttons
          are taller than the row (44px, for a gloved thumb) and hang evenly
          over its edges, so they line up with the X without moving it; the
          wider right padding keeps a miss on Share or Edit off the X. */}
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 pl-4 pr-14">
        <HeaderButton
          disabled={
            !hydrated || (preparing !== null && preparing !== 'product')
          }
          onClick={() => pdf.run('product')}
          label={pdf.label('product', 'Share')}
        >
          <Share aria-hidden size={16} strokeWidth={2} />
        </HeaderButton>
        {canEdit && product.live && (
          <HeaderButton
            disabled={!hydrated}
            onClick={() => product.live && onEdit(product.live)}
            label="Edit"
          >
            <Pencil aria-hidden size={15} strokeWidth={2} />
          </HeaderButton>
        )}
      </div>

      <div className={`${SHEET_BODY} mt-2`}>
        <ProductHero
          businessId={businessId}
          product={product}
          onAddPhoto={
            canEdit && hydrated && product.live
              ? () => product.live && onEdit(product.live)
              : undefined
          }
        />

        <Drawer.Title className="mt-4 text-sheet-title text-ink [overflow-wrap:anywhere]">
          {product.name}
        </Drawer.Title>
        {product.description ? (
          <Drawer.Description className="mt-1.5 whitespace-pre-wrap text-body text-ink-2 [overflow-wrap:anywhere]">
            {product.description}
          </Drawer.Description>
        ) : (
          <Drawer.Description className="sr-only">Product</Drawer.Description>
        )}

        {readOnly && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-caption text-ink-2">
            <Smartphone
              aria-hidden
              size={14}
              strokeWidth={2}
              className="mt-0.5 shrink-0"
            />
            The copy kept on this phone. Editing needs signal.
          </p>
        )}

        {product.url && (
          <WebsiteCard
            name={product.name}
            url={product.url}
            hydrated={hydrated}
          />
        )}

        {product.pdf && (
          <section className="mt-5">
            <h3 className="section-label mb-1.5">Document</h3>
            <div className="rounded-2xl border border-hairline bg-surface p-3 shadow-elevation">
              <div className="flex items-center gap-3">
                <PdfTile size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-semibold text-ink">
                    {product.pdf.fileName}
                  </p>
                  <p className="text-caption text-muted">
                    {pdfMeta(product.pdf.size, formatBytes)}
                  </p>
                  {keep.kept && (
                    <span className="mt-1 inline-flex">
                      <Chip tone="green">
                        <Smartphone aria-hidden size={12} strokeWidth={2.4} />
                        On this phone
                      </Chip>
                    </span>
                  )}
                </div>
              </div>

              {available ? (
                <>
                  {product.pdf.url === null && (
                    <p className="mt-3 text-caption text-amber-ink">
                      The file is gone from the server. This is the copy kept on
                      this phone.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={!hydrated}
                    onClick={onView}
                    className={`${NEUTRAL_BUTTON} mt-3 w-full`}
                  >
                    View PDF
                  </button>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {support.files && (
                      <ActionButton
                        disabled={
                          !hydrated ||
                          (preparing !== null && preparing !== 'share')
                        }
                        onClick={() => pdf.run('share')}
                        label={pdf.label('share', 'Share')}
                      >
                        <Share aria-hidden size={16} strokeWidth={2} />
                      </ActionButton>
                    )}
                    <ActionButton
                      disabled={
                        !hydrated ||
                        (preparing !== null && preparing !== 'save')
                      }
                      onClick={() => pdf.run('save')}
                      label={pdf.label('save', support.saveLabel)}
                    >
                      <Download aria-hidden size={16} strokeWidth={2} />
                    </ActionButton>
                    {keep.available && (
                      <ActionButton
                        disabled={!hydrated || keep.busy}
                        pressed={keep.kept}
                        onClick={() => void keep.toggle()}
                        label={keep.label}
                      >
                        {keep.kept ? (
                          <Check aria-hidden size={16} strokeWidth={2.2} />
                        ) : (
                          <Smartphone aria-hidden size={16} strokeWidth={2} />
                        )}
                      </ActionButton>
                    )}
                    {canEdit && onReplace && product.live && (
                      <ReplaceButton
                        disabled={
                          !hydrated ||
                          replaceBusy(replaceStatus) ||
                          replaceElsewhere
                        }
                        onClick={() => product.live && onReplace(product.live)}
                      />
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="mt-3 text-body text-muted">
                    This PDF is no longer available.
                  </p>
                  {canEdit && onReplace && product.live && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <ReplaceButton
                        disabled={
                          !hydrated ||
                          replaceBusy(replaceStatus) ||
                          replaceElsewhere
                        }
                        onClick={() => product.live && onReplace(product.live)}
                      />
                    </div>
                  )}
                </>
              )}

              {replaceStatus ? (
                <p
                  role={replaceStatus.phase === 'failed' ? 'alert' : 'status'}
                  className={`mt-2 text-caption ${replaceStatus.phase === 'failed' ? 'text-amber-ink' : 'text-muted'}`}
                >
                  {replaceStatusText(replaceStatus)}
                </p>
              ) : (
                replaceElsewhere &&
                canEdit &&
                onReplace && (
                  <p role="status" className="mt-2 text-caption text-muted">
                    Another product’s new PDF is still uploading.
                  </p>
                )
              )}
              {keep.error && (
                <p role="alert" className="mt-2 text-caption text-amber-ink">
                  {keep.error}
                </p>
              )}
            </div>
          </section>
        )}

        {failed && <FormAlert className="mt-3">{failed.message}</FormAlert>}
      </div>
    </>
  )
}

function replaceBusy(status: ReplaceStatus | null): boolean {
  return status !== null && status.phase !== 'done' && status.phase !== 'failed'
}

/** The product's web page: copy it, share it, open it outside the app. */
function WebsiteCard({
  name,
  url,
  hydrated,
}: {
  name: string
  url: string
  hydrated: boolean
}) {
  const parts = linkParts(url)
  const [said, setSaid] = useState<{
    which: 'copy' | 'share'
    text: string
  } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const say = (which: 'copy' | 'share', text: string) => {
    clearTimeout(timer.current)
    setSaid({ which, text })
    timer.current = setTimeout(() => setSaid(null), 1500)
  }

  return (
    <section className="mt-5">
      <h3 className="section-label mb-1.5">Website</h3>
      <div className="rounded-2xl border border-hairline bg-surface p-3 shadow-elevation">
        <p className="flex min-w-0 items-center gap-2 text-body">
          <Globe
            aria-hidden
            size={16}
            strokeWidth={2}
            className="shrink-0 text-muted"
          />
          {parts ? (
            <span className="min-w-0 truncate">
              <span className="font-semibold text-ink">{parts.host}</span>
              <span className="text-muted">{parts.rest}</span>
            </span>
          ) : (
            <span className="min-w-0 truncate text-ink">{url}</span>
          )}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <ActionButton
            disabled={!hydrated}
            // Straight from the tap: Safari refuses the clipboard otherwise.
            onClick={() =>
              void copyText(url).then((ok) =>
                say('copy', ok ? 'Copied' : 'Could not copy'),
              )
            }
            label={said?.which === 'copy' ? said.text : 'Copy'}
          >
            {said?.which === 'copy' && said.text === 'Copied' ? (
              <Check aria-hidden size={16} strokeWidth={2.2} />
            ) : (
              <Copy aria-hidden size={16} strokeWidth={2} />
            )}
          </ActionButton>
          <ActionButton
            disabled={!hydrated}
            onClick={() =>
              void shareLink({ title: name, url }).then((outcome) => {
                if (outcome === 'copied') say('share', 'Copied')
                else if (outcome === 'failed') say('share', 'Could not share')
              })
            }
            label={said?.which === 'share' ? said.text : 'Share'}
          >
            <Share aria-hidden size={16} strokeWidth={2} />
          </ActionButton>
          {/* A link, not `window.open`: a tap on a link always opens a new
              tab, and it never takes the installed app's own window with it
              (see openMapTab in maps.ts for what that costs). */}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-surface-2 px-2 text-center text-body font-semibold leading-tight text-blue transition active:scale-[.97]"
          >
            <ExternalLink aria-hidden size={16} strokeWidth={2} />
            Open
          </a>
        </div>
      </div>
    </section>
  )
}

function ActionButton({
  children,
  label,
  onClick,
  disabled,
  pressed,
}: {
  children: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
      className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-surface-2 px-2 py-1.5 text-center text-body font-semibold leading-tight text-blue transition active:scale-[.97] disabled:opacity-50"
    >
      {children}
      <span className="min-w-0">{label}</span>
    </button>
  )
}

function ReplaceButton({
  disabled,
  onClick,
}: {
  disabled: boolean
  onClick: () => void
}) {
  return (
    <ActionButton disabled={disabled} onClick={onClick} label="Replace">
      <RefreshCw aria-hidden size={16} strokeWidth={2} />
    </ActionButton>
  )
}

function HeaderButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-11 shrink-0 items-center gap-1 rounded-full px-2.5 text-body font-semibold text-blue transition active:opacity-50 disabled:opacity-50"
    >
      {children}
      {label}
    </button>
  )
}

// ──────────────────────────────────────────────────────────────────── edit

function EditBody({
  businessId,
  row,
  product,
  edit,
  hydrated,
  onEditDraft,
  onEditDone,
  onDeleted,
}: {
  businessId: Id<'businesses'>
  row: LiveProductRow
  product: ShownProduct
  edit: EditState
  hydrated: boolean
  onEditDraft: (update: (prev: ProductDraft) => ProductDraft) => void
  onEditDone: () => void
  onDeleted: (productId: string) => void
}) {
  const save = useProductSave(businessId)
  const remove = useConvexMutation(api.products.remove)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const onDelete = async () => {
    setDeleteError(null)
    setDeleting(true)
    try {
      await remove({ businessId, productId: row.id })
      onDeleted(row.id)
    } catch (error) {
      // The dialog has closed by now; the sheet says what happened.
      setDeleteError(productErrorMessage(error, 'delete'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className={`${SHEET_BODY} pt-3`}>
      <Drawer.Title className="pr-10 text-sheet-title text-ink">
        Edit product
      </Drawer.Title>
      <Drawer.Description className="mt-0.5 truncate pr-10 text-caption text-muted">
        {product.name}
      </Drawer.Description>

      <ProductForm
        mode="edit"
        draft={edit.draft}
        onDraft={onEditDraft}
        existing={{ photoUrl: row.photoUrl, pdf: row.pdf }}
        hydrated={hydrated}
        save={save}
        onCancel={onEditDone}
        onSubmit={() => {
          void save
            .saveEdit(row, edit.baseline, edit.draft)
            .then((saved) => saved && onEditDone())
        }}
        after={
          <>
            {deleteError && (
              <FormAlert className="mt-4">{deleteError}</FormAlert>
            )}
            <DeleteProductButton
              disabled={!hydrated || deleting || save.phase !== 'idle'}
              onClick={() => setConfirmOpen(true)}
            />
          </>
        }
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${row.name}?`}
        body={
          <>
            It goes from the list for everyone in the business, with its photo
            and PDF. Copies kept on phones are removed the next time each phone
            has signal.
          </>
        }
        cancel="Keep it"
        confirm="Delete"
        pending={deleting}
        onConfirm={() => void onDelete()}
      />

      {deleting && (
        <p role="status" className="mt-3 text-center text-caption text-muted">
          Deleting…
        </p>
      )}
    </div>
  )
}
