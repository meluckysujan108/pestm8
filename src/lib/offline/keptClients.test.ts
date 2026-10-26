import { describe, expect, test } from 'vitest'
import {
  KEPT_CLIENTS_WAIT_MS,
  OPENED_BY_LOADER_MS,
  clientCountLabel,
  clientsListView,
  directoryCount,
  firstPageShows,
  keptClientsMode,
  loaderHoldMs,
  moreClientsWithSignal,
  moreWaitsForSignal,
  newestDrawn,
  noMatchesHint,
  openingWaitSince,
} from './keptClients'
import type { Directory } from '#/lib/directory'

/**
 * The Clients page with the line down: every client from the phone's copy,
 * counted from what it holds, unless the newest clients' first page is in
 * memory and the copy isn't known to be; and on a line that looks up, every
 * client from memory once the newest are late.
 */

const DOWN = {
  lineDown: true,
  directoryReadable: true,
  copyRead: true,
  firstPageShows: false,
  directoryInMemory: false,
  late: false,
}
const UP = { ...DOWN, lineDown: false }

describe('when the page reads every client from the phone', () => {
  test('with the line down', () => {
    expect(keptClientsMode(DOWN)).toBe(true)
    expect(keptClientsMode({ ...DOWN, firstPageShows: true })).toBe(true)
  })

  test('not on a line that looks up, while the newest clients may still come', () => {
    expect(keptClientsMode(UP)).toBe(false)
    expect(keptClientsMode({ ...UP, directoryInMemory: true })).toBe(false)
  })

  test('on a line that looks up, once the newest are late and every client is in memory', () => {
    expect(
      keptClientsMode({ ...UP, late: true, directoryInMemory: true }),
    ).toBe(true)
    // Not for a list that would only be waited for in their place.
    expect(keptClientsMode({ ...UP, late: true })).toBe(false)
  })

  test('not when the first page is in memory and the copy isn’t: the page stays as it was', () => {
    expect(
      keptClientsMode({
        ...DOWN,
        firstPageShows: true,
        directoryReadable: false,
      }),
    ).toBe(false)
  })

  test('not on a guess, with the first page in memory and the phone’s copy still being read', () => {
    expect(
      keptClientsMode({ ...DOWN, firstPageShows: true, copyRead: false }),
    ).toBe(false)
  })

  test('with neither, the list says it could not load rather than waiting for good', () => {
    expect(keptClientsMode({ ...DOWN, directoryReadable: false })).toBe(true)
    expect(
      keptClientsMode({ ...DOWN, directoryReadable: false, copyRead: false }),
    ).toBe(true)
  })
})

const PAGE = { page: [{ _id: 'c1' }], isDone: false }
const NONE_YET = { page: [], isDone: false }
const NEWEST = {
  firstPage: PAGE,
  rowsDrawn: false,
  overviewInMemory: true,
  lineDown: false,
}

describe('whether the newest clients are on screen', () => {
  test('once their first page and the filter row’s choices are both in memory', () => {
    expect(newestDrawn(NEWEST)).toBe(true)
    // The choices still to come: the cards wait, so the row never lands
    // above them.
    expect(newestDrawn({ ...NEWEST, overviewInMemory: false })).toBe(false)
    expect(newestDrawn({ ...NEWEST, firstPage: undefined })).toBe(false)
  })

  test('with the line down, without the choices, which won’t come', () => {
    expect(
      newestDrawn({ ...NEWEST, overviewInMemory: false, lineDown: true }),
    ).toBe(true)
  })

  test('not from a first page that came back empty with more behind it: the list shows only its placeholder', () => {
    expect(newestDrawn({ ...NEWEST, firstPage: NONE_YET })).toBe(false)
    expect(
      newestDrawn({ ...NEWEST, firstPage: NONE_YET, lineDown: true }),
    ).toBe(false)
    // One that says there are none is the list's empty state.
    expect(
      newestDrawn({ ...NEWEST, firstPage: { page: [], isDone: true } }),
    ).toBe(true)
  })

  test('for good once cards have been drawn, whatever the first page says since', () => {
    expect(
      newestDrawn({
        firstPage: NONE_YET,
        rowsDrawn: true,
        overviewInMemory: false,
        lineDown: false,
      }),
    ).toBe(true)
  })

  test('so that, offline, an empty first page gives way to every client on the phone', () => {
    expect(firstPageShows(NONE_YET)).toBe(false)
    expect(firstPageShows(undefined)).toBe(false)
    expect(firstPageShows(PAGE)).toBe(true)
    expect(
      keptClientsMode({
        ...DOWN,
        firstPageShows: firstPageShows(NONE_YET),
        copyRead: false,
      }),
    ).toBe(true)
  })
})

