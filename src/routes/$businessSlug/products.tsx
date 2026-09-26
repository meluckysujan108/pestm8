import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus, WifiOff } from 'lucide-react'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { ListPending } from '#/components/shell/Pending'
import {
  EmptyState,
  EmptyStateButton,
} from '#/components/primitives/EmptyState'
import { SearchBox } from '#/components/primitives/SearchBox'
import { NewProductSheet } from '#/components/products/NewProductSheet'
import { ProductCard } from '#/components/products/ProductCard'
import { ProductSheet } from '#/components/products/ProductSheet'
import { ViewerHost, ViewerStatusPill } from '#/components/pdf/host/ViewerHost'
import { useShareSupport } from '#/components/pdf/host/useShareSupport'
import { useOnline, useStillPendingAfter } from '#/components/products/hooks'
import {
  baselineOf,
  fromKept,
  fromLive,
  pdfAvailable,
} from '#/components/products/model'
import { pdfSourceFor } from '#/components/products/pdfSource'
import { useKeepToggle } from '#/components/products/usePdfActions'
import {
  replaceStatusText,
  useReplacePdf,
} from '#/components/products/useReplacePdf'
import { keptSyncKey, syncKept, useKeptProducts } from '#/lib/keptProducts'
import { savePdf, sharePdf } from '#/lib/pdfFiles'
import { noteListedPdfs } from '#/lib/pdfMemory'
import { EMPTY_DRAFT, draftFrom } from '#/lib/productForm'
import { filterProducts } from '#/lib/productSearch'
import { rq, settleWithin, warm } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import type { HistoryState } from '@tanstack/react-router'
import type { EditState, SheetStatus } from '#/components/products/ProductSheet'
import type { LiveProductRow } from '#/components/products/model'
import type { ProductDraft } from '#/lib/productForm'

/**
 * Products (Phase 7.1): the business's shelf — each product's name, a few
 * lines about it, a photo, the maker's link and one PDF, the label or the
 * safety data sheet. Shared business-wide: everyone reads it and adds to it;
 * the person who added a product, or the owner, changes it (the row's
 * `canEdit`, which the server works out — never the role here).
 *
 * ── Where the list comes from ─────────────────────────────────────────────
 *
 * The live list, whenever there is one. With no signal a Convex query does
 * not fail, it waits — so the page cannot tell "slow" from "nothing coming",
 * and the loader and the page each give it only so long. After that, or at
 * once when the phone says it is offline, the page shows the products KEPT on
 * this phone (keptProducts.ts), read-only, their PDFs opening from the copy.
 * When the live list arrives it takes over, and the kept copies are brought
 * in line with it: a replaced PDF re-downloaded, a deleted product dropped.
 *
 * ── The address bar ───────────────────────────────────────────────────────
 *
 * `?product=<id>` is the open product and `?view=pdf` its open PDF. Each is
 * PUSHED, so the phone's back gesture closes the viewer first and then the
 * sheet, the way it closes anything on a phone. Closing from the app does the
 * same, by going back — but only through an entry this page pushed (it marks
 * them in the history state), so a link that opened straight onto a product
 * closes by replacing instead of backing out of the app.
 *
 * The id in the URL is only ever compared against ids in the list. It is
 * never handed to Convex: every write takes its id from the list's own row,
 * so a stale, foreign or made-up id opens nothing and costs nothing.
 *
 * The sheet and the viewer are never open together (`wantsViewer`): both are
 * modal, and two focus traps stacked is one too many.
 */

const searchSchema = z.object({
  q: z.string().optional(),
  // Lenient: a mistyped or stale link opens the list, not an error page.
  product: z.string().optional().catch(undefined),
  view: z.literal('pdf').optional().catch(undefined),
})

/** How long the loader holds the navigation for the list, at most. */
const LOADER_WAIT_MS = 2000
/** How long the page waits on the list before showing what is kept. */
const LIST_WAIT_MS = 3000

export const Route = createFileRoute('/$businessSlug/products')({
  validateSearch: searchSchema,
  // Warm the list, but never hold the page hostage to it: `warm` resolves
  // only when the query does, and with no signal that is never. The page
  // reads the list without suspending, so it has its own answer for a list
  // that is late.
  loader: ({ context: { queryClient, business } }) =>
    settleWithin(LOADER_WAIT_MS, warm(queryClient, rq.products(business._id))),
  component: ProductsPage,
})

