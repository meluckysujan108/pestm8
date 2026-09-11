import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import { canEditJob, jobVisibility, requireMembership, resolveViewScope } from './lib/access'
import { dayKeyOf, endOfDayInZone, startOfDayInZone } from './lib/dates'
import { clientNameOf, newClientFields, resolvePropertyId, withClient } from './properties'
import { jobStatus } from './schema'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Membership } from './lib/access'

/**
 * Hands out the next human-sayable job number for a business and advances
 * the counter in the same mutation — safe under Convex's transactional
 * guarantees even when called more than once in one execution (recurrence
 * materialisation books several jobs per run).
 */
export async function allocateJobNumber(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<number> {
  const business = await ctx.db.get(businessId)
  const current = business?.nextJobNumber ?? 1
  await ctx.db.patch(businessId, { nextJobNumber: current + 1 })
  return current
}

/**
 * Reads in a window, filtered to what this member may see. A subcontractor
 * without canViewAllJobs never has another person's job loaded at all, rather
 * than having it loaded and hidden in the UI (§6.5).
 *
 * Exported for `analytics.ts`, which needs the exact same scoped range scan
 * rather than a second implementation of the same scope-branching logic.
 */
export async function jobsInRange(
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
  // Resolving a name means a call into the auth component, so each assignee is
  // looked up once per query rather than once per job — the same memoisation
  // `listWeek` already does for colours. The map holds the in-flight promise,
  // not the resolved string: `Promise.all` below starts every job at once, so
  // caching only settled values would let a day's worth of jobs all miss for
  // the same assignee before any of them had written an answer back.
  const names = new Map<Id<'memberships'>, Promise<string>>()
  const nameOf = (membershipId: Id<'memberships'>, userId?: string) => {
    const inFlight = names.get(membershipId)
    if (inFlight) return inFlight

    const pending = (async () => {
      const user = userId ? await authComponent.getAnyUserById(ctx, userId) : null
      return user?.name ?? ''
    })()
    names.set(membershipId, pending)
    return pending
  }

  return Promise.all(
    jobs
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map(async (job) => {
        const property = await ctx.db.get(job.propertyId)
        const assignee = await ctx.db.get(job.assignedMembershipId)
        return {
          ...job,
          // The board-variant card shows the full street address; the compact
          // list variant still shows suburb alone, per §2.3's reasoning that
          // scanning a day wants the suburb.
          addressLine: property?.addressLine ?? '',
          suburb: property?.suburb ?? '',
          postcode: property?.postcode ?? '',
          clientName: await clientNameOf(ctx, property),
          assigneeColour: assignee?.colour ?? '#8E8E93',
          assigneeName: await nameOf(job.assignedMembershipId, assignee?.userId),
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
    const membership = await resolveViewScope(ctx, businessId)
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
    const membership = await resolveViewScope(ctx, businessId)
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
    const membership = await resolveViewScope(ctx, businessId)
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

/**
 * Per-subcontractor job counts for the month, for the desktop calendar's
 * team legend — the dots are colour-coded by assignee (§2.3), so the legend
 * reads the same colours back as names rather than inventing job-type colours.
 */
export const monthTeamLoad = query({
  args: {
    businessId: v.id('businesses'),
    monthKey: v.string(), // "YYYY-MM"
  },
  handler: async (ctx, { businessId, monthKey }) => {
    const membership = await resolveViewScope(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return []

    const from = startOfDayInZone(`${monthKey}-01`, business.timezone)
    const [year, month] = monthKey.split('-').map(Number)
    const nextMonth =
      month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
    const to = startOfDayInZone(nextMonth, business.timezone)

    const jobs = await jobsInRange(ctx, membership, from, to)

    const counts = new Map<Id<'memberships'>, number>()
    for (const job of jobs) {
      counts.set(
        job.assignedMembershipId,
        (counts.get(job.assignedMembershipId) ?? 0) + 1,
      )
    }

    const rows = await Promise.all(
      [...counts.entries()].map(async ([membershipId, count]) => {
        const assignee = await ctx.db.get(membershipId)
        const user = assignee
          ? await authComponent.getAnyUserById(ctx, assignee.userId)
          : null
        return {
          membershipId,
          name: user?.name ?? 'Unassigned',
          colour: assignee?.colour ?? '#8E8E93',
          count,
        }
      }),
    )

    return rows.sort((a, b) => b.count - a.count)
  },
})

export const get = query({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const membership = await requireMembership(ctx, businessId)
    // Visibility (can this job be seen at all) follows "view as" when active;
    // canEdit below always reflects the REAL caller, never the viewed-as
    // person — read access granted by view-as never implies write access.
    const viewScope = await resolveViewScope(ctx, businessId)

    const job = await ctx.db.get(jobId)
    if (!job || job.businessId !== businessId) return null

    const visibility = jobVisibility(viewScope)
    if (
      visibility.scope === 'assignee' &&
      job.assignedMembershipId !== visibility.membershipId
    ) {
      // Null rather than an error: a subcontractor must not be able to tell a
      // colleague's job apart from one that does not exist.
      return null
    }

    const rawProperty = await ctx.db.get(job.propertyId)
    const property = rawProperty && (await withClient(ctx, rawProperty))
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
    // Either an existing property, or the fields to create a brand-new
    // client + property in the same transaction — lets booking a job for a
    // client that doesn't exist yet happen in one submit instead of a trip
    // to the Clients page first.
    propertyId: v.optional(v.id('properties')),
    newClient: v.optional(newClientFields),
    assignedMembershipId: v.id('memberships'),
    jobType: v.string(),
    price: v.number(),
    scheduledAt: v.number(),
    durationMinutes: v.number(),
  },
  handler: async (ctx, { propertyId: existingPropertyId, newClient, ...args }) => {
    const membership = await requireMembership(ctx, args.businessId)

    // Only an owner may put work on someone else's calendar.
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

    const assignee = await ctx.db.get(args.assignedMembershipId)
    if (!assignee || assignee.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    return ctx.db.insert('jobs', {
      ...args,
      propertyId,
      status: 'booked',
      createdAt: Date.now(),
      jobNumber: await allocateJobNumber(ctx, args.businessId),
    })
  },
})

/**
 * The guard every job-editing mutation repeats: resolve membership, load the
 * job, confirm it belongs to this business, and refuse a write from anyone
 * but the owner or the assigned technician. Centralised here rather than
 * copied a fifth and sixth time for the new photo mutations below — the
 * same call this file's own `reports.ts` sibling makes for
 * `requireEditableReport`.
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

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    jobId: v.id('jobs'),
    propertyId: v.optional(v.id('properties')),
    jobType: v.optional(v.string()),
    price: v.optional(v.number()),
    scheduledAt: v.optional(v.number()),
    durationMinutes: v.optional(v.number()),
    assignedMembershipId: v.optional(v.id('memberships')),
    status: v.optional(jobStatus),
  },
  handler: async (ctx, { businessId, jobId, ...patch }) => {
    const { membership, job } = await requireEditableJob(ctx, businessId, jobId)

    // Reassignment is an owner action even on your own job.
    if (
      patch.assignedMembershipId !== undefined &&
      patch.assignedMembershipId !== job.assignedMembershipId &&
      membership.role !== 'owner'
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    // Same tenant check `create` already performs — a job can be corrected
    // to a different address, never moved to another business's property.
    if (patch.propertyId !== undefined) {
      const property = await ctx.db.get(patch.propertyId)
      if (!property || property.businessId !== businessId) {
        throw new ConvexError('NOT_FOUND')
      }
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
    await requireEditableJob(ctx, businessId, jobId)
    await ctx.db.patch(jobId, { status: 'completed', completedAt: Date.now() })
  },
})

export const cancel = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    await requireEditableJob(ctx, businessId, jobId)
    await ctx.db.patch(jobId, { status: 'cancelled' })
  },
})

/**
 * Short-lived upload URL for a job photo — mirrors `reports.generateUploadUrl`
 * exactly: generic and not job-specific, since the real gate is `addPhoto`
 * attaching the resulting storage id to a job the caller may actually edit.
 */
export const generateUploadUrl = mutation({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    return ctx.storage.generateUploadUrl()
  },
})

export const addPhoto = mutation({
  args: {
    businessId: v.id('businesses'),
    jobId: v.id('jobs'),
    storageId: v.id('_storage'),
    caption: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, jobId, storageId, caption }) => {
    await requireEditableJob(ctx, businessId, jobId)

    const existing = await ctx.db
      .query('jobPhotos')
      .withIndex('by_job', (q) => q.eq('jobId', jobId))
      .collect()

    await ctx.db.insert('jobPhotos', {
      jobId,
      storageId,
      caption,
      order: existing.length,
      createdAt: Date.now(),
    })
  },
})

export const removePhoto = mutation({
  args: {
    businessId: v.id('businesses'),
    jobId: v.id('jobs'),
    photoId: v.id('jobPhotos'),
  },
  handler: async (ctx, { businessId, jobId, photoId }) => {
    await requireEditableJob(ctx, businessId, jobId)

    const photo = await ctx.db.get(photoId)
    if (!photo || photo.jobId !== jobId) throw new ConvexError('NOT_FOUND')
    await ctx.db.delete(photoId)
  },
})

/** Every photo attached to a job, newest first — read access follows the
 * same visibility as the job itself, not the stricter edit gate. */
export const photos = query({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const membership = await resolveViewScope(ctx, businessId)

    const job = await ctx.db.get(jobId)
    if (!job || job.businessId !== businessId) return []
    const visibility = jobVisibility(membership)
    if (
      visibility.scope === 'assignee' &&
      job.assignedMembershipId !== visibility.membershipId
    ) {
      return []
    }

    const rows = await ctx.db
      .query('jobPhotos')
      .withIndex('by_job', (q) => q.eq('jobId', jobId))
      .collect()

    const withUrls = await Promise.all(
      rows.map(async (row) => ({
        _id: row._id,
        caption: row.caption,
        order: row.order,
        url: await ctx.storage.getUrl(row.storageId),
      })),
    )
    return withUrls
      .filter((row) => row.url !== null)
      .sort((a, b) => a.order - b.order)
  },
})
