import { useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Plus, Upload } from 'lucide-react'
import { z } from 'zod'
import { api } from '../../../../convex/_generated/api'
import { clientFacets } from '../../../../convex/lib/clientFacets'
import { PageHeader } from '#/components/shell/PageHeader'
import { CardCells, ListPending } from '#/components/shell/Pending'
import {
  EMPTY_ACTION_CLASS,
  EmptyState,
  EmptyStateButton,
  LoadFailed,
  NoMatches,
} from '#/components/primitives/EmptyState'
import { LoadMore } from '#/components/primitives/LoadMore'
import { SearchBox } from '#/components/primitives/SearchBox'
import { NewPropertySheet } from '#/components/clients/NewPropertySheet'
import { ClientSheet } from '#/components/clients/ClientSheet'
import { ClientCard } from '#/components/clients/ClientCard'
import {
  ClientFilterBar,
  choosingAnotherSegment,
} from '#/components/clients/ClientFilterBar'
import { Segmented } from '#/components/primitives/Segmented'
import { useHydrated } from '#/lib/useHydrated'
import { useOnline } from '#/lib/online'
import { useStillPendingAfter } from '#/components/products/hooks'
import {
  filterClientRows,
  matchesClientSearch,
  useClientFilters,
} from '#/lib/clientFilters'
import { clientRows } from '#/lib/directory'
import { useCan } from '#/lib/access'
import { usePagedList } from '#/lib/usePagedList'
import { useRevealMore } from '#/lib/useRevealMore'
import { isUnauthenticatedError } from '#/lib/signInSettling'
import { isMfaEnrolmentError } from '#/lib/twoStep'
import {
  CLIENTS_PAGE,
  clientsFirstPage,
  loaderWaitMs,
  rq,
  searchParam,
  settleInBrowser,
  warm,
} from '#/lib/routeQueries'
import { HEADER_ADD_BUTTON } from '#/components/primitives/buttons'
import type {
  ClientPropertyRow,
  ClientRow,
} from '#/components/clients/ClientCard'

export const Route = createFileRoute('/$businessSlug/clients/')({
  // One way to read clients: the cards. The List and Table views were
  // retired, and `view` with them — the key is gone rather than narrowed, so
  // an old `?view=list` or `?view=table` link passes validation and opens the
  // cards. The stale key stays in the address bar until the first search.
  validateSearch: z.object({
    q: z.string().optional(),
    // Newest first unless A–Z is chosen. Absent is the default, so a plain
    // link to Clients stays plain; a stale or mistyped value falls back to it.
    sort: z.enum(['newest', 'az']).optional().catch(undefined),
  }),
  // The header's counts and the list the address asks for, together, before
  // the page renders: the newest clients' first page, or every client for a
  // search or A–Z (see the page). Read from the address here rather than
  // through `loaderDeps`: that would make every search a new match, and a
  // new match gets the route's placeholder — the search box with it, mid-word.
  // In the browser it waits only so long (`loaderWaitMs`).
  loader: ({ context: { queryClient, business }, location }) => {
    const everyClient =
      (searchParam(location, 'q') ?? '').trim() !== '' ||
      searchParam(location, 'sort') === 'az'
    return settleInBrowser(
      loaderWaitMs(),
      warm(
        queryClient,
        rq.clientOverview(business._id),
        everyClient
          ? rq.directory(business._id)
          : clientsFirstPage(business._id),
      ),
    )
  },
  component: ClientsPage,
})

/** A client as a card shows it, from either of the page's two lists. */
type CardRow = {
  client: ClientRow
  properties: Array<ClientPropertyRow>
  propertiesCapped?: boolean
}

type Sortable = {
  client: { name: string; createdAt: number; _creationTime: number }
}

/** Newest first: a client just added is usually the one about to be booked.
 * The directory arrives oldest first. */
const newestFirst = (a: Sortable, b: Sortable) =>
  b.client.createdAt - a.client.createdAt ||
  b.client._creationTime - a.client._creationTime

const byName = (a: Sortable, b: Sortable) =>
  a.client.name.localeCompare(b.client.name, undefined, { sensitivity: 'base' })

/** How long every client may take before the page says the signal is the
 * trouble: the directory is a few hundred KB for the largest book, which a
 * weak 3G signal takes several seconds to bring. With no signal at all the
 * page says so at once (`useOnline`). */
const EVERY_CLIENT_LATE_MS = 15_000

const NO_ROWS: Array<never> = []

