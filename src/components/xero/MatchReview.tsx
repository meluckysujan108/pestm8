import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { usePaginatedQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { ListPending, SectionPending } from '#/components/shell/Pending'
import {
  EMPTY_ACTION_CLASS,
  EmptyState,
  LoadFailed,
} from '#/components/primitives/EmptyState'
import { SECONDARY_BUTTON } from '#/components/primitives/buttons'
import { useLatest } from '#/components/forms/SaveWarnings'
import { BackLink, SettingsBody, SettingsGroup } from '#/components/settings/ui'
import { useAccess, useActing, useCan } from '#/lib/access'
import { formatWhen } from '#/lib/format'
import { MATCH_PAGE, matchFirstPage, rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { ClientRow, DifferentRow, MatchCard, MatchedRow } from './MatchCard'
import { MatchFailed, MatchReading, useMatchStage } from './XeroPage'
import { MATCH_FILTER_COPY } from './xeroCopy'
import type { MatchItem } from './MatchCard'
import type { XeroView } from './XeroPage'
import type { MatchFilter, XeroKind } from './xeroCopy'
import type { Id } from '../../../convex/_generated/dataModel'

type Business = { _id: Id<'businesses'>; slug: string; name: string }

/** The lists, in the order their chips sit. */
const FILTERS: Array<MatchFilter> = ['review', 'matched', 'new', 'separate']

/** The Xero page this one is under, which "‹ Xero" goes back to. */
function xeroPath(kind: XeroKind) {
  return kind === 'business'
    ? ('/$businessSlug/settings/xero' as const)
    : ('/$businessSlug/settings/my-xero' as const)
}

/**
 * Settings → Xero → Match your clients (and the same under My Xero): which
 * PestM8 client is which contact in the organisation, as the match run left
 * it, for the holder to check.
 *
 * Read-only towards Xero, like all of Release 2: Same, Different, Unlink
 * and Match again change only PestM8's own note of which contact a client
 * is, which Release 3 acts on when it starts sending.
 */
export function MatchReview({
  kind,
  business,
  filter,
  onFilter,
}: {
  kind: XeroKind
  business: Business
  filter: MatchFilter
  /** Puts the list in the address, replacing the entry. */
  onFilter: (filter: MatchFilter) => void
}) {
  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Match your clients"
        back={
          <BackLink
            to={xeroPath(kind)}
            params={{ businessSlug: business.slug }}
          >
            {kind === 'business' ? 'Xero' : 'My Xero'}
          </BackLink>
        }
      />
      <SettingsBody>
        <MatchSection
          kind={kind}
          business={business}
          filter={filter}
          onFilter={onFilter}
        />
      </SettingsBody>
    </>
  )
}

/**
 * The page's body, without its header: what the UI harness renders.
 *
 * The same doors as the Xero page it is under (`XeroSection`), read from
 * `access.me` first so they never wait on a query: the business's Xero is
 * the owner's, and a member's own is theirs and never the account they are
 * switched into. The server refuses everyone else anyway
 * (`requireConnectionHolder`).
 */
export function MatchSection({
  kind,
  business,
  filter,
  onFilter,
}: {
  kind: XeroKind
  business: Business
  filter: MatchFilter
  onFilter: (filter: MatchFilter) => void
}) {
  const access = useAccess()
  const canManageBusiness = useCan('business.manage')
  const { isSwitched } = useActing()

  if (kind === 'business' && !canManageBusiness) {
    return (
      <EmptyState
        title="Owners only"
        body={
          access.role === 'owner' && isSwitched
            ? 'Only the business owner can match the business’s clients in Xero. Switch back to your own account to open it.'
            : 'Only the business owner can match the business’s clients in Xero.'
        }
      />
    )
  }

  if (kind === 'member' && access.role === 'owner') {
    return (
      <EmptyState
        title="Your Xero is the business’s"
        body="As the owner, you match the business’s clients in its Xero."
        action={
          <Link
            to="/$businessSlug/settings/xero/match"
            params={{ businessSlug: business.slug }}
            className={EMPTY_ACTION_CLASS}
          >
            Match the business’s clients
          </Link>
        }
      />
    )
  }

  if (kind === 'member' && isSwitched) {
    return (
      <EmptyState
        title="Switch back to match your clients"
        body="My Xero is yours, not the account you’re working in. Switch back to your own account to match its clients."
      />
    )
  }

  return (
    <Suspense fallback={<SectionPending />}>
      <MatchConnection
        kind={kind}
        business={business}
        filter={filter}
        onFilter={onFilter}
      />
    </Suspense>
  )
}

function MatchConnection({
  kind,
  business,
  filter,
  onFilter,
}: {
  kind: XeroKind
  business: Business
  filter: MatchFilter
  onFilter: (filter: MatchFilter) => void
}) {
  const { data: status } = useSuspenseQuery(rq.xeroStatus(business._id))

  if (!status.configured) {
    return (
      <EmptyState
        title="Xero isn’t set up here"
        body="This copy of PestM8 isn’t linked to Xero, so there’s nothing to match."
      />
    )
  }
  if (status.demo) {
    return (
      <EmptyState
        title="Not for the demo business"
        body="The demo business’s clients are made up, so it can’t be connected to Xero. Connect Xero from your own business."
      />
    )
  }

  const view = kind === 'business' ? status.business : status.mine
  // Matching only reads what PestM8 already holds, so a connection waiting
  // to be reconnected can still be checked; only reading Xero again needs
  // it working.
  if (
    !view ||
    (view.status !== 'connected' && view.status !== 'needs_reconnect')
  ) {
    return (
      <EmptyState
        title="Xero isn’t connected"
        body="Connect Xero first. PestM8 then reads its contacts and matches them to your clients."
        action={
          <Link
            to={xeroPath(kind)}
            params={{ businessSlug: business.slug }}
            className={EMPTY_ACTION_CLASS}
          >
            {kind === 'business' ? 'Go to Xero' : 'Go to My Xero'}
          </Link>
        }
      />
    )
  }

  return (
    <MatchStageView
      kind={kind}
      business={business}
      view={view}
      paused={status.paused}
      timezone={status.timezone}
      filter={filter}
      onFilter={onFilter}
    />
  )
}

/** The connection's match as the page makes it out (`useMatchStage`). */
function MatchStageView({
  kind,
  business,
  view,
  paused,
  timezone,
  filter,
  onFilter,
}: {
  kind: XeroKind
  business: Business
  view: XeroView
  paused: boolean
  timezone: string
  filter: MatchFilter
  onFilter: (filter: MatchFilter) => void
}) {
  const stage = useMatchStage(view)
  // While a run is reading Xero its proposals are being rewritten, so the
  // lists would shift under the reader: the page waits for it instead.
  if (stage.stage === 'reading') {
    return (
      <SettingsGroup>
        <MatchReading tenantName={view.tenantName} />
      </SettingsGroup>
    )
  }
  if (stage.stage === 'failed') {
    return (
      <SettingsGroup>
        <MatchFailed
          kind={kind}
          businessId={business._id}
          businessSlug={business.slug}
          connection={view}
          problem={stage.problem}
          paused={paused}
        />
      </SettingsGroup>
    )
  }

  return (
    <MatchLists
      businessId={business._id}
      connection={view}
      timezone={timezone}
      filter={filter}
      onFilter={onFilter}
    />
  )
}

/**
 * The match as it stands: when Xero was read, a chip per list with its
 * count, and the chosen list. A list's chip goes when it has nothing in it,
 * unless it is the one being looked at. The counts are the match's, moved
 * with every answer (`xero.status`).
 */
function MatchLists({
  businessId,
  connection,
  timezone,
  filter,
  onFilter,
}: {
  businessId: Id<'businesses'>
  connection: XeroView
  timezone: string
  filter: MatchFilter
  onFilter: (filter: MatchFilter) => void
}) {
  const hydrated = useHydrated()
  const match = connection.match
  // A list read again after it failed starts afresh, as does another list
  // (the key below): what it kept on screen (`MatchList`'s pins) belonged
  // to the old one. A new read of Xero unmounts it on the way, while the
  // page says it is reading.
  const [attempt, setAttempt] = useState(0)
  if (!match || match.state !== 'ready') return null

  // `fresh` counts New to Xero and Different together — both become new
  // contacts — and `different` the Different ones among them.
  const counts: Record<MatchFilter, number> = {
    review: match.review,
    matched: match.linked,
    new: Math.max(0, match.fresh - match.different),
    separate: match.different,
  }
  return (
    <>
      <p className="px-1 text-caption text-ink-2">
        PestM8 compared your clients with the contacts in{' '}
        {connection.tenantName} on {formatWhen(match.at, timezone)}. Nothing is
        sent to Xero yet.
      </p>

      <div role="group" aria-label="Show" className="mt-3 flex flex-wrap gap-2">
        {FILTERS.filter((key) => key === filter || counts[key] > 0).map(
          (key) => {
            const on = key === filter
            const count = counts[key]
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                disabled={!hydrated}
                onClick={() => onFilter(key)}
                // Drawn 36px, tapped at 44 (`tap-target`), as the app's other
                // filter chips.
                className={`relative tap-target inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-caption font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.97] disabled:opacity-60 ${
                  on
                    ? 'border-blue/30 bg-blue/12 text-blue'
                    : 'border-hairline bg-surface text-ink-2'
                }`}
              >
                {MATCH_FILTER_COPY[key].label}
                <span className={`tabular-nums ${on ? '' : 'text-muted'}`}>
                  {count.toLocaleString('en-AU')}
                </span>
              </button>
            )
          },
        )}
      </div>

      <ListBoundary
        key={`${filter}:${attempt}`}
        onRetry={() => setAttempt((n) => n + 1)}
      >
        <MatchList
          businessId={businessId}
          connectionId={connection.connectionId}
          filter={filter}
          total={counts[filter]}
        />
      </ListBoundary>
    </>
  )
}

