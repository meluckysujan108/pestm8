import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { canEditJob, jobVisibility, requireMembership } from './lib/access'
import { endOfDayInZone, startOfDayInZone } from './lib/dates'
import { jobStatus } from './schema'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import type { Membership } from './lib/access'

/**
 * Reads in a window, filtered to what this member may see. A subcontractor
 * without canViewAllJobs never has another person's job loaded at all, rather
 * than having it loaded and hidden in the UI (§6.5).
 */
async function jobsInRange(
  ctx: QueryCtx,
  membership: Membership,
  from: number,
  to: number,
): Promise<Array<Doc<'jobs'>>> {
  const visibility = jobVisibility(membership)

  const jobs =
    visibility.scope === 'business'
      ? await ctx.db
          .query('jobs')
          .withIndex('by_business_date', (q) =>
            q
              .eq('businessId', visibility.businessId)
              .gte('scheduledAt', from)
              .lt('scheduledAt', to),
          )
          .collect()
      : await ctx.db
          .query('jobs')
          .withIndex('by_assignee_date', (q) =>
            q
              .eq('assignedMembershipId', visibility.membershipId)
              .gte('scheduledAt', from)
              .lt('scheduledAt', to),
          )
          .collect()

  return jobs.filter((j) => j.status !== 'cancelled')
}

async function decorate(ctx: QueryCtx, jobs: Array<Doc<'jobs'>>) {
  return Promise.all(
    jobs
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map(async (job) => {
        const property = await ctx.db.get(job.propertyId)
        const assignee = await ctx.db.get(job.assignedMembershipId)
        return {
          ...job,
          // Suburb only on list rows — full address belongs to the detail view
          // and to legal documents (§2.3).
          suburb: property?.suburb ?? '',
          clientName: property?.clientName ?? '',
          assigneeColour: assignee?.colour ?? '#8E8E93',
        }
      }),
  )
}

export const listDay = query({
  args: {
    businessId: v.id('businesses'),
    dayKey: v.string(), // "YYYY-MM-DD" in the tenant's timezone
  },
  handler: async (ctx, { businessId, dayKey }) => {
    const membership = await requireMembership(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return []

    const from = startOfDayInZone(dayKey, business.timezone)
    const to = endOfDayInZone(dayKey, business.timezone)

    return decorate(ctx, await jobsInRange(ctx, membership, from, to))
  },
})

/**
 * Seven days from `startKey`, grouped by day. Drives the week strip's
 * per-subcontractor dots, so it returns assignee colours per day.
 */
export const listWeek = query({
  args: { businessId: v.id('businesses'), startKey: v.string() },
  handler: async (ctx, { businessId, startKey }) => {
    const membership = await requireMembership(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return []

    const from = startOfDayInZone(startKey, business.timezone)
    const to = from + 7 * 24 * 60 * 60 * 1000

    const jobs = await jobsInRange(ctx, membership, from, to)
    const assignees = new Map<Id<'memberships'>, string>()
    for (const job of jobs) {
      if (!assignees.has(job.assignedMembershipId)) {
        const m = await ctx.db.get(job.assignedMembershipId)
        assignees.set(job.assignedMembershipId, m?.colour ?? '#8E8E93')
      }
    }

    const dayMs = 24 * 60 * 60 * 1000
    return Array.from({ length: 7 }, (_, i) => {
      const dayFrom = from + i * dayMs
      const inDay = jobs.filter(
        (j) => j.scheduledAt >= dayFrom && j.scheduledAt < dayFrom + dayMs,
      )
      return {
        offset: i,
        count: inDay.length,
        colours: [
          ...new Set(
            inDay.map((j) => assignees.get(j.assignedMembershipId) ?? '#8E8E93'),
          ),
        ],
      }
    })
  },
})

export const get = query({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const membership = await requireMembership(ctx, businessId)

    const job = await ctx.db.get(jobId)
    if (!job || job.businessId !== businessId) return null

    const visibility = jobVisibility(membership)
    if (
      visibility.scope === 'assignee' &&
      job.assignedMembershipId !== visibility.membershipId
    ) {
      // Null rather than an error: a subcontractor must not be able to tell a
      // colleague's job apart from one that does not exist.
      return null
    }

    const property = await ctx.db.get(job.propertyId)
    const assignee = await ctx.db.get(job.assignedMembershipId)
    const recurrence = job.recurrenceId
      ? await ctx.db.get(job.recurrenceId)
      : null

    return {
      ...job,
      property,
      recurrence: recurrence && {
        _id: recurrence._id,
        frequency: recurrence.frequency,
        active: recurrence.active,
      },
      assignee: assignee && {
        _id: assignee._id,
        colour: assignee.colour,
        role: assignee.role,
        licenceNumber: assignee.licenceNumber,
      },
      // Granted read access never implies write access (§4.4).
      canEdit: canEditJob(membership, job),
    }
  },
})

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    propertyId: v.id('properties'),
    assignedMembershipId: v.id('memberships'),
    jobType: v.string(),
    price: v.number(),
    scheduledAt: v.number(),
    durationMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.businessId)

    // Only an owner may put work on someone else's calendar.
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

    const assignee = await ctx.db.get(args.assignedMembershipId)
    if (!assignee || assignee.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    return ctx.db.insert('jobs', {
      ...args,
      status: 'booked',
      createdAt: Date.now(),
    })
  },
})

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    jobId: v.id('jobs'),
    jobType: v.optional(v.string()),
    price: v.optional(v.number()),
    scheduledAt: v.optional(v.number()),
    durationMinutes: v.optional(v.number()),
    assignedMembershipId: v.optional(v.id('memberships')),
    status: v.optional(jobStatus),
  },
  handler: async (ctx, { businessId, jobId, ...patch }) => {
    const membership = await requireMembership(ctx, businessId)

    const job = await ctx.db.get(jobId)
    if (!job || job.businessId !== businessId) throw new ConvexError('NOT_FOUND')
    if (!canEditJob(membership, job)) throw new ConvexError('NO_ACCESS')

    // Reassignment is an owner action even on your own job.
    if (
      patch.assignedMembershipId !== undefined &&
      patch.assignedMembershipId !== job.assignedMembershipId &&
      membership.role !== 'owner'
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    const fields = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    )
    if (Object.keys(fields).length > 0) await ctx.db.patch(jobId, fields)
  },
})

export const complete = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const membership = await requireMembership(ctx, businessId)

    const job = await ctx.db.get(jobId)
    if (!job || job.businessId !== businessId) throw new ConvexError('NOT_FOUND')
    if (!canEditJob(membership, job)) throw new ConvexError('NO_ACCESS')

    await ctx.db.patch(jobId, { status: 'completed', completedAt: Date.now() })
  },
})

export const cancel = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const membership = await requireMembership(ctx, businessId)

    const job = await ctx.db.get(jobId)
    if (!job || job.businessId !== businessId) throw new ConvexError('NOT_FOUND')
    if (!canEditJob(membership, job)) throw new ConvexError('NO_ACCESS')

    await ctx.db.patch(jobId, { status: 'cancelled' })
  },
})
