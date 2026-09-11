import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { canEditJob, requireMembership } from './lib/access'
import { allocateJobNumber } from './jobs'
import { clientNameOf, newClientFields, resolvePropertyId } from './properties'
import { frequency } from './schema'
import type { MutationCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import type { Membership } from './lib/access'

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
          clientName: await clientNameOf(ctx, property),
          suburb: property?.suburb ?? '',
        }
      }),
    )
  },
})

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    // Either an existing property, or the fields to create a brand-new
    // client + property in the same transaction — mirrors jobs.create.
    propertyId: v.optional(v.id('properties')),
    newClient: v.optional(newClientFields),
    assignedMembershipId: v.id('memberships'),
    frequency,
    jobType: v.string(),
    price: v.number(),
    anchorDate: v.number(),
    durationMinutes: v.number(),
  },
  handler: async (ctx, { propertyId: existingPropertyId, newClient, ...args }) => {
    const membership = await requireMembership(ctx, args.businessId)

    // Same rule as jobs.create: only an owner books someone else's calendar.
    if (
      membership.role !== 'owner' &&
      args.assignedMembershipId !== membership._id
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    const propertyId = await resolvePropertyId(ctx, args.businessId, {
      propertyId: existingPropertyId,
      newClient,
    })

    const recurrenceId = await ctx.db.insert('recurrences', {
      businessId: args.businessId,
      propertyId,
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
      jobNumber: await allocateJobNumber(ctx, recurrence.businessId),
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

/**
 * Same shape as `jobs.ts`'s own private `requireEditableJob` (kept as its own
 * copy rather than exported, the same way `reports.ts` keeps its own
 * `requireEditableReport`) — resolve membership, load the job, confirm
 * tenancy, and require owner-or-assignee before either mutation below may
 * touch a job's recurring status.
 */
async function requireEditableJob(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  jobId: Id<'jobs'>,
): Promise<{ membership: Membership; job: Doc<'jobs'> }> {
  const membership = await requireMembership(ctx, businessId)

  const job = await ctx.db.get(jobId)
  if (!job || job.businessId !== businessId) throw new ConvexError('NOT_FOUND')
  if (!canEditJob(membership, job)) throw new ConvexError('NO_ACCESS')

  return { membership, job }
}

/**
 * Turns an existing one-off job into the first booking of a new recurring
 * series, anchored on the job's own current scheduledAt/details — the same
 * template shape `create` already uses when booking a repeating job fresh.
 * The job is patched onto the new recurrence in place rather than replaced,
 * so its notes/photos/reports/job number all stay attached to the same _id.
 */
export const convertJobToRecurring = mutation({
  args: {
    businessId: v.id('businesses'),
    jobId: v.id('jobs'),
    frequency,
  },
  handler: async (ctx, { businessId, jobId, frequency: freq }) => {
    const { job } = await requireEditableJob(ctx, businessId, jobId)

    if (job.recurrenceId) {
      const existing = await ctx.db.get(job.recurrenceId)
      if (existing?.active) throw new ConvexError('ALREADY_RECURRING')
    }

    const recurrenceId = await ctx.db.insert('recurrences', {
      businessId,
      propertyId: job.propertyId,
      assignedMembershipId: job.assignedMembershipId,
      frequency: freq,
      jobType: job.jobType,
      price: job.price,
      anchorDate: job.scheduledAt,
      active: true,
    })

    // Attach the EXISTING job to the new series before materialising —
    // materialiseOne's own idempotency check then finds this job already
    // occupying the anchor instant and skips generating a duplicate for it.
    await ctx.db.patch(jobId, { recurrenceId })

    await materialiseOne(ctx, recurrenceId, job.durationMinutes)

    return recurrenceId
  },
})

/**
 * Stops a recurring series from one specific job's context, guaranteeing
 * that exact job survives as a standalone one-off even though it may itself
 * be a future `booked` visit that the cleanup below would otherwise delete.
 * Detaching this job's recurrenceId BEFORE the cleanup sweep is what makes
 * that guarantee airtight: the sweep reads jobs `by_recurrence`, and by the
 * time it runs this job no longer carries that recurrenceId, so it can't be
 * found by the scan — no separate "exclude this job" branch needed.
 */
export const stopFromJob = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const { job } = await requireEditableJob(ctx, businessId, jobId)
    if (!job.recurrenceId) throw new ConvexError('NOT_RECURRING')

    const recurrenceId = job.recurrenceId
    const recurrence = await ctx.db.get(recurrenceId)
    if (!recurrence || recurrence.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    await ctx.db.patch(jobId, { recurrenceId: undefined })
    await ctx.db.patch(recurrenceId, { active: false })

    const siblings = await ctx.db
      .query('jobs')
      .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
      .collect()

    const now = Date.now()
    for (const sibling of siblings) {
      if (sibling.status === 'booked' && sibling.scheduledAt > now) {
        await ctx.db.delete(sibling._id)
      }
    }
  },
})
