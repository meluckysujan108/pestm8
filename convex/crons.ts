import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

/**
 * Keeps the next 180 days of recurring work on the calendar. Runs in the small
 * hours so a tech opening the app in the morning sees a settled schedule, and
 * is idempotent so a retry never double-books a property.
 */
crons.daily(
  'materialise recurrences',
  { hourUTC: 18, minuteUTC: 0 }, // ~02:00 Australia/Perth
  internal.recurrences.materialiseAll,
)

/**
 * Recently Deleted keeps a note for 30 days, like the phone's Notes app, then
 * it is gone for good — including its mentions, photos and sync history.
 */
crons.cron(
  'purge deleted notes',
  '0 19 * * *', // ~03:00 Australia/Perth
  internal.notes.purgeExpired,
  {},
)

/**
 * The same thirty days for a report in Recently Deleted: a draft, or — since
 * 30 Sept 2026 — a finalised report the owner deleted, with every version of
 * its number (reports.softDelete). Named for drafts because that was all it
 * reached when it was written.
 *
 * Twenty minutes after the notes purge, so two self-rescheduling batch jobs
 * are not competing for the same scheduler slot.
 */
crons.cron(
  'purge deleted report drafts',
  '20 19 * * *', // ~03:20 Australia/Perth
  internal.reports.purgeExpired,
  {},
)

/**
 * The Recycle bin keeps a deleted client, property, job or Recurring Job for
 * the same thirty days, then wipes it and everything that went with it
 * (convex/bin.ts). A finalised report never goes into the bin.
 *
 * Twenty minutes after the drafts purge, for the same reason.
 */
crons.cron(
  'wipe expired recycle bin entries',
  '40 19 * * *', // ~03:40 Australia/Perth
  internal.bin.purgeExpired,
  {},
)

/**
 * Ends switches that have run past their twelve hours, for readers.
 *
 * Hourly rather than daily because this is what a read sees: writes enforce the
 * expiry themselves and refuse, but a query deliberately does not read the
 * clock (it would make every gated query uncacheable), so the row's removal is
 * what ends a switch on screen.
 */
crons.cron(
  'sweep expired account switches',
  '0 * * * *',
  internal.accountSwitches.sweepExpired,
  {},
)

/**
 * Forgets the owner's chosen view on devices that have signed out. Its own job,
 * not a step in the switch sweep above, so a failure in one cannot stop the
 * other; and hygiene only, since a dead session's view is never read.
 */
crons.cron(
  'sweep views of ended sign-ins',
  '30 * * * *',
  internal.views.sweepEnded,
  {},
)

/**
 * Keeps idle Xero sign-ins alive (convex/xeroTokens.ts `keepAlive`). A Xero
 * refresh token dies after 60 days unused, and a connection nobody has
 * touched in that time would otherwise need its holder to sign in to Xero
 * again for no reason of theirs. Refreshes any not refreshed for 30 days.
 */
crons.cron(
  'refresh idle Xero sign-ins',
  '0 20 * * *', // ~04:00 Australia/Perth
  internal.xeroTokens.keepAlive,
  {},
)

/**
 * Tidies Connect Xero attempts that stopped half-way (convex/xero.ts
 * `sweep`): forgets their spent states, and retires connections nobody
 * finished, taking PestM8 back out of Xero for them — Xero counts an
 * organisation chosen at its sign-in against the app until it is removed.
 */
crons.cron(
  'sweep Xero sign-ins left half-way',
  '50 * * * *',
  internal.xero.sweep,
  {},
)

/**
 * Restarts Xero sends that should be running and are not
 * (convex/xeroSync.ts `reconcile`): a drain killed by a deploy, a pause or
 * the day's allowance run out, changes made while the kill switch was on or
 * a reconnect was needed, a walk of the book not finished. Every change asks
 * for its own drain within seconds; this is the net under that, so nothing
 * queued waits more than ten minutes for a working organisation.
 *
 * Off the hour's other Xero jobs (`:50`, and the keep-alive's `:00`).
 */
crons.cron(
  'send waiting Xero changes',
  '5,15,25,35,45,55 * * * *',
  internal.xeroSync.reconcile,
  {},
)

/**
 * Forgets phones' connection notes after thirty days (convex/diagnostics.ts).
 * Ten minutes after the Xero keep-alive, away from the other nightly jobs.
 */
crons.cron(
  'forget old connection notes',
  '10 20 * * *', // ~04:10 Australia/Perth
  internal.diagnostics.prune,
  {},
)

/**
 * Moves the server's day on (convex/serverDay.ts) for the queries that may
 * answer only near today and never read the clock: `jobs.openWork`. Hourly,
 * so the day is at most an hour behind; it writes only when the day has
 * changed.
 */
crons.cron(
  'move the server day on',
  '2 * * * *',
  internal.serverDay.advance,
  {},
)

export default crons
