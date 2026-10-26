import { clientRows } from '#/lib/directory'
import { KEPT_JOB_WAIT_MS } from './keptJob'
import type { Directory } from '#/lib/directory'

/**
 * The Clients page with the line down, pure so its rules can be tested
 * without a page ($businessSlug/clients/index.tsx).
 *
 * As it opens, the page reads the newest clients a page at a time from the
 * server (`clients.page`), and its count and filters from the server too
 * (`clients.overview`). Neither is kept on the phone, and with the line down
 * neither answers. The client list the phone does keep (`clients.directory`,
 * the one New Job picks from) is every client, which the page already reads
 * for a search, A–Z or a filter. So with the line down it reads that from
 * the start, and counts and filters what it holds.
 */

/**
 * How long the page waits for the newest clients on a line that looks up
 * before it draws every client from memory instead, counted from the tap
 * that asked for the page, its loader's own wait included: as long as the
 * job sheet waits for its job (KEPT_JOB_WAIT_MS).
 */
export const KEPT_CLIENTS_WAIT_MS = KEPT_JOB_WAIT_MS

/** The newest clients' first page, as `clients.page` answers it. */
export type FirstPage = { page: ReadonlyArray<unknown>; isDone: boolean }

/**
 * Whether the newest clients' first page has something to show: a client,
 * or word that there are none. One that came back empty with more behind it
 * (a person who sees only some clients) shows only the list's placeholder
 * while later pages are asked for, which with the line down never come.
 */
export function firstPageShows(firstPage: FirstPage | undefined): boolean {
  return (
    firstPage !== undefined && (firstPage.page.length > 0 || firstPage.isDone)
  )
}

/**
 * Whether the newest clients are on screen, or are with the page as it is
 * drawn now: their cards have been drawn (`rowsDrawn`), which stays so; or
 * their first page has something to show (`firstPageShows`), and the filter
 * row's choices above them are in memory too (`clients.overview`). The list
 * waits for those, so the row never lands above cards already there; with
 * the line down they won't come, and it doesn't.
 */
export function newestDrawn(at: {
  firstPage: FirstPage | undefined
  /** The list has drawn the newest clients as cards on this page. */
  rowsDrawn: boolean
  overviewInMemory: boolean
  lineDown: boolean
}): boolean {
  if (at.rowsDrawn) return true
  return firstPageShows(at.firstPage) && (at.overviewInMemory || at.lineDown)
}

/**
 * Whether the page reads every client from the client list instead of the
 * newest a page at a time. Asked again on each render (`useKeptMode`) until
 * it says yes or the page has drawn the newest clients, and never after, so
 * a list on screen never changes source under a thumb:
 * - with the line down, yes: the client list is what the phone keeps. With
 *   the newest clients' first page in memory with something to show
 *   (`firstPageShows`), though, only once the phone's copy has been read
 *   and has the list: a guess made while it is still being read could put
 *   "Could not load" where those clients could have been. With neither, the
 *   list's own "Could not load" says so, rather than a placeholder waiting
 *   for good.
 * - on a line that looks up, only when the newest clients still haven't
 *   come after the wait (KEPT_CLIENTS_WAIT_MS) and the client list is in
 *   memory (New Job's, which the business layout asks for): drawn then,
 *   rather than a placeholder for as long as PestM8 doesn't answer.
 */
export function keptClientsMode(at: {
  lineDown: boolean
  /** The client list can be shown (`keeper.readable`). */
  directoryReadable: boolean
  /** The phone's copy has been read this page load (`keeper.copyRead`). */
  copyRead: boolean
  /** The newest clients' first page has something to show
   * (`firstPageShows`). */
  firstPageShows: boolean
  /** The client list has an answer in memory. */
  directoryInMemory: boolean
  /** The newest clients have been waited for KEPT_CLIENTS_WAIT_MS since
   * the page was asked for, and still aren't drawn. */
  late: boolean
}): boolean {
  if (at.lineDown) {
    return !at.firstPageShows || (at.copyRead && at.directoryReadable)
  }
  return at.late && at.directoryInMemory
}

/**
 * How long the page's loader holds the tap that opened it for what it asks
 * for (`waitMs`, `loaderWaitMs`): not at all with the line down, when
 * nothing answers but the phone's copy, which does at once. With every
 * client on the phone to draw without PestM8 (`everyClientOnPhone`), the
 * page draws them once the newest clients are KEPT_CLIENTS_WAIT_MS late
 * from the tap, so it holds the tap no longer than that, and not at all on
 * a line PestM8 hasn't spoken on lately (`keeper.lineLive`: a socket that
 * opened and never answered, or has gone quiet), where a wait would only
 * hold the old page up meanwhile. Otherwise, for as long as it waits.
 */
export function loaderHoldMs(at: {
  lineDown: boolean
  lineLive: boolean
  /** Every client is in memory, or in the phone's copy (`keeper.onPhone`). */
  everyClientOnPhone: boolean
  waitMs: number
}): number {
  if (at.lineDown) return 0
  if (!at.everyClientOnPhone) return at.waitMs
  return at.lineLive ? Math.min(at.waitMs, KEPT_CLIENTS_WAIT_MS) : 0
}

/**
 * How soon after its loader settles a page counts as opened by that run of
 * it: the router draws the page the moment its loader is done
 * (`defaultPendingMinMs: 0`), and this leaves room for a slow frame.
 */
