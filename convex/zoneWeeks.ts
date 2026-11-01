import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'
import { dayKeyOf, startOfWeekKey, zoneName } from './lib/dates'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

/**
 * The week each business is in, for a query that answers only for that
 * week: `jobs.openWork` answers for its Monday alone, and sends someone
 * else's work only within its twenty weeks, in the business's own days (the
 * owner's answer to C5, 1 Nov 2026: twenty weeks, as the phone holds, and
 * never more).
 *
 * A query never reads the clock (convex/_generated/ai/guidelines.md: it is
 * kept as of whenever it last ran), and `openWork` never reads the
 * business's row, which every booking, visit and numbered report patches.
 * So a business's zone is kept in a row of its own (`businessZones`,
 * written when it is made or its zone changes), and each zone's Monday in
 * another (`zoneWeeks`), which the cron moves on every fifteen minutes and
 * writes only when the Monday changes: what reads it runs again once a
 * week. The cron reads only the zones in use, a handful, however many
 * businesses there are: a zone is kept by the calendar's own name for it,
 * however it was typed, and its week goes when its last business leaves
 * it, so no one business can hold more than one. Every zone in use is a
 * whole quarter-hour from UTC, so a zone's week turns at most two minutes
 * before its row does.
 */

/** At most this many zones are moved on in one run; past it, logged. */
const ZONES_MAX = 1000

/** Businesses `backfill` keeps in one run. */
const PAGE = 100

function mondayIn(timezone: string, now: number): string {
  return startOfWeekKey(dayKeyOf(now, timezone))
}

/**
 * Keeps the business's zone, by the calendar's own name for it, and makes
 * that zone's week if no business was in it yet; the zone it leaves loses
 * its week if no business is left in it. A zone the calendar doesn't know
 * is kept as typed and gets no week, so `openWork` refuses that business
 * until its zone is put right; it is logged rather than thrown, so making
 * or saving the business never fails for it.
 */
export async function keepZone(
  ctx: MutationCtx,
  business: Pick<Doc<'businesses'>, '_id' | 'timezone'>,
  now: number,
): Promise<void> {
  const businessId = business._id
  const named = zoneName(business.timezone)
  const timezone = named ?? business.timezone
  const zone = await ctx.db
    .query('businessZones')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .unique()
  if (zone === null) {
    await ctx.db.insert('businessZones', { businessId, timezone })
  } else if (zone.timezone !== timezone) {
    await ctx.db.patch('businessZones', zone._id, { timezone })
    await leaveZone(ctx, zone.timezone)
  }
  const week = await ctx.db
    .query('zoneWeeks')
    .withIndex('by_timezone', (q) => q.eq('timezone', timezone))
    .unique()
  if (week !== null) return
  if (named === null) {
    // Never the zone itself: it was typed by someone.
    console.warn('zoneWeeks: not a time zone', { businessId })
    return
  }
  await ctx.db.insert('zoneWeeks', {
    timezone,
    monday: mondayIn(timezone, now),
  })
}

/**
 * Drops a zone's week once no business is in it. Call it after the business
 * leaving has had its row moved or deleted. Returns whether one was dropped.
 */
export async function leaveZone(
  ctx: MutationCtx,
  timezone: string,
): Promise<boolean> {
  const still = await ctx.db
    .query('businessZones')
    .withIndex('by_timezone', (q) => q.eq('timezone', timezone))
    .first()
  if (still !== null) return false
  const week = await ctx.db
    .query('zoneWeeks')
    .withIndex('by_timezone', (q) => q.eq('timezone', timezone))
    .unique()
  if (week === null) return false
  await ctx.db.delete('zoneWeeks', week._id)
  return true
}

/** The cron's: moves each zone's Monday on when its week has turned. */
export const advance = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const weeks = await ctx.db.query('zoneWeeks').take(ZONES_MAX + 1)
    if (weeks.length > ZONES_MAX) {
      console.warn('zoneWeeks: zones cut', { limit: ZONES_MAX })
    }
    for (const week of weeks.slice(0, ZONES_MAX)) {
      const monday = mondayIn(week.timezone, now)
      if (week.monday !== monday) {
        await ctx.db.patch('zoneWeeks', week._id, { monday })
      }
    }
  },
})

/**
 * Every business's zone, and its zone's week, a page at a time, the next
 * page in a run of its own: once, after the deploy that made these tables,
 * for the businesses made before it. Since then they are kept as a business
 * is made or its zone changes, so it is safe to run again.
 */
export const backfill = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const now = Date.now()
    const page = await ctx.db
      .query('businesses')
      .paginate({ numItems: PAGE, cursor: cursor ?? null })
    for (const business of page.page) await keepZone(ctx, business, now)
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.zoneWeeks.backfill, {
        cursor: page.continueCursor,
      })
    }
    return { kept: page.page.length, done: page.isDone }
  },
})