/** A client kept on screen after it was answered or unlinked, at the place
 * it was in the list when it was. */
type Pin = { item: MatchItem; index: number }

/**
 * The list as shown: the server's rows, with every pinned row that has left
 * them put back where it was. Pinned in the order they were shown, so a run
 * of answered cards keeps its order.
 */
function steady(
  live: ReadonlyArray<MatchItem>,
  pins: ReadonlyMap<string, Pin>,
): Array<MatchItem> {
  const here = new Set<string>(live.map((item) => item.clientId))
  const rows = [...live]
  const gone = [...pins.values()]
    .filter((pin) => !here.has(pin.item.clientId))
    .sort((a, b) => a.index - b.index)
  for (const pin of gone) {
    rows.splice(Math.min(pin.index, rows.length), 0, pin.item)
  }
  return rows
}

/**
 * One list, a hundred at a time.
 *
 * The first page is also asked for as a plain query, which the route's
 * loader warms and the list reads until the paginator has caught up — as
 * the Reports library does, and for the same reason: the paginator's own
 * first page is never reused from the cache.
 *
 * An answered card leaves the server's list at once (it is no longer To
 * check); it is kept on screen here, answered, until the list is left.
 */
function MatchList({
  businessId,
  connectionId,
  filter,
  total,
}: {
  businessId: Id<'businesses'>
  connectionId: Id<'xeroConnections'>
  filter: MatchFilter
  /** How many the list holds, as the match counts it. */
  total: number
}) {
  const hydrated = useHydrated()
  const paged = usePaginatedQuery(
    api.xeroMatch.reviewPage,
    { businessId, connectionId, filter },
    { initialNumItems: MATCH_PAGE },
  )
  const first = useQuery(matchFirstPage(businessId, connectionId, filter))
  const cold = paged.status === 'LoadingFirstPage'
  const live = cold ? first.data?.page : paged.results

  const [pins, setPins] = useState<ReadonlyMap<string, Pin>>(new Map())
  const rows = useMemo(
    () => (live === undefined ? undefined : steady(live, pins)),
    [live, pins],
  )
  // Read at the tap, so `onPin` stays one function for every card.
  const shown = useLatest(rows)
  const onPin = useCallback(
    (item: MatchItem) =>
      setPins((now) => {
        if (now.has(item.clientId)) return now
        const index =
          shown.current?.findIndex((row) => row.clientId === item.clientId) ??
          -1
        return new Map(now).set(item.clientId, {
          item,
          index: index === -1 ? Number.MAX_SAFE_INTEGER : index,
        })
      }),
    [shown],
  )

  // A page can come back empty with more behind it — the review skips a
  // client that has gone since it was matched — and that is not an empty
  // list. Ask for the next page until one row comes, or the list ends.
  useEffect(() => {
    if (paged.results.length === 0 && paged.status === 'CanLoadMore') {
      paged.loadMore(MATCH_PAGE)
    }
  }, [paged])

  const copy = MATCH_FILTER_COPY[filter]
  // Whether an empty list really is empty: its first page has said so, and
  // there is no later page that might still have rows.
  const ended = cold
    ? first.data?.isDone === true
    : paged.status === 'Exhausted'

  if (rows === undefined || (rows.length === 0 && !ended)) {
    if (cold && first.isError) {
      return (
        <LoadFailed
          what="this list"
          onRetry={() => void first.refetch()}
          className="mt-4"
        />
      )
    }
    return <ListPending label="Loading clients" count={3} className="mt-4" />
  }

  if (rows.length === 0) {
    return (
      <div className="mt-4">
        <EmptyState title={copy.emptyTitle} body={copy.emptyBody} />
      </div>
    )
  }

  const left = Math.max(0, total - paged.results.length)
  const more = (
    <>
      {paged.status === 'CanLoadMore' && (
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => paged.loadMore(MATCH_PAGE)}
          className={`${SECONDARY_BUTTON} mt-3 flex w-full items-center justify-center gap-2`}
        >
          {left
            ? `Show ${Math.min(MATCH_PAGE, left).toLocaleString('en-AU')} more`
            : 'Show more'}
          {left ? (
            <span className="font-normal text-muted">
              of {left.toLocaleString('en-AU')}
            </span>
          ) : null}
        </button>
      )}
      {paged.status === 'LoadingMore' && (
        <ListPending label="Loading more clients" count={2} className="mt-3" />
      )}
    </>
  )

  // What the list is, over it — only with something in it: over "Nothing
  // to check" it would ask for what isn't there.
  const lede = <p className="mt-3 px-1 text-caption text-ink-2">{copy.lede}</p>

  if (filter === 'review') {
    return (
      <>
        {lede}
        <ul aria-label={copy.label} className="mt-3 flex flex-col gap-2.5">
          {rows.map((item) => (
            <MatchCard
              key={item.clientId}
              businessId={businessId}
              connectionId={connectionId}
              item={item}
              hydrated={hydrated}
              onPin={onPin}
            />
          ))}
        </ul>
        {more}
      </>
    )
  }

  return (
    <>
      {lede}
      <ul
        aria-label={copy.label}
        className="mt-3 divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation"
      >
        {rows.map((item) =>
          filter === 'matched' ? (
            <MatchedRow
              key={item.clientId}
              businessId={businessId}
              connectionId={connectionId}
              item={item}
              hydrated={hydrated}
              onPin={onPin}
            />
          ) : filter === 'separate' ? (
            <DifferentRow
              key={item.clientId}
              businessId={businessId}
              connectionId={connectionId}
              item={item}
              hydrated={hydrated}
              onPin={onPin}
            />
          ) : (
            <ClientRow key={item.clientId} item={item} />
          ),
        )}
      </ul>
      {more}
    </>
  )
}

/**
 * Catches a list that could not be read — the paginator throws what the
 * server refused, which would otherwise take the whole page to the route's
 * error screen — and offers it again in its place.
 */
class ListBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('The match list failed to load', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <LoadFailed
        what="this list"
        onRetry={this.props.onRetry}
        className="mt-4"
      />
    )
  }
}