export const OPENED_BY_LOADER_MS = 1_000

/**
 * When the page's opening wait for the newest clients began
 * (`useLateSince`): the tap that asked for it, so the time its loader held
 * that tap counts, if that run of the loader is what opened the page
 * (`settledAt` just now). Otherwise now: a page the router kept from an
 * earlier visit, or preloaded under a pointer a while ago, opens at once on
 * that run's answer while a new run goes on behind it, and its tap was long
 * ago. Now, too, for a page the server drew (no `askedAt`).
 */
export function openingWaitSince(
  loaded: { askedAt: number | null; settledAt: number | null },
  now: number,
): number {
  if (loaded.askedAt === null || loaded.settledAt === null) return now
  return now - loaded.settledAt <= OPENED_BY_LOADER_MS ? loaded.askedAt : now
}

/**
 * Whether the end of the newest clients says when more show
 * (`moreClientsWithSignal`) in place of Show more and the next page's
 * bones: with the line down, while there is more to ask for or a page asked
 * for hasn't come. The paginator is asked for nothing then, by a tap or by
 * the end coming near: a page asked for would never come, and its bones
 * would wait for good.
 */
export function moreWaitsForSignal(at: {
  /** The list is the newest clients, a page at a time. */
  newest: boolean
  lineDown: boolean
  canLoadMore: boolean
  loadingMore: boolean
}): boolean {
  return at.newest && at.lineDown && (at.canLoadMore || at.loadingMore)
}

/**
 * What the end of the newest clients says with the line down, in place of
 * Show more (`moreWaitsForSignal`). Every client is still found by a search
 * where the phone has them (`everyClientReadable`), and the words say so.
 */
export function moreClientsWithSignal(everyClientReadable: boolean): string {
  return everyClientReadable
    ? 'More clients show when you have signal — search finds every client on this phone.'
    : 'More clients show when you have signal.'
}

/**
 * What the page draws around its list, from what it knows as it renders,
 * so the route's choices can be tested without the route:
 * - `noMatches`: NoMatches in the list's place, a search or filter over
 *   every client that found nothing (its hint: `noMatchesHint`).
 * - `bones`: the next page's bones in the cards' grid, while a page of the
 *   newest clients comes; never with the line down (`moreWaitsForSignal`).
 * - `end`: under the list, Show more (`LoadMore`), or with the line down
 *   the words saying when more show (`moreClientsWithSignal`); nothing
 *   while the list is still to come or could not load, as its placeholder
 *   or LoadFailed says so.
 * - `note`: the "Updated" note (`useKeptNote`) goes for good (`empty`) once
 *   the list the page comes back to could not load: every client's, in kept
 *   mode, which every view reads, or the newest clients'. A search, A–Z or
 *   filter over the newest that could not load only leaves it out while it
 *   says so (`hidden`): cleared, the newest clients come back, still the
 *   copy the note is about.
 */
export function clientsListView(at: {
  /** The page reads every client from the phone's copy (`keptMode`). */
  keptMode: boolean
  /** A search, A–Z or a filter is asked for, which reads every client. */
  wantsEveryClient: boolean
  searching: boolean
  filtersActive: boolean
  lineDown: boolean
  /** The list the page reads could not load (LoadFailed). */
  failed: boolean
  /** The list the page reads is still to come (its placeholder). */
  loading: boolean
  /** The list the page reads has been read to its end, and has nothing. */
  empty: boolean
  /** The newest clients' paginator. */
  paged: { canLoadMore: boolean; loadingMore: boolean }
}): {
  noMatches: boolean
  bones: boolean
  end: 'load-more' | 'more-with-signal' | null
  note: { empty: boolean; hidden: boolean }
} {
  const newest = !at.keptMode && !at.wantsEveryClient
  const moreWaits = moreWaitsForSignal({
    newest,
    lineDown: at.lineDown,
    canLoadMore: at.paged.canLoadMore,
    loadingMore: at.paged.loadingMore,
  })
  return {
    noMatches:
      !at.failed &&
      !at.loading &&
      at.empty &&
      (at.searching || at.filtersActive),
    bones: newest && at.paged.loadingMore && !moreWaits,
    end:
      at.failed || at.loading
        ? null
        : moreWaits
          ? 'more-with-signal'
          : 'load-more',
    note: {
      empty: at.failed && (at.keptMode || !at.wantsEveryClient),
      hidden: at.failed,
    },
  }
}

/**
 * `NoMatches`' hint over every client: with the list as the phone last had
 * it (`behind`: `useBehindOnce`), a client added since, on this phone or
 * another, isn't in it, and the hint says when they show.
 */
export function noMatchesHint(behind: boolean): string {
  return behind
    ? 'Try a different name, address or filter. Newer clients show when you have signal.'
    : 'Try a different name, address or filter.'
}

/**
 * How many clients the page lists, counted from every client as
 * `clients.overview` counts them (none archived), and whether the list was
 * cut short.
 */
export function directoryCount(directory: Directory): {
  total: number
  capped: boolean
} {
  return { total: clientRows(directory).length, capped: directory.capped }
}

/** The header's count: "12 clients", "1 client", "500+ clients". */
export function clientCountLabel(count: {
  total: number
  capped: boolean
}): string {
  const one = count.total === 1 && !count.capped
  return `${count.total}${count.capped ? '+' : ''} ${one ? 'client' : 'clients'}`
}
