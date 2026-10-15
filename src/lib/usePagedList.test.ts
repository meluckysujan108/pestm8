import { describe, expect, it } from 'vitest'
import {
  MAX_EMPTY_PAGES,
  pagedListView,
  withoutDuplicates,
} from './usePagedList'
import type { PagedListInput } from './usePagedList'

/**
 * What a paged list draws from where its two copies of page one have got to:
 * the warmed plain query (in the HTML, and in the cache on a second visit)
 * and Convex's paginator (the one that grows). The hook is this decision plus
 * its subscriptions, and the decision is where the traps are.
 */

type Row = { _id: string }
const rows = (from: number, count: number): Array<Row> =>
  Array.from({ length: count }, (_, i) => ({ _id: `j${from + i}` }))

const PAGE = 24

function input(over: Partial<PagedListInput<Row>> = {}): PagedListInput<Row> {
  return {
    skipped: false,
    status: 'LoadingFirstPage',
    results: [],
    warmed: undefined,
    warmedError: null,
    pageSize: PAGE,
    chased: 0,
    wantMore: false,
    ...over,
  }
}

describe('before anything has answered', () => {
  it('is loading, and never empty', () => {
    const view = pagedListView(input())
    expect(view).toMatchObject({
      rows: [],
      loading: true,
      done: false,
      empty: false,
      canLoadMore: false,
      loadingMore: false,
    })
  })
})

describe('the warmed first page (the server render, and hydration)', () => {
  it('draws the warmed rows while the paginator has not answered', () => {
    const page = rows(0, PAGE)
    const view = pagedListView(input({ warmed: { page, isDone: false } }))
    expect(view.rows).toEqual(page)
    expect(view.fromPaginator).toBe(false)
    expect(view.loading).toBe(false)
    expect(view.done).toBe(false)
  })

  it('offers more from the warmed page, so the button is in the HTML', () => {
    const view = pagedListView(
      input({ warmed: { page: rows(0, PAGE), isDone: false } }),
    )
    expect(view.canLoadMore).toBe(true)
    expect(view.loadingMore).toBe(false)
  })

  it('is done, and offers nothing more, when the warmed page is the lot', () => {
    const view = pagedListView(
      input({ warmed: { page: rows(0, 5), isDone: true } }),
    )
    expect(view).toMatchObject({ done: true, empty: false, canLoadMore: false })
  })

  it('is empty only when the warmed page is empty AND done', () => {
    expect(
      pagedListView(input({ warmed: { page: [], isDone: true } })),
    ).toMatchObject({ empty: true, loading: false })
    // Visibility is applied after paging: an empty page with more behind it
    // is still loading, not "No jobs yet".
    expect(
      pagedListView(input({ warmed: { page: [], isDone: false } })),
    ).toMatchObject({ empty: false, loading: true, canLoadMore: false })
  })

  it('shows a tap made before the paginator answered as loading more', () => {
    const view = pagedListView(
      input({ warmed: { page: rows(0, PAGE), isDone: false }, wantMore: true }),
    )
    expect(view.loadingMore).toBe(true)
    expect(view.canLoadMore).toBe(false)
  })
})

describe('the hand-over to the paginator', () => {
  it('swaps once the paginator says there is more', () => {
    const fresh = rows(100, PAGE)
    const view = pagedListView(
      input({
        status: 'CanLoadMore',
        results: fresh,
        warmed: { page: rows(0, PAGE), isDone: false },
      }),
    )
    expect(view.rows).toEqual(fresh)
    expect(view.fromPaginator).toBe(true)
    expect(view.canLoadMore).toBe(true)
  })

  it('swaps once it is exhausted, however few rows', () => {
    const view = pagedListView(
      input({
        status: 'Exhausted',
        results: rows(0, 3),
        warmed: { page: rows(0, 3), isDone: true },
      }),
    )
    expect(view).toMatchObject({ fromPaginator: true, done: true })
    expect(view.rows).toHaveLength(3)
  })

  it('is not held off by a warmed copy that has grown since it was cached', () => {
    // A copy cached minutes ago holds 26 rows; the paginator's first page
    // holds the page size. The page size is the bar, not the copy's length.
    const view = pagedListView(
      input({
        status: 'LoadingMore',
        results: rows(0, PAGE),
        warmed: { page: rows(0, PAGE + 2), isDone: false },
      }),
    )
    expect(view.fromPaginator).toBe(true)
    expect(view.rows).toHaveLength(PAGE)
  })

  it('keeps the warmed rows while a first page too big to read is split', () => {
    // SplitRequired on page one: Convex reports LoadingMore with no rows.
    const page = rows(0, PAGE)
    const view = pagedListView(
      input({
        status: 'LoadingMore',
        results: [],
        warmed: { page, isDone: false },
      }),
    )
    expect(view.rows).toEqual(page)
    expect(view.fromPaginator).toBe(false)
    // Not "loading more": nobody asked for more, and the announcement would
    // say so.
    expect(view.loadingMore).toBe(false)
    expect(view.loading).toBe(false)
  })

  it('keeps a narrow list’s few rows while it loads more, rather than shrinking to page one', () => {
    const view = pagedListView(
      input({
        status: 'LoadingMore',
        results: rows(0, 5),
        warmed: { page: rows(0, 2), isDone: false },
      }),
    )
    expect(view.rows).toHaveLength(5)
    expect(view.loadingMore).toBe(true)
    expect(view.canLoadMore).toBe(false)
  })
})

