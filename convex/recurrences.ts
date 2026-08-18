import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import { frequency } from './schema'
import type { MutationCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'

/** How far ahead occurrences are created. Long enough to plan a quarter. */
const HORIZON_DAYS = 180

const MONTHS_BY_FREQUENCY = {
  monthly: 1,
  quarterly: 3,
  sixMonthly: 6,
  yearly: 12,
} as const

/**
 * Occurrence instants from the anchor forward. Uses calendar months rather
 * than fixed day counts: a quarterly service booked on the 15th should stay on
 * the 15th, not drift by two days every year.
 */
function occurrencesFrom(
  anchorDate: number,
  freq: Doc<'recurrences'>['frequency'],
  untilMs: number,
): Array<number> {
  const step = MONTHS_BY_FREQUENCY[freq]
  const anchor = new Date(anchorDate)
  const out: Array<number> = []

  for (let i = 0; i < 200; i++) {
    const d = new Date(anchor.getTime())
    d.setMonth(d.getMonth() + step * i)
    // Clamp to the last valid day: the 31st does not exist in every month, and
    // Date would otherwise roll a 31 Jan quarterly into 3 May.
    if (d.getDate() !== anchor.getDate()) d.setDate(0)

    const ts = d.getTime()
    if (ts > untilMs) break
    out.push(ts)
  }
  return out
}

export const listForBusiness = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)

    const recurrences = await ctx.db
      .query('recurrences')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    return Promise.all(
      recurrences.map(async (r) => {
        const property = await ctx.db.get(r.propertyId)
        return {
          ...r,
          clientName: property?.clientName ?? '',
          suburb: property?.suburb ?? '',
        }
      }),
    )
  },
})

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    propertyId: v.id('properties'),
    assignedMembershipId: v.id('memberships'),
    frequency,
    jobType: v.string(),
    price: v.number(),
    anchorDate: v.number(),
    durationMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.businessId)

    // Same rule as jobs.create: only an owner books someone else's calendar.
    if (
      membership.role !== 'owner' &&
      args.assignedMembershipId !== membership._id
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    const property = await ctx.db.get(args.propertyId)
    if (!property || property.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    const recurrenceId = await ctx.db.insert('recurrences', {
      businessId: args.businessId,
      propertyId: args.propertyId,
      assignedMembershipId: args.assignedMembershipId,
      frequency: args.frequency,
      jobType: args.jobType,
      price: args.price,
      anchorDate: args.anchorDate,
      active: true,
    })

    await materialiseOne(ctx, recurrenceId, args.durationMinutes)
    return recurrenceId
  },
})

export const setActive = mutation({
  args: {
    businessId: v.id('businesses'),
    recurrenceId: v.id('recurrences'),
    active: v.boolean(),
  },
  handler: async (ctx, { businessId, recurrenceId, active }) => {
    const membership = await requireMembership(ctx, businessId)

    const recurrence = await ctx.db.get(recurrenceId)
    if (!recurrence || recurrence.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (
      membership.role !== 'owner' &&
      recurrence.assignedMembershipId !== membership._id
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    await ctx.db.patch(recurrenceId, { active })

    // Stopping a recurrence removes work not yet done; anything already
    // completed or invoiced is history and stays untouched.
    if (!active) {
      const jobs = await ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect()

      const now = Date.now()
      for (const job of jobs) {
        if (job.status === 'booked' && job.scheduledAt > now) {
          await ctx.db.delete(job._id)
        }
      }
    }
  },
})

/**
 * Creates any missing occurrences inside the horizon. Idempotent by design —
 * the cron runs daily and must never double-book a property.
 */
async function materialiseOne(
  ctx: MutationCtx,
  recurrenceId: Id<'recurrences'>,
  durationMinutes = 60,
): Promise<number> {
  const recurrence = await ctx.db.get(recurrenceId)
  if (!recurrence || !recurrence.active) return 0

  const existing = await ctx.db
    .query('jobs')
    .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
    .collect()

  const taken = new Set(existing.map((j) => j.scheduledAt))
  const until = Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000

  let created = 0
  for (const scheduledAt of occurrencesFrom(
    recurrence.anchorDate,
    recurrence.frequency,
    until,
  )) {
    if (taken.has(scheduledAt)) continue

    // Never backfill: a missed visit is not something to invent after the fact.
    if (scheduledAt < Date.now() - 24 * 60 * 60 * 1000) continue

    await ctx.db.insert('jobs', {
      businessId: recurrence.businessId,
      propertyId: recurrence.propertyId,
      assignedMembershipId: recurrence.assignedMembershipId,
      jobType: recurrence.jobType,
      price: recurrence.price,
      scheduledAt,
      durationMinutes,
      status: 'booked',
      recurrenceId,
      createdAt: Date.now(),
    })
    created++
  }

  return created
}

/** Called by the daily cron; not exposed to clients. */
export const materialiseAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const recurrences = await ctx.db.query('recurrences').collect()

    let created = 0
    for (const recurrence of recurrences) {
      if (!recurrence.active) continue
      created += await materialiseOne(ctx, recurrence._id)
    }
    return { created }
  },
})

/** Exposed for tests and for a manual "generate now" action. */
export const materialise = mutation({
  args: { businessId: v.id('businesses'), recurrenceId: v.id('recurrences') },
  handler: async (ctx, { businessId, recurrenceId }) => {
    await requireMembership(ctx, businessId)

    const recurrence = await ctx.db.get(recurrenceId)
    if (!recurrence || recurrence.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    return materialiseOne(ctx, recurrenceId)
  },
})
