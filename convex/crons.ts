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
 * The same thirty days for a retired report DRAFT. A finalised report is
 * never deleted and never purged — the business is required to keep it — so
 * this only ever reaches work in progress.
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

export default crons
