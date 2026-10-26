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
 * How long the page waits for the newest clients on a line that looks up,
 * after its loader's own wait, before it draws every client from memory
 * instead: as long as the job sheet waits for its job (KEPT_JOB_WAIT_MS).
 */
export const KEPT_CLIENTS_WAIT_MS = KEPT_JOB_WAIT_MS

/**
 * Whether the newest clients are on screen, or are with the page as it is
 * drawn now: their first page is in memory, and so are the filter row's
 * choices above them (`clients.overview`). The list waits for those, so the
 * row never lands above cards already there; with the line down they won't
 * come, and it doesn't.
 */
export function newestDrawn(at: {
  firstPageInMemory: boolean
  overviewInMemory: boolean
  lineDown: boolean
}): boolean {
  return at.firstPageInMemory && (at.overviewInMemory || at.lineDown)
}

/**
 * Whether the page reads every client from the client list instead of the
 * newest a page at a time. Asked again on each render (`useKeptMode`) until
 * it says yes or the page has drawn the newest clients, and never after, so
 * a list on screen never changes source under a thumb:
 * - with the line down, yes: the client list is what the phone keeps. With
 *   the newest clients' first page in memory, though, only once the phone's
 *   copy has been read and has the list: a guess made while it is still
 *   being read could put "Could not load" where those clients could have
 *   been. With neither, the list's own "Could not load" says so, rather
 *   than a placeholder waiting for good.
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
  /** The newest clients' first page is in memory. */
  firstPageInMemory: boolean
  /** The client list has an answer in memory. */
  directoryInMemory: boolean
  /** The newest clients have been waited for KEPT_CLIENTS_WAIT_MS on
   * screen, and still aren't drawn. */
  late: boolean
}): boolean {
  if (at.lineDown) {
    return !at.firstPageInMemory || (at.copyRead && at.directoryReadable)
  }
  return at.late && at.directoryInMemory
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
