import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'

/** One connection, as `xero.status` gives it (`XeroView` in convex/xero.ts). */
type View = NonNullable<FunctionReturnType<typeof api.xero.status>['business']>

/** How sending stands, as `xero.status` gives it once started. */
type SyncView = NonNullable<View['sync']>

/**
 * How many of the business's clients stand where in one organisation, once
 * it is syncing (`xeroSyncState.counts`, kept by convex/xeroSync.ts):
 *
 * - `inXero`: linked to a contact there — matched, chosen, or added by PestM8;
 * - `review`: waiting on Same or Different, on the match page;
 * - `different`: PestM8 changed a detail Xero holds otherwise, and left
 *   Xero's alone until someone says which wins;
 * - `failed`: refused by Xero (a bad email, a name it won't take);
 * - `stopped`: archived, or removed for privacy, in Xero — never sent again;
 * - `waiting`: changes queued and not yet sent, counted live up to 100.
 */
export type SyncCounts = SyncView['counts']

/** A client Xero refused, newest first, as the Xero page lists them. */
export type SyncProblem = SyncView['recent'][number]

/**
 * Sending to one organisation (Release 3), as the pages read it: from Start
 * syncing on.
 *
 * - `pausedUntil`/`pauseReason`: Xero asked PestM8 to wait (a 429, or Xero
 *   failing), and nothing is sent until then. `minute` is seconds long and
 *   not worth a line; `day` is Xero's daily limit; `server` Xero itself.
 * - `backfill`: while the book is still going in after the start, how many
 *   of the clients it gets are there (`done` of `total`), and — when the
 *   day's allowance ran low — when adding the rest carries on (`heldUntil`;
 *   live changes still go). Null once every client has been looked at.
 * - `recent`: the newest problems that still stand, at most five, one per
 *   client, with the client to open; `problems`: how many still stand, of
 *   the newest twenty kept.
 */
export type SyncSummary = Omit<SyncView, 'counts'> & {
  /** When Start syncing was pressed. */
  startedAt: number
  counts: SyncCounts
}

const NO_COUNTS: SyncCounts = {
  inXero: 0,
  review: 0,
  different: 0,
  failed: 0,
  stopped: 0,
  waiting: 0,
}

/**
 * How sending to a connection stands, or null before Start syncing — the
 * one place the pages read `xero.status`'s sync fields, so a change in how
 * the server shapes them is a change here and nowhere else.
 *
 * Started is the connection's own word (`syncStartedAt`); the rest comes
 * from its sync row, which a connection that has only just started may not
 * have — read as nothing sent, nothing waiting, nothing added yet.
 */
export function syncOf(view: View): SyncSummary | null {
  if (view.syncStartedAt === null) return null
  const sync = view.sync
  return {
    startedAt: view.syncStartedAt,
    counts: sync?.counts ?? NO_COUNTS,
    lastSentAt: sync?.lastSentAt ?? null,
    pausedUntil: sync?.pausedUntil ?? null,
    pauseReason: sync?.pauseReason ?? null,
    backfill: sync ? sync.backfill : { done: 0, total: 0, heldUntil: null },
    recent: sync?.recent ?? [],
    problems: sync?.problems ?? 0,
  }
}
