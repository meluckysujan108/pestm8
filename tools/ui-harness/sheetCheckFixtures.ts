/*
 * The online sheet sends its checks (the matching plan's M7): businesses of
 * their own over the small book (matchFixtures.ts) whose saves the server
 * refuses for what the phone's copy didn't hold yet, as convex/lib/findSame.ts
 * refuses them: until what it found is sent back as dismissed or seen. So
 * no other specimen changes. Dates are from today in Perth, so the rows read
 * the same whenever the shots are taken.
 */

import { ConvexError } from 'convex/values'
import { smallBook } from './matchFixtures'

/** Nadia Hussain, with the mobile typed, added on another phone a moment ago:
 * New Job's booking and Clients → New client are refused MATCHED_CLIENT,
 * with two more named by id. */
export const SHEET_MATCH_BIZ = 'biz_sheet_match'
/** Jane Nguyen's 12 Wattle St, booked tomorrow (#124) by the person and the
 * day after by someone else, since the phone's copy was read: New Job at it
 * is refused SITE_BOOKED. */
export const SHEET_SITE_BIZ = 'biz_sheet_site'

const SHEET_BUSINESSES = new Set([SHEET_MATCH_BIZ, SHEET_SITE_BIZ])

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

const NADIA = 'c_nadia_new'

/** `clients.directory` for the businesses here: the small book, without
 * Nadia Hussain. */
export function resolveSheetCheckBook(fn: string, args: unknown): unknown {
  if (fn !== 'clients:directory') return undefined
  const businessId = (args as { businessId?: string } | undefined)?.businessId
  return businessId !== undefined && SHEET_BUSINESSES.has(businessId)
    ? smallBook()
    : undefined
}

type Saved = {
  businessId?: string
  matchCheck?: { dismissed?: Array<string> }
  siteCheck?: { seen?: Array<{ jobId?: string; at?: number }> }
}

/** What the server says of a save here: refused until what it found is
 * sent back, then made. Undefined for any other business. */
export function sheetCheckMutation(fn: string, args: unknown): unknown {
  const saved = (args ?? {}) as Saved
  if (saved.businessId === undefined) return undefined
  if (!SHEET_BUSINESSES.has(saved.businessId)) return undefined
  const making = fn === 'jobs:create' || fn === 'recurrences:create'
  if (saved.businessId === SHEET_MATCH_BIZ) {
    if (!making && fn !== 'properties:create') return undefined
    if (!(saved.matchCheck?.dismissed ?? []).includes(NADIA)) {
      throw new ConvexError({
        code: 'MATCHED_CLIENT',
        candidates: [
          {
            clientId: NADIA,
            name: 'Nadia Hussain',
            suburb: 'Bayswater',
            evidence: ['name', 'mobile'],
            auto: false,
          },
        ],
        more: ['c_more_1', 'c_more_2'],
      })
    }
    return fn === 'properties:create' ? 'p_nadia_caller' : 'j_new'
  }
  if (!making) return undefined
  const tomorrow = fromToday(1, 10)
  const after = fromToday(2, 14)
  const seen = saved.siteCheck?.seen ?? []
  if (!seen.some((p) => p.jobId === 'j_124')) {
    throw new ConvexError({
      code: 'SITE_BOOKED',
      rows: [
        {
          propertyId: 'p_jane',
          at: tomorrow,
          scheduledAt: tomorrow,
          jobId: 'j_124',
          jobNumber: 124,
        },
        // Someone else's: where and when, and nothing more (C5).
        { propertyId: 'p_jane', at: after, scheduledAt: after },
      ],
    })
  }
  return 'j_new'
}