/** Marks a history entry as pushed by this page — see the top of the file. */
const PUSHED_KEY = 'productsPushed'
const pushedState = () => ({ [PUSHED_KEY]: true }) as HistoryState

function ProductsPage() {
  const { business } = Route.useRouteContext()
  const businessId = business._id
  const { q, product: openId, view } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const hydrated = useHydrated()
  const online = useOnline()
  const support = useShareSupport()
  const kept = useKeptProducts(businessId)

  // ── The list: live, or what is kept ─────────────────────────────────────

  const query = useQuery(rq.products(businessId))
  const live = query.data
  const late = useStillPendingAfter(
    live === undefined && !query.isError,
    LIST_WAIT_MS,
  )
  const fallback = live === undefined && (late || !online || query.isError)
  const keptEntries = kept.entries

  const products = useMemo(() => {
    if (live) {
      const keptById = new Map(
        (keptEntries ?? []).map((entry) => [entry.productId, entry]),
      )
      return live.map((row) => fromLive(row, keptById.get(row.id) ?? null))
    }
    if (fallback && keptEntries) return keptEntries.map(fromKept)
    return null
  }, [live, fallback, keptEntries])

  const shown = useMemo(
    () => (products ? filterProducts(products, q ?? '') : null),
    [products, q],
  )

  // A PDF this phone just uploaded is settled under its URL as soon as the
  // list shows it, opened or not — so it is never mistaken, later, for a
  // different file the product gets after (`noteListedPdfs`).
  useEffect(() => {
    if (live) noteListedPdfs(live)
  }, [live])

  // Kept copies follow the live list — never a list still loading, which
  // would read as "everything was deleted" — and again whenever a keep lands,
  // since the list may have moved on while it downloaded (`keptSyncKey`).
  const keptKey = keptSyncKey(keptEntries)
  useEffect(() => {
    if (live && keptKey !== '') void syncKept(businessId, live)
  }, [businessId, live, keptKey])

  // ── What is open ────────────────────────────────────────────────────────

  const open =
    openId !== undefined && products
      ? (products.find((product) => product.id === openId) ?? null)
      : null

  // The product that was open, so one deleted by someone else while it is
  // on screen says so, where an id that never matched just opens nothing.
  const [seenId, setSeenId] = useState<string | null>(null)
  if (open && open.id !== seenId) setSeenId(open.id)
  // Deleted from this sheet: it closes, and must not flash "not found" first.
  const [deletedId, setDeletedId] = useState<string | null>(null)

  const wantsViewer = view === 'pdf' && open !== null && pdfAvailable(open)
  const status: SheetStatus =
    products === null ? 'loading' : open ? 'found' : 'missing'
  const sheetOpen =
    openId !== undefined &&
    openId !== deletedId &&
    // Never on the viewer's entry: it is either showing the viewer, or on
    // its way back off it (`viewerGone`, below).
    view !== 'pdf' &&
    // "Not found" only for the product that was open here — deleted since.
    // An id that never matched anything just opens nothing.
    (status !== 'missing' || openId === seenId)

  // ── Getting there and back ──────────────────────────────────────────────

  const pushedHere = useCallback(
    () =>
      (router.history.location.state as { [PUSHED_KEY]?: unknown })[
        PUSHED_KEY
      ] === true,
    [router],
  )
  // A second close before the first has landed (the X and the overlay, a
  // double tap) must not go back twice — out of the page altogether. Keyed
  // by the history entry, not the address: reopening the same product
  // pushes a new entry with the same address, and that one must close.
  const backingOutOf = useRef<string | null>(null)
  const goBack = useCallback(() => {
    const { state, href } = router.history.location
    const entry = state.__TSR_key ?? state.key ?? href
    if (backingOutOf.current === entry) return
    backingOutOf.current = entry
    router.history.back()
  }, [router])
  // Once the history moves — the back landing, or anything else — that
  // close is over. Not left standing: the browser's Forward brings back the
  // very entry that was closed, key and all (the key lives in the history
  // state), and its sheet must close again.
  useEffect(
    () =>
      router.history.subscribe(() => {
        backingOutOf.current = null
      }),
    [router],
  )

  const [edit, setEdit] = useState<EditState | null>(null)

  const openProduct = useCallback(
    (productId: string) => {
      // An unfinished edit of a different product is let go.
      setEdit((prev) => (prev?.productId === productId ? prev : null))
      setDeletedId(null)
      void navigate({
        search: (prev) => ({ ...prev, product: productId, view: undefined }),
        state: pushedState,
      })
    },
    [navigate],
  )

  const closeSheet = useCallback(() => {
    if (pushedHere()) goBack()
    else
      void navigate({
        search: (prev) => ({ ...prev, product: undefined, view: undefined }),
        replace: true,
      })
  }, [goBack, navigate, pushedHere])

  const openViewer = useCallback(() => {
    void navigate({
      search: (prev) => ({ ...prev, view: 'pdf' as const }),
      state: pushedState,
    })
  }, [navigate])

  const closeViewer = useCallback(() => {
    if (pushedHere()) goBack()
    else
      void navigate({
        search: (prev) => ({ ...prev, view: undefined }),
        replace: true,
      })
  }, [goBack, navigate, pushedHere])

  // The PDF was asked for but there is none to show: someone else deleted
  // the product, or removed its PDF, while it was open here (or a link asked
  // for a PDF that is not there). Leave the viewer's entry at once, the way
  // its Done would. Left in place, the sheet would open ON that entry, and
  // its first close would only go back to the entry beneath — the same
  // sheet, again.
  const viewerGone = view === 'pdf' && products !== null && !wantsViewer
  useEffect(() => {
    if (viewerGone) closeViewer()
  }, [viewerGone, closeViewer])

  // ── New and edit ────────────────────────────────────────────────────────

  const [newOpen, setNewOpen] = useState(false)
  const [newDraft, setNewDraft] = useState<ProductDraft>(EMPTY_DRAFT)

  const onEdit = useCallback((row: LiveProductRow) => {
    setEdit((prev) => {
      if (prev?.productId === row.id) return prev
      const baseline = baselineOf(row)
      return { productId: row.id, baseline, draft: draftFrom(baseline) }
    })
  }, [])

  // ── The viewer ──────────────────────────────────────────────────────────

  const replace = useReplacePdf(businessId)
  const viewerProduct = wantsViewer ? open : null
  const viewerKeep = useKeepToggle(businessId, viewerProduct)

  // Read by the viewer's loader when it runs, not when it was made.
  const onlineRef = useRef(online)
  useEffect(() => {
    onlineRef.current = online
  })
  const source = useMemo(
    () =>
      viewerProduct
        ? pdfSourceFor(businessId, viewerProduct, () => onlineRef.current)
        : null,
    [businessId, viewerProduct],
  )

  // A keep from inside the viewer that failed says so over it, briefly.
  const [keepNote, setKeepNote] = useState<string | null>(null)
  const keepNoteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  useEffect(() => () => clearTimeout(keepNoteTimer.current), [])
  const toggleKeepInViewer = () => {
    void viewerKeep.toggle().then((outcome) => {
      if (!outcome || outcome.ok || outcome.reason === 'cancelled') return
      clearTimeout(keepNoteTimer.current)
      setKeepNote(outcome.message)
      keepNoteTimer.current = setTimeout(() => setKeepNote(null), 6000)
    })
  }

  const replaceHere =
    viewerProduct && replace.status?.productId === viewerProduct.id
      ? replace.status
      : null
  const viewerNote = replaceHere
    ? {
        text: replaceStatusText(replaceHere),
        tone: replaceHere.phase === 'failed' ? 'problem' : 'info',
      }
    : keepNote
      ? { text: keepNote, tone: 'problem' }
      : null

  // ── Page ────────────────────────────────────────────────────────────────

  const count = products?.length ?? 0
  const kicker =
    products === null
      ? ' '
      : live
        ? `${count} ${count === 1 ? 'product' : 'products'}`
        : `${count} kept on this phone`
  const searching = (q ?? '').trim() !== ''

  return (
    <>
      <PageHeader
        businessId={businessId}
        businessSlug={business.slug}
        kicker={kicker}
        title="Products"
        action={
          <button
            type="button"
            aria-label="New product"
            // Adding needs the server; with only the kept list there is none.
            disabled={!hydrated || fallback}
            onClick={() => setNewOpen(true)}
            className="flex size-9 items-center justify-center rounded-full bg-red text-white shadow-red transition active:scale-[.95] disabled:opacity-50"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
        }
      />

      <div className="flex px-4 pt-3">
        <SearchBox
          value={q ?? ''}
          onChange={(term) =>
            navigate({
              search: (prev) => ({ ...prev, q: term || undefined }),
              replace: true,
              // Keeps this entry's marks: a search finishing just as a card
              // is tapped must not make the page forget it pushed the card.
              state: true,
            })
          }
          label="Search products"
          placeholder="Search products"
        />
      </div>

      {fallback && (
        <p
          role="status"
          className="mx-4 mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-caption text-ink-2"
        >
          <WifiOff aria-hidden size={14} strokeWidth={2} className="shrink-0" />
          {query.isError && online
            ? 'Could not load the products — showing the ones kept on this phone'
            : 'No signal — showing products kept on this phone'}
        </p>
      )}

      <section className="px-4 pb-6 pt-4">
        {shown === null ? (
          <ListPending label="Loading products" count={4} />
        ) : shown.length === 0 ? (
          searching ? (
            <EmptyState title="No matches" body="Try a different name." />
          ) : live ? (
            <EmptyState
              title="No products yet"
              body="Add the products your team uses — the label, the safety data sheet, the supplier's page — so anyone can pull them up on site."
              action={
                <EmptyStateButton
                  onClick={() => setNewOpen(true)}
                  disabled={!hydrated}
                >
                  Add a product
                </EmptyStateButton>
              }
            />
          ) : (
            <EmptyState
              title="Nothing kept on this phone"
              body="With signal, open a product and tap Keep on this phone. Its PDF will then open here when there's no signal."
            />
          )
        ) : (
          <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2">
            {shown.map((product) => (
              <ProductCard
                key={product.id}
                businessId={businessId}
                product={product}
                kept={keptEntries !== null && kept.isKept(product.id)}
                onOpen={openProduct}
              />
            ))}
          </div>
        )}
      </section>

      <ProductSheet
        businessId={businessId}
        open={sheetOpen}
        status={status}
        product={open}
        online={online}
        hydrated={hydrated}
        support={support}
        onClose={closeSheet}
        onView={openViewer}
        onReplace={online ? replace.pick : undefined}
        replaceStatus={replace.status}
        edit={edit}
        onEdit={onEdit}
        onEditDraft={(update) =>
          setEdit((prev) => prev && { ...prev, draft: update(prev.draft) })
        }
        onEditDone={() => setEdit(null)}
        onDeleted={(productId) => {
          setDeletedId(productId)
          setEdit(null)
          closeSheet()
        }}
      />

      <NewProductSheet
        businessId={businessId}
        open={newOpen}
        draft={newDraft}
        onDraft={setNewDraft}
        hydrated={hydrated}
        onClose={() => setNewOpen(false)}
        onCreated={(productId) => {
          setNewDraft(EMPTY_DRAFT)
          setNewOpen(false)
          openProduct(productId)
        }}
      />

      {/* The one picker Replace uses, from the sheet or the viewer. */}
      <input {...replace.inputProps} />

      {hydrated && viewerProduct && source && (
        <ViewerHost
          key={viewerProduct.id}
          title={viewerProduct.name}
          fileName={viewerProduct.pdf?.fileName ?? `${viewerProduct.name}.pdf`}
          source={source}
          actions={{
            share: support.files
              ? (file) => sharePdf(file, { title: viewerProduct.name })
              : undefined,
            save: savePdf,
            saveLabel: support.saveLabel,
            // One upload at a time (`useReplacePdf`): while one is going up,
            // this product's or another's, there is no Replace to offer.
            replace:
              viewerProduct.canEdit &&
              viewerProduct.live &&
              online &&
              !replace.busy
                ? () => viewerProduct.live && replace.pick(viewerProduct.live)
                : undefined,
            keep: viewerKeep.available
              ? {
                  kept: viewerKeep.kept,
                  busy: viewerKeep.busy,
                  toggle: toggleKeepInViewer,
                }
              : undefined,
          }}
          onClose={closeViewer}
        />
      )}
      {hydrated && viewerProduct && viewerNote && (
        <ViewerStatusPill
          text={viewerNote.text}
          tone={viewerNote.tone === 'problem' ? 'problem' : 'info'}
        />
      )}
    </>
  )
}