describe('how long the loader holds the tap that opened the page', () => {
  const AT = {
    lineDown: false,
    lineLive: true,
    everyClientOnPhone: false,
    waitMs: 8_000,
  }

  test('on a working line with nothing else to draw, for as long as it waits for anything', () => {
    expect(loaderHoldMs(AT)).toBe(8_000)
    expect(loaderHoldMs({ ...AT, lineLive: false })).toBe(8_000)
  })

  test('never with the line down', () => {
    expect(loaderHoldMs({ ...AT, lineDown: true, lineLive: false })).toBe(0)
    expect(
      loaderHoldMs({ ...AT, lineDown: true, everyClientOnPhone: true }),
    ).toBe(0)
  })

  test('with every client on the phone, no longer than the page waits for the newest before drawing them', () => {
    const onPhone = { ...AT, everyClientOnPhone: true }
    expect(loaderHoldMs(onPhone)).toBe(KEPT_CLIENTS_WAIT_MS)
    // A line the phone says is gone waits for nothing.
    expect(loaderHoldMs({ ...onPhone, waitMs: 0 })).toBe(0)
    // And not at all on a line PestM8 hasn't spoken on lately.
    expect(loaderHoldMs({ ...onPhone, lineLive: false })).toBe(0)
  })
})

describe('when the page’s first wait for the newest clients began', () => {
  const TAP = Date.UTC(2026, 9, 25, 1)

  test('the tap, when the loader run that held it is what opened the page', () => {
    // Held 3 s, then drawn at once.
    expect(
      openingWaitSince({ askedAt: TAP, settledAt: TAP + 3_000 }, TAP + 3_050),
    ).toBe(TAP)
  })

  test('now, for a page opened on an earlier run’s answer, so its wait isn’t over at once', () => {
    // The router kept the page from a visit five minutes ago, and runs the
    // loader again behind it.
    const now = TAP + 5 * 60_000
    expect(openingWaitSince({ askedAt: TAP, settledAt: TAP + 300 }, now)).toBe(
      now,
    )
    // A preload under a pointer a while before the tap.
    expect(
      openingWaitSince(
        { askedAt: TAP, settledAt: TAP + 200 },
        TAP + 200 + OPENED_BY_LOADER_MS + 1,
      ),
    ).toBe(TAP + 200 + OPENED_BY_LOADER_MS + 1)
  })

  test('now, for a page the server drew', () => {
    expect(openingWaitSince({ askedAt: null, settledAt: null }, TAP)).toBe(TAP)
  })
})

describe('what the page draws around its list', () => {
  /** The newest clients, read a page at a time, on a working line. */
  const PAGED = {
    keptMode: false,
    wantsEveryClient: false,
    searching: false,
    filtersActive: false,
    lineDown: false,
    failed: false,
    loading: false,
    empty: false,
    paged: { canLoadMore: true, loadingMore: false },
  }
  const KEPT = { ...PAGED, keptMode: true, lineDown: true }
  const SEARCH = { ...PAGED, wantsEveryClient: true, searching: true }

  test('the newest clients: Show more, and bones in the grid while a page comes', () => {
    expect(clientsListView(PAGED)).toMatchObject({
      bones: false,
      end: 'load-more',
    })
    expect(
      clientsListView({
        ...PAGED,
        paged: { canLoadMore: true, loadingMore: true },
      }),
    ).toMatchObject({ bones: true, end: 'load-more' })
  })

  test('with the line down, the newest clients say when more show, with no bones waiting for good', () => {
    const down = { ...PAGED, lineDown: true }
    expect(clientsListView(down)).toMatchObject({
      bones: false,
      end: 'more-with-signal',
    })
    expect(
      clientsListView({
        ...down,
        paged: { canLoadMore: false, loadingMore: true },
      }),
    ).toMatchObject({ bones: false, end: 'more-with-signal' })
    // At the list's end, as ever.
    expect(
      clientsListView({
        ...down,
        paged: { canLoadMore: false, loadingMore: false },
      }).end,
    ).toBe('load-more')
  })

  test('every client, from the phone or for a search: Show more over what is here, never bones', () => {
    for (const at of [KEPT, SEARCH, { ...SEARCH, lineDown: true }]) {
      expect(
        clientsListView({
          ...at,
          paged: { canLoadMore: true, loadingMore: true },
        }),
      ).toMatchObject({ bones: false, end: 'load-more' })
    }
  })

  test('nothing under a list still to come or that could not load', () => {
    expect(clientsListView({ ...PAGED, loading: true }).end).toBeNull()
    expect(clientsListView({ ...KEPT, failed: true }).end).toBeNull()
  })

  test('NoMatches for a search or filter that found nothing; an empty book is not one', () => {
    expect(clientsListView({ ...SEARCH, empty: true }).noMatches).toBe(true)
    expect(
      clientsListView({
        ...KEPT,
        searching: false,
        filtersActive: true,
        empty: true,
      }).noMatches,
    ).toBe(true)
    expect(clientsListView({ ...KEPT, empty: true }).noMatches).toBe(false)
    expect(clientsListView({ ...SEARCH, empty: false }).noMatches).toBe(false)
    expect(
      clientsListView({ ...SEARCH, empty: true, failed: true }).noMatches,
    ).toBe(false)
  })

  test('the note goes for good once the list the page comes back to could not load', () => {
    // Every client, in kept mode, which every view reads.
    expect(clientsListView({ ...KEPT, failed: true }).note).toEqual({
      empty: true,
      hidden: true,
    })
    expect(
      clientsListView({ ...KEPT, searching: true, failed: true }).note,
    ).toEqual({ empty: true, hidden: true })
    // The newest clients themselves.
    expect(clientsListView({ ...PAGED, failed: true }).note).toEqual({
      empty: true,
      hidden: true,
    })
  })

  test('a search over the newest clients that could not load only leaves the note out while it says so', () => {
    expect(clientsListView({ ...SEARCH, failed: true }).note).toEqual({
      empty: false,
      hidden: true,
    })
    // Cleared: the newest clients, and the note, are back.
    expect(clientsListView(PAGED).note).toEqual({
      empty: false,
      hidden: false,
    })
  })
})

