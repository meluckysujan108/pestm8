import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { canEditJob, jobVisibility, requireMembership } from './lib/access'
import { dayKeyOf, endOfDayInZone, startOfDayInZone } from './lib/dates'
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
          postcode: property?.postcode ?? '',
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
    return Promise.all(
      Array.from({ length: 7 }, async (_, i) => {
        const dayFrom = from + i * dayMs
        const inDay = jobs
          .filter((j) => j.scheduledAt >= dayFrom && j.scheduledAt < dayFrom + dayMs)
          .sort((a, b) => a.scheduledAt - b.scheduledAt)

        // The first job's suburb stands for the day's weather. A day spanning
        // several suburbs has no single forecast, so the UI labels which one.
        const property = inDay[0] ? await ctx.db.get(inDay[0].propertyId) : null

        return {
          offset: i,
          dayKey: dayKeyOf(dayFrom, business.timezone),
          count: inDay.length,
          suburb: property?.suburb ?? '',
          postcode: property?.postcode ?? '',
          colours: [
            ...new Set(
              inDay.map(
                (j) => assignees.get(j.assignedMembershipId) ?? '#8E8E93',
              ),
            ),
          ],
        }
      }),
    )
  },
})

/**
 * Per-day job counts for the month grid (§2.2), plus the suburb each day's
 * first job sits in so the calendar can show weather where it is known.
 */
export const listMonth = query({
  args: {
    businessId: v.id('businesses'),
    monthKey: v.string(), // "YYYY-MM"
  },
  handler: async (ctx, { businessId, monthKey }) => {
    const membership = await requireMembership(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return []

    const from = startOfDayInZone(`${monthKey}-01`, business.timezone)
    const [year, month] = monthKey.split('-').map(Number)
    const nextMonth =
      month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
    const to = startOfDayInZone(nextMonth, business.timezone)

    const jobs = await jobsInRange(ctx, membership, from, to)

    const byDay = new Map<
      string,
      { count: number; colours: Set<string>; suburb: string; postcode: string }
    >()

    for (const job of jobs.sort((a, b) => a.scheduledAt - b.scheduledAt)) {
      const dayKey = dayKeyOf(job.scheduledAt, business.timezone)
      const assignee = await ctx.db.get(job.assignedMembershipId)
      const property = await ctx.db.get(job.propertyId)

      const entry = byDay.get(dayKey) ?? {
        count: 0,
        colours: new Set<string>(),
        suburb: property?.suburb ?? '',
        postcode: property?.postcode ?? '',
      }
      entry.count += 1
      entry.colours.add(assignee?.colour ?? '#8E8E93')
      byDay.set(dayKey, entry)
    }

    return [...byDay.entries()].map(([dayKey, e]) => ({
      dayKey,
      count: e.count,
      colours: [...e.colours],
      suburb: e.suburb,
      postcode: e.postcode,
    }))
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
