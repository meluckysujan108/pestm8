import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { usePaginatedQuery } from 'convex/react'
import { isUnauthenticatedError } from './signInSettling'
import { isMfaEnrolmentError } from './twoStep'
import type { UseQueryOptions } from '@tanstack/react-query'
import type {
  PaginatedQueryArgs,
  PaginatedQueryItem,
  PaginatedQueryReference,
  PaginationStatus,
} from 'convex/react'

/**
 * A list the server pages, drawn from its first page the moment it is asked
 * for and grown a page at a time as the end comes near.
 *
 * Two copies of page one, on purpose — the same pair Reports and Notes run
 * by hand (ReportsLibrary.tsx, NoteList.tsx). `first` is the page as a plain
 * query: a loader warms it, the server renders it into the HTML, and a second
 * visit finds it in the cache. The paginator is Convex's own, mounted at
 * once alongside it with the same arguments; it mints a new pagination id on
 * every mount and keeps nothing between visits, so on its own every visit
 * would wait on its first page again (src/lib/routeQueries.ts has the rest).
 * The page shows the warmed copy until the paginator has caught up, then the
 * paginator's, which is the one that grows.
 *
 * Mounted eagerly rather than when more is asked for, because a paginator
 * mounted late loses the one path by which a list that cannot load says so:
 * nothing throws, the list waits on its placeholder for good, and a refused
 * session never reaches SignInSettling. Page one runs twice on the server for
 * it, as it already does for Reports and Notes.
 *
 * `args: 'skip'` unmounts the paginator, and is how a list that must not page
 * — the Job tab for someone who sees only their own work — leaves it alone.
 * Not a way to pause one: a skip throws its pages away, and coming back
 * starts from page one.
 */

/** How many empty pages in a row a list asks past on its own. */
export const MAX_EMPTY_PAGES = 4

type Page<T> = { page: ReadonlyArray<T>; isDone: boolean }

export type PagedListInput<T> = {
  /** The paginator is skipped: the caller is drawing something else. */
  skipped: boolean
  status: PaginationStatus
  /** The paginator's rows. */
  results: ReadonlyArray<T>
  /** The warmed first page, once it has answered. */
  warmed: Page<T> | undefined
  /** The warmed page's error, when it failed with nothing to show. */
  warmedError: unknown
  pageSize: number
  /** Empty pages asked past in a row, for this list. */
  chased: number
  /** More was asked for before the paginator had its first page. */
  wantMore: boolean
}

export type PagedListView<T> = {
  rows: Array<T>
  /** Showing the paginator's rows rather than the warmed copy. */
  fromPaginator: boolean
  loading: boolean
  done: boolean
  empty: boolean
  canLoadMore: boolean
  loadingMore: boolean
  /** Ask for the next page now: the last one came back empty. */
  chase: boolean
  error: unknown
  /** A refusal to throw to the route, where the app knows what to do with it. */
  rethrow: unknown
}

/**
 * What a paged list draws, from where its two copies of page one have got
 * to. Pure, for the tests: the hook below is this plus the subscriptions.
 */
