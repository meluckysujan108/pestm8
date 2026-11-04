/*
 * What is booked at each site (`jobs.openWork`) for New Job's check at Book
 * (the matching plan's M5): businesses of their own over the small book
 * (matchFixtures.ts), so no other specimen changes. Every other business
 * has nothing booked anywhere, except the one whose answer never comes, for
 * the row saying the check couldn't be made. Dates are from today in
 * Perth, so the rows read the same whenever the shots are taken.
 */

import { smallBook } from './matchFixtures'

/** Jane Nguyen's 12 Wattle St booked tomorrow (#123), a Recurring Job at
 * 3/12 Ocean Pde, a visit of Tom Lee's monthly one at 7 Rose Ave in two
 * days, Lisa Tran's last visit, and someone else's job at 1 King William
 * St. */
export const SITE_BIZ = 'biz_site'
/** 12 Wattle St booked tomorrow by someone else: a date and nothing more. */
export const SITE_OTHER_BIZ = 'biz_site_other'
/** Nothing of it on the phone: the answer never comes. */
export const SITE_UNCHECKED_BIZ = 'biz_site_unchecked'
/** Ray White Bayswater's 3/12 Ocean Pde, Cottesloe, booked tomorrow
 * (#123): typed as a new client's in Peppermint Grove, the same postcode,
 * it is on the same street and no match row names it, so the site's own
 * row carries Book at and Open #123. */
export const SITE_STREET_BIZ = 'biz_site_street'

const SITE_BUSINESSES = new Set([
  SITE_BIZ,
  SITE_OTHER_BIZ,
  SITE_UNCHECKED_BIZ,
  SITE_STREET_BIZ,
])

const TZ = 'Australia/Perth'
const DAY = 86_400_000

/** `days` from today at `hour`:00 in Perth (UTC+8 all year). */
function fromToday(days: number, hour: number): number {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(
    new Date(),
  )
  return (
    Date.parse(`${key}T${String(hour).padStart(2, '0')}:00:00+08:00`) +
    days * DAY
  )
}

/** One of the person's own: with its number, services, status and lead. */
function theirs(
  jobId: string,
  propertyId: string,
  at: number,
  extra: Record<string, unknown> = {},
) {
  return {
    propertyId,
    at,
    scheduledAt: at,
    status: 'booked',
    jobId,
    jobType: 'General Pest Control',
    assignedMembershipId: 'm_sam',
    ...extra,
  }
}

/** Someone else's: where and when, and nothing more (C5). */
function others(propertyId: string, at: number) {
  return { propertyId, at, scheduledAt: at }
}

function siteWork() {
  const ocean = fromToday(40, 9)
  const rose = fromToday(2, 8)
  return {
    rows: [
      theirs('j_123', 'p_jane', fromToday(1, 10), { jobNumber: 123 }),
      theirs('j_ocean', 'p_rw2', ocean, {
        jobNumber: 131,
        recurrenceId: 'r_ocean',
      }),
      theirs('j_rose', 'p_tomlee', rose, {
        jobNumber: 140,
        status: 'recurring',
        recurrenceId: 'r_rose',
      }),
      theirs('j_lisa', 'p_lisa', fromToday(-12, 9), {
        jobNumber: 98,
        status: 'completed',
      }),
      others('p_rw1', fromToday(3, 14)),
    ],
    series: [
      {
        _id: 'r_ocean',
        propertyId: 'p_rw2',
        nextAt: ocean,
        intervalCount: 3,
        intervalUnit: 'month',
        jobType: 'General Pest Control',
      },
      {
        _id: 'r_rose',
        propertyId: 'p_tomlee',
        nextAt: rose,
        intervalCount: 1,
        intervalUnit: 'month',
        jobType: 'General Pest Control',
      },
    ],
  }
}

/** `clients.directory` for the businesses here: the small book. */
export function resolveSiteBook(fn: string, args: unknown): unknown {
  if (fn !== 'clients:directory') return undefined
  const businessId = (args as { businessId?: string } | undefined)?.businessId
  return businessId !== undefined && SITE_BUSINESSES.has(businessId)
    ? smallBook()
    : undefined
}

/** `jobs.openWork`: the work above, or none; undefined (never answered)
 * for the business with nothing on the phone. */
export function openWorkFixture(args: unknown): unknown {
  const businessId = (args as { businessId?: string } | undefined)?.businessId
  if (businessId === SITE_UNCHECKED_BIZ) return undefined
  if (businessId === SITE_BIZ) return siteWork()
  if (businessId === SITE_OTHER_BIZ) {
    return { rows: [others('p_jane', fromToday(1, 10))], series: [] }
  }
  if (businessId === SITE_STREET_BIZ) {
    return {
      rows: [theirs('j_123', 'p_rw2', fromToday(1, 10), { jobNumber: 123 })],
      series: [],
    }
  }
  // The small book's own specimens book where nothing is.
  return { rows: [], series: [] }
}