describe('loading more', () => {
  it('says so while a page is coming, and offers nothing more till it lands', () => {
    const view = pagedListView(
      input({ status: 'LoadingMore', results: rows(0, 48) }),
    )
    expect(view).toMatchObject({
      loading: false,
      loadingMore: true,
      canLoadMore: false,
      done: false,
    })
  })
})

describe('empty pages with more behind them', () => {
  it('asks past an empty page, still loading', () => {
    const view = pagedListView(input({ status: 'CanLoadMore', results: [] }))
    expect(view).toMatchObject({ chase: true, loading: true, empty: false })
    // Not two placeholders: the list's own is showing.
    expect(view.loadingMore).toBe(false)
  })

  it('stops asking after a few, and leaves Show more rather than a placeholder for good', () => {
    const view = pagedListView(
      input({ status: 'CanLoadMore', results: [], chased: MAX_EMPTY_PAGES }),
    )
    expect(view).toMatchObject({
      chase: false,
      loading: false,
      empty: false,
      done: false,
      canLoadMore: true,
    })
  })

  it('shows a tap past that point as loading more, not as the list loading', () => {
    const view = pagedListView(
      input({ status: 'LoadingMore', results: [], chased: MAX_EMPTY_PAGES }),
    )
    expect(view).toMatchObject({ loading: false, loadingMore: true })
  })

  it('does not ask past a page that has rows', () => {
    const view = pagedListView(
      input({ status: 'CanLoadMore', results: rows(0, 3) }),
    )
    expect(view.chase).toBe(false)
  })

  it('is empty when the pages run out with nothing in them', () => {
    const view = pagedListView(
      input({ status: 'Exhausted', results: [], chased: 2 }),
    )
    expect(view).toMatchObject({ empty: true, done: true, loading: false })
  })
})

describe('a warmed page that failed', () => {
  it('is an error to show where the list was, with nothing else to show', () => {
    const error = new Error('offline')
    const view = pagedListView(input({ warmedError: error }))
    expect(view).toMatchObject({
      error,
      rethrow: null,
      loading: false,
      empty: false,
      canLoadMore: false,
    })
  })

  it('is thrown to the route when the session was refused', () => {
    const unauthenticated = Object.assign(new Error('x'), {
      data: 'Unauthenticated',
    })
    const view = pagedListView(input({ warmedError: unauthenticated }))
    expect(view.rethrow).toBe(unauthenticated)
    expect(view.error).toBeNull()
  })

  it('is thrown to the route when two-step sign-in is needed', () => {
    const mfa = Object.assign(new Error('x'), {
      data: 'MFA_ENROLMENT_REQUIRED',
    })
    expect(pagedListView(input({ warmedError: mfa })).rethrow).toBe(mfa)
  })

  it('is forgotten once the paginator has the list', () => {
    const view = pagedListView(
      input({
        status: 'CanLoadMore',
        results: rows(0, PAGE),
        warmedError: new Error('offline'),
      }),
    )
    expect(view.error).toBeNull()
    expect(view.rows).toHaveLength(PAGE)
  })
})

describe('a skipped list', () => {
  it('claims nothing — least of all that it is empty', () => {
    const view = pagedListView(
      input({
        skipped: true,
        warmed: { page: [], isDone: true },
        status: 'LoadingFirstPage',
      }),
    )
    expect(view).toMatchObject({
      rows: [],
      loading: false,
      done: false,
      empty: false,
      canLoadMore: false,
      loadingMore: false,
      chase: false,
    })
  })
})

describe('withoutDuplicates', () => {
  it('drops a row seen on an earlier page', () => {
    const a = { _id: 'a' }
    const b = { _id: 'b' }
    expect(withoutDuplicates([a, b, { _id: 'a' }])).toEqual([a, b])
  })

  it('reads the id off the record a row carries (the Clients page’s rows)', () => {
    const row = (id: string, name: string) => ({
      client: { _id: id, name },
      properties: [{ _id: `p-${id}` }],
    })
    expect(
      withoutDuplicates([row('c1', 'Ann'), row('c2', 'Bo'), row('c1', 'Ann')]),
    ).toEqual([row('c1', 'Ann'), row('c2', 'Bo')])
  })

  it('keeps rows it cannot identify', () => {
    expect(withoutDuplicates([{ n: 1 }, { n: 1 }])).toHaveLength(2)
  })
})
