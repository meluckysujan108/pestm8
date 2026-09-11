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

export default crons