export function pagedListView<T>(input: PagedListInput<T>): PagedListView<T> {
  const { skipped, status, results, warmed, warmedError, pageSize } = input
  if (skipped) {
    // Nothing to say about a list nobody is drawing — in particular not that
    // it is empty, which a caller might take for its cue to say "No jobs yet".
    return {
      rows: [],
      fromPaginator: false,
      loading: false,
      done: false,
      empty: false,
      canLoadMore: false,
      loadingMore: false,
      chase: false,
      error: null,
      rethrow: null,
    }
  }

  /**
   * The hand-over. The paginator's rows once it has said whether there is
   * more, or has a page's worth: "a page's worth" is the page size, not the
   * warmed copy's length, because a copy cached minutes ago may have grown by
   * a row or two and would otherwise hold the swap off for good. Until then
   * the warmed copy — including while a first page too big for one read is
   * being split, when the paginator reports LoadingMore with no rows at all.
   * A paginator already showing rows keeps showing them while it loads more,
   * however few: a narrow list's pages can hold fewer than `pageSize`, and
   * swapping back to page one there would shrink the list mid-load.
   */
  const fromPaginator =
    status === 'CanLoadMore' ||
    status === 'Exhausted' ||
    results.length >= pageSize ||
    (status === 'LoadingMore' && results.length > 0)
  const rows = withoutDuplicates(fromPaginator ? results : (warmed?.page ?? []))

  const failed = !fromPaginator && warmed === undefined && warmedError != null
  const refused =
    failed &&
    (isUnauthenticatedError(warmedError) || isMfaEnrolmentError(warmedError))

  const done = fromPaginator
    ? status === 'Exhausted'
    : (warmed?.isDone ?? false)

  /**
   * Visibility is applied after a page is read on the server (a person who
   * sees only some clients, a business whose newest rows are all recurring
   * projections), so a page can come back empty with more behind it. Asked
   * past a few at a time, then left to the list's own Show more — a list
   * that kept asking could ask through a whole book on its own, and one that
   * stopped and said "Loading" would say it for good.
   */
  const gaveUp = input.chased >= MAX_EMPTY_PAGES
  const chase =
    fromPaginator && status === 'CanLoadMore' && results.length === 0 && !gaveUp

  const loadingMore =
    !failed &&
    (input.wantMore ||
      (status === 'LoadingMore' &&
        (fromPaginator || gaveUp) &&
        (rows.length > 0 || gaveUp)))

  const canLoadMore =
    !failed &&
    !loadingMore &&
    (fromPaginator
      ? status === 'CanLoadMore'
      : // Before the paginator answers, the warmed page knows whether there
        // is more — which the server rendered, so the button is in the HTML
        // and does not appear under a thumb on hydration. A tap then waits
        // for the paginator (`wantMore`) rather than being lost.
        warmed !== undefined && !warmed.isDone && rows.length > 0)

  return {
    rows,
    fromPaginator,
    loading: !failed && rows.length === 0 && !done && !gaveUp,
    done,
    empty: !failed && done && rows.length === 0,
    canLoadMore,
    loadingMore,
    chase,
    error: failed && !refused ? warmedError : null,
    rethrow: refused ? warmedError : null,
  }
}

/**
 * A row's id: its own `_id`, or the first record it carries — the Clients
 * page's rows are `{ client, properties }`, with the id on the client.
 */
function idOf(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return undefined
  if ('_id' in row) return row._id
  for (const value of Object.values(row)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      '_id' in value
    ) {
      return value._id
    }
  }
  return undefined
}

/**
 * Convex's pages are contiguous and a split replaces its page whole, so the
 * same row should never be on two pages. Dropped anyway if it ever is: two
 * cards with one key is a React warning and a card that will not update.
 */
export function withoutDuplicates<T>(rows: ReadonlyArray<T>): Array<T> {
  const seen = new Set<unknown>()
  const out: Array<T> = []
  for (const row of rows) {
    const id = idOf(row)
    if (id !== undefined) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    out.push(row)
  }
  return out
}

export type PagedList<T> = {
  rows: Array<T>
  /** Nothing to show yet: draw `ListPending`, never `EmptyState`. */
  loading: boolean
  /** The whole list is here. */
  done: boolean
  /** Done, with nothing in it: the only time for `EmptyState` or `NoMatches`. */
  empty: boolean
  canLoadMore: boolean
  loadingMore: boolean
  /** Stable. Does nothing unless there is more to load. */
  loadMore: () => void
  /** The warmed page failed with nothing to show (`LoadFailed`); else null. */
  error: unknown
  retry: () => void
}