describe('what the page says in Show more’s place with the line down', () => {
  const AT = {
    newest: true,
    lineDown: true,
    canLoadMore: true,
    loadingMore: false,
  }

  test('the newest clients ask for no more with the line down, nor wait on a page asked for', () => {
    expect(moreWaitsForSignal(AT)).toBe(true)
    expect(
      moreWaitsForSignal({ ...AT, canLoadMore: false, loadingMore: true }),
    ).toBe(true)
  })

  test('Show more as ever with the line up, at the list’s end, or over every client, which is all here', () => {
    expect(moreWaitsForSignal({ ...AT, lineDown: false })).toBe(false)
    expect(moreWaitsForSignal({ ...AT, canLoadMore: false })).toBe(false)
    expect(moreWaitsForSignal({ ...AT, newest: false })).toBe(false)
  })

  test('when more show, and that a search finds every client the phone has', () => {
    expect(moreClientsWithSignal(true)).toBe(
      'More clients show when you have signal — search finds every client on this phone.',
    )
    // Not where a search would find nothing to look through.
    expect(moreClientsWithSignal(false)).toBe(
      'More clients show when you have signal.',
    )
  })
})

describe('NoMatches’ hint over every client', () => {
  test('says newer clients show with signal while the list may be behind, and not otherwise', () => {
    expect(noMatchesHint(true)).toBe(
      'Try a different name, address or filter. Newer clients show when you have signal.',
    )
    expect(noMatchesHint(false)).toBe(
      'Try a different name, address or filter.',
    )
  })
})

function directory(
  clients: Array<{ id: string; archived?: boolean }>,
  capped = false,
): Directory {
  return {
    clients: clients.map((c) => ({
      _id: c.id,
      _creationTime: 1,
      name: c.id,
      kind: 'person',
      createdAt: 1,
      ...(c.archived ? { archivedAt: 2 } : {}),
    })),
    sites: [],
    capped,
  } as unknown as Directory
}

describe('the count', () => {
  test('every client the page lists, as the server counts them: none archived', () => {
    expect(
      directoryCount(
        directory([{ id: 'a' }, { id: 'b', archived: true }, { id: 'c' }]),
      ),
    ).toEqual({ total: 2, capped: false })
    expect(directoryCount(directory([{ id: 'a' }], true))).toEqual({
      total: 1,
      capped: true,
    })
  })

  test('digits with their noun, and a + when the list was cut short', () => {
    expect(clientCountLabel({ total: 0, capped: false })).toBe('0 clients')
    expect(clientCountLabel({ total: 1, capped: false })).toBe('1 client')
    expect(clientCountLabel({ total: 12, capped: false })).toBe('12 clients')
    expect(clientCountLabel({ total: 1, capped: true })).toBe('1+ clients')
    expect(clientCountLabel({ total: 500, capped: true })).toBe('500+ clients')
  })
})
