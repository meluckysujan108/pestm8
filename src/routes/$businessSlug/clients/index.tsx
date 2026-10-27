import { useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Plus, Upload } from 'lucide-react'
import { z } from 'zod'
import { api } from '../../../../convex/_generated/api'
import { clientFacets } from '../../../../convex/lib/clientFacets'
import { areaCodeOf } from '../../../../convex/lib/contactKeys'
import { KeptCopyNote } from '#/components/shell/KeptCopyNote'
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
import { useToday } from '#/lib/useToday'
import { todayKey as todayKeyIn } from '#/lib/format'
import { logConnection } from '#/lib/connectionLog'
import { keeper } from '#/lib/offline/keeper'
import {
  KEPT_CLIENTS_WAIT_MS,
  clientCountLabel,
  clientsListView,
  directoryCount,
  firstPageShows,
  keptClientsMode,
  loaderHoldMs,
  moreClientsWithSignal,
  newestDrawn,
  noMatchesHint,
  openingWaitSince,
} from '#/lib/offline/keptClients'
import {
  useBehindOnce,
  useInMemory,
  useKeptMode,
  useKeptNote,
  useLateSince,
  useLineDown,
  useReadable,
} from '#/lib/offline/useKept'
import { useStillPendingAfter } from '#/components/products/hooks'
import {
  filterClientRows,
  searchClientRows,
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
import type { ClientFacets } from '../../../../convex/lib/clientFacets'

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
  // In the browser it waits only so long (`loaderWaitMs`), and not at all
  // with the line down (`keeper.lineDown`), when the page reads every client
  // from the phone's copy, which answers at once, and nothing else answers.
  // With every client on the phone, which the page draws once the newest
  // are late, no longer than that wait, and not at all on a line PestM8
  // hasn't spoken on lately (`loaderHoldMs`).
  //
  // It also says what today is, for the "Updated" note's first render: the
  // server's, so a copy of the page the service worker kept from yesterday
  // still hydrates as it was rendered. And, in the browser, when the page
  // was asked for and when this run settled: the page's wait for the newest
  // clients counts from the tap, if this run is what opened it.
  loader: async ({ context: { queryClient, business }, location }) => {
    const today = todayKeyIn(business.timezone)
    const askedAt = typeof window === 'undefined' ? null : Date.now()
    const down = keeper.lineDown()
    const everyClient =
      down ||
      (searchParam(location, 'q') ?? '').trim() !== '' ||
      searchParam(location, 'sort') === 'az'
    await settleInBrowser(
      loaderHoldMs({
        lineDown: down,
        lineLive: keeper.lineLive(),
        everyClientOnPhone: keeper.onPhone(rq.directory(business._id).queryKey),
        waitMs: loaderWaitMs(),
      }),
      warm(
        queryClient,
        ...(down ? [] : [rq.clientOverview(business._id)]),
        everyClient
          ? rq.directory(business._id)
          : clientsFirstPage(business._id),
      ),
    )
    const settledAt = askedAt === null ? null : Date.now()
    return { today, askedAt, settledAt }
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
 * weak 3G signal takes several seconds to bring. With the line down and no
 * copy of them on the phone, the page says so at once (`useReadable`). */
const EVERY_CLIENT_LATE_MS = 15_000

const NO_ROWS: Array<never> = []

/** No choices yet: the filter row has its type control and nothing else. */
const NO_FACETS: ClientFacets = {
  suburbs: [],
  tags: [],
  statuses: { active: 0, lead: 0, inactive: 0 },
}

function ClientsPage() {
  const { business } = Route.useRouteContext()
  const loaded = Route.useLoaderData()
  // The loader's today until the page has hydrated, then the phone's.
  const today = useToday(business.timezone, loaded.today)
  // When this page's wait for the newest clients began, kept for as long as
  // it is open: the loader runs again on each search, and says the time of
  // that; and a page the router kept from an earlier visit opens on that
  // visit's answer (`openingWaitSince`).
  const [openedAt] = useState(() => openingWaitSince(loaded, Date.now()))
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
   *
   * With the line down, the page reads every client (`keptMode`): the phone
   * keeps the directory, and neither the first page nor the server's counts.
   * So too on a line that looks up when the newest clients haven't come
   * KEPT_CLIENTS_WAIT_MS after the tap and the directory is in memory.
   * Decided as the page first draws, or later while the list is still on
   * its placeholder, and never once the newest clients are on screen, so
   * the list never changes source under a thumb; the hydration render draws
   * what the server did, and that stays (`keptClientsMode`, `useKeptMode`).
   * A first page that came back empty with more behind it draws only the
   * placeholder, so it decides nothing until cards are drawn
   * (`newestDrawn`).
   */
  const down = useLineDown()
  const directoryKey = rq.directory(business._id).queryKey
  const wantsEveryClient = searching || sort === 'az' || filtersActive
  const firstPage = queryClient.getQueryData<{
    page: ReadonlyArray<unknown>
    isDone: boolean
  }>(clientsFirstPage(business._id).queryKey)
  // The newest clients have been drawn as cards on this page (below).
  const [rowsDrawn, setRowsDrawn] = useState(false)
  const newestOnScreen =
    !wantsEveryClient &&
    newestDrawn({
      firstPage,
      rowsDrawn,
      overviewInMemory:
        queryClient.getQueryData(rq.clientOverview(business._id).queryKey) !==
        undefined,
      lineDown: down !== null,
    })
  const newestLate = useLateSince(
    !wantsEveryClient && !newestOnScreen,
    KEPT_CLIENTS_WAIT_MS,
    openedAt,
  )
  const directoryInMemory = useInMemory(directoryKey)
  const keptMode = useKeptMode(
    () =>
      keptClientsMode({
        lineDown: keeper.lineDown(),
        directoryReadable: keeper.readable(directoryKey),
        copyRead: keeper.copyRead(),
        firstPageShows: firstPageShows(firstPage),
        directoryInMemory,
        late: newestLate,
      }),
    newestOnScreen,
  )
  const everyClient = keptMode || wantsEveryClient

  // How many clients, and the filters' choices for the whole book, worked
  // out on the server: the page no longer has every client to count. Warmed
  // by the loader whichever list it read. Not suspended on: it is never kept
  // on the phone, and with the line down would never come. Then the count
  // is the phone's copy's, and the choices are worked out from it, as for a
  // search (below). The newest clients wait for it (`newestDrawn`), so its
  // row of choices never lands above cards already there.
  const overviewQuery = useQuery(
    keptMode
      ? convexQuery(api.clients.overview, 'skip')
      : rq.clientOverview(business._id),
  )
  const overview = overviewQuery.data

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
  // A local number typed or saved without its area code is the business's.
  const areaCode = areaCodeOf(business.state)
  const searched = useMemo(() => {
    if (!directory.data) return undefined
    const rows = clientRows(directory.data).sort(
      sort === 'az' ? byName : newestFirst,
    )
    return searching ? searchClientRows(rows, searchTerm, areaCode) : rows
  }, [directory.data, sort, searching, searchTerm, areaCode])
  const filtered = useMemo(
    () => searched && filterClientRows(searched, { kind, suburb, status, tag }),
    [searched, kind, suburb, status, tag],
  )
  // Until every client is here, the whole book's choices: the filter row
  // keeps its dropdowns rather than losing them and getting them back.
  const facets = useMemo(
    () => (searched ? clientFacets(searched) : (overview ?? NO_FACETS)),
    [searched, overview],
  )
  // The header's count: the server's, or with every client here and no
  // count from the server (the line down), every client the phone holds.
  const count =
    overview ?? (directory.data ? directoryCount(directory.data) : undefined)

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
  // A refused count is the route's to show, as it was when the page
  // suspended on it.
  if (overview === undefined && overviewQuery.error) throw overviewQuery.error

  const rows: ReadonlyArray<CardRow> = everyClient
    ? revealed.visible
    : paged.rows
  // Every client, still not here — the line down and no copy of them on the
  // phone, or a signal too weak to bring them. A Convex read waits rather
  // than failing, so without this a search with no signal would leave the
  // placeholder up for good, where the page should say why and offer to try
  // again. With the line down that is known at once (`useReadable`): the
  // phone's copy answers in a moment, or there is none. (The first page and
  // the counts still come from memory, when they are there.)
  const directoryReadable = useReadable(directoryKey)
  const everyClientLate = useStillPendingAfter(
    everyClient && directory.data === undefined && directory.error === null,
    EVERY_CLIENT_LATE_MS,
  )
  const failed = everyClient
    ? directory.data === undefined &&
      (directory.error !== null || !directoryReadable || everyClientLate)
    : paged.error != null
  const loading = everyClient
    ? filtered === undefined
    : paged.loading || (overview === undefined && down === null)
  // Only a list read to its end is empty: a first page can come back with
  // nothing in it and more behind it.
  const empty = everyClient ? filtered?.length === 0 : paged.empty
  // The newest clients as cards: from here the list keeps its source.
  if (!rowsDrawn && !everyClient && !failed && !loading && rows.length > 0) {
    setRowsDrawn(true)
  }
  // What goes around the list (`clientsListView`): NoMatches, the next
  // page's bones, what its end says, and whether the note stays. With the
  // line down, the newest clients ask for no more: the end of the list says
  // when more show instead, and that a search finds every client the phone
  // has.
  const view = clientsListView({
    keptMode,
    wantsEveryClient,
    searching,
    filtersActive,
    lineDown: down !== null,
    failed,
    loading,
    empty,
    paged,
  })
  // What the list searched is about, for the note and for NoMatches.
  const about = JSON.stringify([searchTerm, sort, kind, suburb, status, tag])
  // A search the list as the phone last had it has no match for: a client
  // added since isn't in it. Decided as NoMatches shows, and kept while it
  // does.
  const directoryBehind = useBehindOnce(directoryKey, view.noMatches, about)

  // Every client, asked for the moment the page knows it will want them — a
  // first letter typed, a press on A–Z or on a filter — so the list is
  // usually here by the time the choice is made. Not on focusing the search
  // box: a tap there to look costs every client, held for a quarter of an
  // hour (the cache's gcTime), whether a word is typed or not.
  const wantEveryClient = () =>
    void warm(queryClient, rq.directory(business._id))

  // What is on screen is drawn from these: the note under the search box
  // says when they were last known right, if they are the phone's copy. A
  // search, order or filter redraws the list too, and once all of it is
  // live the note goes with the next. Never over "Could not load": for good
  // once the list the page comes back to can't be drawn, and only while it
  // says so for a search over the newest clients (`clientsListView`).
  const keptNote = useKeptNote(
    keptMode
      ? [directoryKey]
      : [
          rq.clientOverview(business._id).queryKey,
          everyClient ? directoryKey : clientsFirstPage(business._id).queryKey,
        ],
    business.timezone,
    today,
    { about, ...view.note },
  )
  // For the phone's connection notes: a list the phone keeps no copy of.
  useEffect(() => {
    if (keptMode && failed) logConnection('kept-not-here', { what: 'clients' })
  }, [keptMode, failed])

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        // A line kept for the count while it is on its way, so the title
        // doesn't move when it lands.
        kicker={count ? clientCountLabel(count) : '\u00a0'}
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
          label="Search clients by name, address, phone or email"
          placeholder="Search by name, address, phone, email or #number"
        />
      </div>

      {/* Under the search box, where the Products page says it. While it
          says the line is down, the notice gives way to it unless a change
          is waiting to save; then its band, fixed under the header, can
          cover it, and says when the screen was last updated itself. */}
      <KeptCopyNote
        {...keptNote}
        timezone={business.timezone}
        todayKey={today}
      />

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
            what={wantsEveryClient ? 'every client to search' : 'the clients'}
            onRetry={everyClient ? () => void directory.refetch() : paged.retry}
          />
        ) : loading ? (
          <ListPending label="Loading clients" count={4} columns={2} />
        ) : empty ? (
          view.noMatches ? (
            <NoMatches
              term={q}
              // The list as the phone last had it, whichever way the page
              // reads: a client added since, on this phone or another, isn't
              // in it yet. Decided as it shows, so the hint never changes
              // length over Clear search.
              hint={noMatchesHint(directoryBehind)}
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
              {view.bones && <CardCells count={2} />}
            </div>
          )
        )}

        {/* Not while the list is still to come: its placeholder says so. */}
        {view.end === 'more-with-signal' ? (
          <p className="mt-3 text-center text-caption text-muted">
            {moreClientsWithSignal(directoryReadable)}
          </p>
        ) : view.end === 'load-more' ? (
          <LoadMore
            canLoadMore={everyClient ? revealed.canLoadMore : paged.canLoadMore}
            loading={!everyClient && paged.loadingMore}
            onLoadMore={everyClient ? revealed.loadMore : paged.loadMore}
            noun="clients"
            shown={rows.length}
            resetKey={listKey}
          />
        ) : null}
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