export function usePagedList<TQuery extends PaginatedQueryReference>(opts: {
  query: TQuery
  args: PaginatedQueryArgs<TQuery> | 'skip'
  /** The warmed first page, from routeQueries, or `convexQuery(fn, 'skip')`. */
  first: { queryKey: ReadonlyArray<unknown> } & object
  pageSize: number
}): PagedList<PaginatedQueryItem<TQuery>> {
  type Item = PaginatedQueryItem<TQuery>
  const { query, args, pageSize } = opts
  const skipped = args === 'skip'

  const paged = usePaginatedQuery(query, args, { initialNumItems: pageSize })
  const first = useQuery(
    // Skipped whatever the caller passed: a live first page under a skipped
    // paginator would be a subscription nobody draws.
    (skipped
      ? convexQuery(query as PaginatedQueryReference, 'skip')
      : opts.first) as UseQueryOptions<
      Page<Item>,
      Error,
      Page<Item>,
      ReadonlyArray<unknown>
    >,
  )

  /**
   * What this list has done on its own — empty pages asked past, a tap
   * waiting on the paginator — kept per list, and forgotten the moment the
   * arguments change: decided while rendering, so a new status or a new
   * account never starts with the last list's count.
   */
  const key = skipped ? 'skip' : JSON.stringify(args)
  const [held, setHeld] = useState({ key, chased: 0, wantMore: false })
  const own = held.key === key ? held : { key, chased: 0, wantMore: false }
  if (own !== held) setHeld(own)

  const { status, results, loadMore: pageMore } = paged
  const warmedError =
    first.isError && first.data === undefined ? first.error : null
  const view = useMemo(
    () =>
      pagedListView<Item>({
        skipped,
        status,
        results,
        warmed: first.data,
        warmedError,
        pageSize,
        chased: own.chased,
        wantMore: own.wantMore,
      }),
    [
      skipped,
      status,
      results,
      first.data,
      warmedError,
      pageSize,
      own.chased,
      own.wantMore,
    ],
  )

  // Unauthenticated and MFA_ENROLMENT_REQUIRED have their own screens, which
  // the route's error component shows (src/router.tsx): SignInSettling holds
  // and retries, TwoStepNeeded says how to set it up. A list that kept them
  // to itself would show "Could not load" for a session that is only
  // between two tokens.
  if (view.rethrow) throw view.rethrow

  /**
   * The empty-page chase, and a tap made before the paginator had answered.
   * Each `loadMore` from the paginator belongs to one answer of it, so one
   * remembered here is never used twice: an effect run again for the same
   * answer (React's development double run, a re-render with nothing new)
   * asks for nothing more.
   */
  const asked = useRef<unknown>(null)
  const { chase } = view
  const wanted = own.wantMore && view.fromPaginator
  useEffect(() => {
    if (!chase && !wanted) return
    if (status !== 'CanLoadMore' || asked.current === pageMore) return
    asked.current = pageMore
    pageMore(pageSize)
    setHeld((prev) =>
      prev.key === key
        ? {
            key,
            chased: chase ? prev.chased + 1 : prev.chased,
            wantMore: false,
          }
        : prev,
    )
  }, [chase, wanted, status, pageMore, pageSize, key])

  // A tap that was waiting on a list that turned out to have no more.
  const settled = own.wantMore && view.fromPaginator && status === 'Exhausted'
  useEffect(() => {
    if (!settled) return
    setHeld((prev) => (prev.key === key ? { ...prev, wantMore: false } : prev))
  }, [settled, key])

  // Stable, so LoadMore's effects do not re-run on every answer; it reads
  // where the list has got to when it is called.
  const latest = useRef({ view, status, pageMore, pageSize, key })
  latest.current = { view, status, pageMore, pageSize, key }
  const loadMore = useCallback(() => {
    const now = latest.current
    if (!now.view.canLoadMore) return
    if (now.view.fromPaginator) {
      if (now.status === 'CanLoadMore') now.pageMore(now.pageSize)
      return
    }
    setHeld((prev) =>
      prev.key === now.key ? { ...prev, wantMore: true } : prev,
    )
  }, [])

  const { refetch } = first
  const retry = useCallback(() => {
    void refetch()
  }, [refetch])

  return {
    rows: view.rows,
    loading: view.loading,
    done: view.done,
    empty: view.empty,
    canLoadMore: view.canLoadMore,
    loadingMore: view.loadingMore,
    loadMore,
    error: view.error,
    retry,
  }
}
