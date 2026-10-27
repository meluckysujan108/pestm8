import type { Directory, DirectoryClient, DirectorySite } from '#/lib/directory'
import type { LineDown } from './keeper'

/**
 * The client sheet with no answer from PestM8 (ClientSheet.tsx): when it
 * shows the client as the client list has them instead (`KeptClientView`),
 * and what it says about the rest. Pure, so the rules can be tested without
 * a sheet. The same rules as the job sheet's (keptJob.ts).
 *
 * The sheet reads `clients.get`, which is never kept. The client list the
 * phone does keep (`clients.directory`, the one New Job and the Clients
 * page read) has a row for every client this person sees, with their sites:
 * what a technician needs at the door. So with no answer the sheet shows
 * that, read-only.
 */

/** A client as the phone's client list has them, with their sites. */
export type KeptClient = {
  client: DirectoryClient
  sites: Array<DirectorySite>
}

/**
 * The client `clientId` in the client list, with their sites, oldest first
 * as the list has them: null when the list doesn't have them.
 */
export function findKeptClient(
  directory: Directory,
  clientId: string,
): KeptClient | null {
  const client = directory.clients.find((each) => each._id === clientId)
  if (!client) return null
  return {
    client,
    sites: directory.sites.filter((site) => site.clientId === clientId),
  }
}

/**
 * What the sheet shows while `clients.get` has no answer and no refusal:
 * - `waiting`: its own placeholder. The line is up and the wait isn't over
 *   (the job sheet's, KEPT_JOB_WAIT_MS); or the client list is live, so
 *   PestM8 is answering on this line and the client is on their way; or a
 *   late answer on a line that looks up with nothing else to show, which is
 *   ConnectionNotice's to say; or the client list is still on its way from
 *   the phone's copy.
 * - `kept`: the client as the client list has them. Once shown, kept up
 *   while the answer is still to come, even with the line back, so the
 *   placeholder never comes back over a client already on screen.
 * - `not-kept`: with the line down, that the client isn't on this phone:
 *   the list is here without them, or there is no list to show.
 *
 * Nothing is said to be missing while the phone's copy is still being
 * read: the list counts as one that can be shown until then
 * (`keeper.readable`).
 */
export type KeptClientState = 'waiting' | 'kept' | 'not-kept'

export function keptClientState(at: {
  /** Why the line is down, or null while it is up (`useLineDown`). */
  down: LineDown | null
  /** The wait is over (KEPT_JOB_WAIT_MS), or the line has been down since
   * the sheet opened. */
  waitedOut: boolean
  /** The sheet has already shown the client from the list. */
  shown: boolean
  /** The client list has them. */
  found: boolean
  /** The client list is live: pushed on this connection, which is still
   * talking. */
  live: boolean
  /** The client list is in memory, from PestM8 or the phone's copy. */
  listed: boolean
  /** The client list can be shown (`keeper.readable`). */
  listReadable: boolean
}): KeptClientState {
  if (at.shown && at.found) return 'kept'
  if (at.down === null) {
    return at.waitedOut && at.found && !at.live ? 'kept' : 'waiting'
  }
  if (at.found) return 'kept'
  return at.listed || !at.listReadable ? 'not-kept' : 'waiting'
}

/**
 * The client's email, for the Email the live sheet has beside Call and
 * Text: the client list's own (`clients.directory` carries it since 28 Oct
 * 2026). A copy kept before then, or one for someone not sent emails, has
 * none, and then a day's row for a visit to one of their sites may
 * (`jobs.listDay`'s `clientEmail`, read off the same client), in memory or
 * in the phone's copy (`keeper.findDayRowWhere`). Undefined where neither
 * has it, or they have no email.
 */
export function keptClientEmail(
  kept: {
    client: { email?: string }
    sites: ReadonlyArray<{ _id: string }>
  },
  findRow: (
    match: (row: { propertyId: string }) => boolean,
  ) => { row: { clientEmail: string } } | null,
): string | undefined {
  if (kept.client.email) return kept.client.email
  if (kept.sites.length === 0) return undefined
  const ids = new Set(kept.sites.map((site) => site._id))
  return findRow((row) => ids.has(row.propertyId))?.row.clientEmail || undefined
}

/** A connection that Xero lines come from (`xeroSync.clientLines`). */
const LIVE_XERO = new Set(['connected', 'needs_reconnect'])

/**
 * Whether the live sheet would have a Xero row, as far as memory shows:
 * an answer of `xeroSync.clientLines` for this business with lines in it,
 * or `xero.status` with a connection those lines come from. Most businesses
 * have no Xero, and the live sheet then has no Xero row at all, so the
 * kept one says Xero opens with signal only where it will.
 */
export function xeroKnown(at: {
  /** Every `xeroSync.clientLines` answer in memory for this business. */
  lines: ReadonlyArray<unknown>
  /** `xero.status`'s answer for this business, when it is in memory. */
  status:
    | {
        configured: boolean
        business: { status: string } | null
        mine: { status: string } | null
      }
    | undefined
}): boolean {
  if (at.lines.some((each) => Array.isArray(each) && each.length > 0)) {
    return true
  }
  const status = at.status
  if (!status?.configured) return false
  return [status.business, status.mine].some(
    (each) => each !== null && LIVE_XERO.has(each.status),
  )
}

/** Where the sheet's jobs, notes, contacts and Xero would be, with no
 * answer from PestM8: none of them is kept on the phone. */
export const OPENS_WITH_SIGNAL = 'Opens when you have signal.'

/** Said in the sheet's place with the line down, when the phone's client
 * list doesn't have the client. */
export const NOT_KEPT_CLIENT =
  'This client isn’t on this phone. It opens when you have signal.'