function ClientsPage() {
  const { business } = Route.useRouteContext()
  const canManageClients = useCan('clients.manage')
  const canRenumber = useCan('business.manage')
  const { q, sort = 'newest' } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const [newOpen, setNewOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const hydrated = useHydrated()

  const searchTerm = q ?? ''
  const searching = searchTerm.trim() !== ''
  const {
    kind,
    setKind,
    suburb,
    setSuburb,
    status,
    setStatus,
    tag,
    setTag,
    clearFilters,
    filtersActive,
  } = useClientFilters()

  /**
   * Two ways to read the clients.
   *
   * As the page opens — newest first, nothing searched or filtered — it
   * shows the newest clients a page at a time (`clients.page`), which is
   * all most visits need: a business with 1,300 clients no longer sends
   * every one, and every site, to a phone to show the first ten.
   *
   * A search, A–Z or any filter needs every client to be right, and reads
   * the slim directory (`clients.directory`) — the same list the booking
   * pickers read — running the same search and filters over it on the phone
   * as before, so a client is found by any word of a street, part of a
   * name, an ABN or a site contact's number, which the server's search
   * could not do. It shows those 30 at a time.
   *
   * Neither read suspends: a filter is local state, and a list that
   * suspended on changing it would swap the whole page for the route's
   * placeholder, header and search box included. Each shows its own
   * placeholder in the list's place instead.
   */
  const everyClient = searching || sort === 'az' || filtersActive

  // How many clients, and the filters' choices for the whole book, worked
  // out on the server: the page no longer has every client to count. Warmed
  // by the loader whichever list it read.
  const { data: overview } = useSuspenseQuery(rq.clientOverview(business._id))

  const paged = usePagedList({
    query: api.clients.page,
    args: everyClient ? 'skip' : { businessId: business._id },
    first: everyClient
      ? convexQuery(api.clients.page, 'skip')
      : clientsFirstPage(business._id),
    pageSize: CLIENTS_PAGE,
  })

  // 'skip' rather than `enabled`: a disabled query still holds its Convex
  // subscription open.
  const directory = useQuery(
    everyClient
      ? rq.directory(business._id)
      : convexQuery(api.clients.directory, 'skip'),
  )
  // Every client the page lists, in the order chosen, that the search finds.
  // The filters' choices and counts are worked out from these, before the
  // filters narrow them, as they always were.
  const searched = useMemo(() => {
    if (!directory.data) return undefined
    const rows = clientRows(directory.data).sort(
      sort === 'az' ? byName : newestFirst,
    )
    return searching
      ? rows.filter((row) => matchesClientSearch(row, searchTerm))
      : rows
  }, [directory.data, sort, searching, searchTerm])
  const filtered = useMemo(
    () => searched && filterClientRows(searched, { kind, suburb, status, tag }),
    [searched, kind, suburb, status, tag],
  )
  // Until every client is here, the whole book's choices: the filter row
  // keeps its dropdowns rather than losing them and getting them back.
  const facets = useMemo(
    () => (searched ? clientFacets(searched) : overview),
    [searched, overview],
  )

  // A new search, order or filter starts the list again from its first 30.
  const listKey = everyClient
    ? JSON.stringify([searchTerm, sort, kind, suburb, status, tag])
    : 'newest'
  const revealed = useRevealMore(filtered ?? NO_ROWS, CLIENTS_PAGE, listKey)

  // Signed out mid-load, or two-step now required: the route's own screens
  // say so (router.tsx), as they did when the whole list suspended. Anything
  // else is the list's own to report, in its place.
  if (
    directory.data === undefined &&
    (isUnauthenticatedError(directory.error) ||
      isMfaEnrolmentError(directory.error))
  ) {
    throw directory.error
  }

  const rows: ReadonlyArray<CardRow> = everyClient
    ? revealed.visible
    : paged.rows
  // Every client, still not here — no signal, or a signal too weak to
  // bring them. A Convex read waits rather than failing, so without this a
  // search with no signal would leave the placeholder up for good, where the
  // page should say why and offer to try again. (The first page, the counts
  // and whatever was kept from earlier still come from the phone.)
  const online = useOnline()
  const everyClientLate = useStillPendingAfter(
    everyClient && directory.data === undefined && directory.error === null,
    EVERY_CLIENT_LATE_MS,
  )
  const failed = everyClient
    ? directory.data === undefined &&
      (directory.error !== null || !online || everyClientLate)
    : paged.error != null
  const loading = everyClient ? filtered === undefined : paged.loading
  // Only a list read to its end is empty: a first page can come back with
  // nothing in it and more behind it.
  const empty = everyClient ? filtered?.length === 0 : paged.empty

  // Every client, asked for the moment the page knows it will want them — a
  // first letter typed, a press on A–Z or on a filter — so the list is
  // usually here by the time the choice is made. Not on focusing the search
  // box: a tap there to look costs every client, held for a quarter of an
  // hour (the cache's gcTime), whether a word is typed or not.
  const wantEveryClient = () =>
    void warm(queryClient, rq.directory(business._id))

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={`${overview.total}${overview.capped ? '+' : ''} ${overview.total === 1 && !overview.capped ? 'client' : 'clients'}`}
        title="Clients"
        action={
          <>
            {/* Beside the +, quieter than it: most days a client is added
                one at a time, and a list is brought across once. A link,
                so it works before the page has hydrated. Only for those
                who may import — the server refuses anyone else. */}
            {canManageClients && (
              <Link
                to="/$businessSlug/clients/import"
                params={{ businessSlug: business.slug }}
                aria-label="Import clients"
                className="relative tap-target flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-body font-semibold text-blue transition active:scale-[.97]"
              >
                <Upload aria-hidden size={16} strokeWidth={2.2} />
                Import
              </Link>
            )}
            <button
              type="button"
              aria-label="New client"
              disabled={!hydrated}
              onClick={() => setNewOpen(true)}
              className={HEADER_ADD_BUTTON}
            >
              <Plus size={20} strokeWidth={2} />
            </button>
          </>
        }
      />

      <div
        className="flex px-4 pt-3"
        onInput={everyClient ? undefined : wantEveryClient}
      >
        {/* The shared box, not a bare input bound to the URL: that navigated
            on every keystroke and, while a navigation was in flight, put the
            committed term back over whatever had been typed since. The
            search is `q` alone now — the only thing this page keeps in the
            URL — which also drops a retired `?view=` an old link brought in,
            since the router carries unknown keys along otherwise. */}
        <SearchBox
          value={q ?? ''}
          onChange={(term) =>
            // Only what this page keeps: the search and the sort. Anything
            // else an old link carried (a retired `?view=`) is dropped.
            navigate({
              search: (prev) => ({ q: term || undefined, sort: prev.sort }),
              replace: true,
            })
          }
          label="Search by name or address"
          placeholder="Search by name, address or #number"
        />
      </div>

      <div
        className="px-4 pt-3"
        onPointerDown={(event) => {
          if (!everyClient && choosingAnotherSegment(event)) wantEveryClient()
        }}
      >
        <Segmented
          label="Sort clients"
          value={sort}
          onChange={(next) =>
            navigate({
              search: (prev) => ({
                q: prev.q,
                sort: next === 'newest' ? undefined : next,
              }),
              replace: true,
            })
          }
          disabled={!hydrated}
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'az', label: 'A–Z' },
          ]}
        />
      </div>

      <section className="px-4 pt-4 pb-6">
        <div className="mb-3">
          <ClientFilterBar
            facets={facets}
            kind={kind}
            setKind={setKind}
            suburb={suburb}
            setSuburb={setSuburb}
            status={status}
            setStatus={setStatus}
            tag={tag}
            setTag={setTag}
            filtered={filtersActive}
            onClear={clearFilters}
            onIntent={everyClient ? undefined : wantEveryClient}
          />
        </div>

        {failed ? (
          <LoadFailed
            what={everyClient ? 'every client to search' : 'the clients'}
            onRetry={everyClient ? () => void directory.refetch() : paged.retry}
          />
        ) : loading ? (
          <ListPending label="Loading clients" count={4} columns={2} />
        ) : empty ? (
          searching || filtersActive ? (
            <NoMatches
              term={q}
              hint="Try a different name, address or filter."
              clearLabel={q ? 'Clear search' : 'Clear filters'}
              onClear={() => {
                clearFilters()
                void navigate({
                  search: (prev) => ({ q: undefined, sort: prev.sort }),
                  replace: true,
                })
              }}
            />
          ) : (
            <EmptyState
              title="No clients yet"
              body="Add a client to start booking work for them."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <EmptyStateButton
                    onClick={() => setNewOpen(true)}
                    disabled={!hydrated}
                  >
                    Add a client
                  </EmptyStateButton>
                  {/* A business moving from another app has hundreds, not
                      one: the list is where most of them start. */}
                  {canManageClients && (
                    <Link
                      to="/$businessSlug/clients/import"
                      params={{ businessSlug: business.slug }}
                      className={EMPTY_ACTION_CLASS}
                    >
                      Import a list
                    </Link>
                  )}
                </div>
              }
            />
          )
        ) : (
          rows.length > 0 && (
            <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch">
              {rows.map(({ client, properties: owned, propertiesCapped }) => (
                <ClientCard
                  key={client._id}
                  client={client}
                  properties={owned}
                  propertiesCapped={propertiesCapped}
                  onOpen={setOpenId}
                />
              ))}
              {/* The next page on its way, in the cards' own grid. */}
              {!everyClient && paged.loadingMore && <CardCells count={2} />}
            </div>
          )
        )}

        {/* Not while the list is still to come: its placeholder says so. */}
        {!failed && !loading && (
          <LoadMore
            canLoadMore={everyClient ? revealed.canLoadMore : paged.canLoadMore}
            loading={!everyClient && paged.loadingMore}
            onLoadMore={everyClient ? revealed.loadMore : paged.loadMore}
            noun="clients"
            shown={rows.length}
            resetKey={listKey}
          />
        )}
      </section>

      <NewPropertySheet
        businessId={business._id}
        open={newOpen}
        onClose={() => setNewOpen(false)}
      />

      <ClientSheet
        businessId={business._id}
        timezone={business.timezone}
        businessSlug={business.slug}
        businessState={business.state}
        canManageClients={canManageClients}
        canRenumber={canRenumber}
        clientId={openId}
        onClose={() => setOpenId(null)}
      />
    </>
  )
}
