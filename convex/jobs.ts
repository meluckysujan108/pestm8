import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import { dayKeyOf, endOfDayInZone, startOfDayInZone } from './lib/dates'
import {
  clientNameOf,
  newClientFields,
  resolvePropertyId,
  withClient,
} from './properties'
import { suggestTemplate } from '../src/lib/reportTemplates/suggest'
import type { Doc, Id } from './_generated/dataModel'
import { isInScope, writeAttribution } from './lib/capabilities'
import { jobsInScope } from './lib/jobScope'
import { hidePrices, redactJob } from './lib/prices'
import type { RowScope } from './lib/capabilities'
import type { ActorEnvelope, WriteEnvelope } from './lib/actor'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { requireActor, requireWriteActor } from './lib/actor'
import { recordOnBehalf } from './lib/audit'
import {
  mayEditJob,
  requireBookable,
  requireEditableJob,
} from './lib/jobAccess'

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
  scope: RowScope,
  businessId: Id<'businesses'>,
  from: number,
  to: number,
): Promise<Array<Doc<'jobs'>>> {
  const jobs = await jobsInScope(ctx, scope, { businessId, from, to })
  return jobs.filter((j) => j.status !== 'cancelled')
}

async function decorate(
  ctx: QueryCtx,
  env: ActorEnvelope,
  jobs: Array<Doc<'jobs'>>,
) {
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
      const user = userId
        ? await authComponent.getAnyUserById(ctx, userId)
        : null
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
          ...redactJob(env.caps, job),
          // The board-variant card shows the full street address; the compact
          // list variant still shows suburb alone, per §2.3's reasoning that
          // scanning a day wants the suburb.
          addressLine: property?.addressLine ?? '',
          suburb: property?.suburb ?? '',
          postcode: property?.postcode ?? '',
          clientName: await clientNameOf(ctx, property),
          assigneeColour: assignee?.colour ?? '#8E8E93',
          assigneeName: assignee
            ? await nameOf(job.assignedMembershipId, assignee.userId)
            : '',
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
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return []

    const from = startOfDayInZone(dayKey, business.timezone)
    const to = endOfDayInZone(dayKey, business.timezone)

    return decorate(
      ctx,
      env,
      await jobsInRange(ctx, env.listScope, businessId, from, to),
    )
  },
})

/**
 * Seven days from `startKey`, grouped by day. Drives the week strip's
 * per-subcontractor dots, so it returns assignee colours per day.
 */
export const listWeek = query({
  args: { businessId: v.id('businesses'), startKey: v.string() },
  handler: async (ctx, { businessId, startKey }) => {
    const { listScope } = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return []

    const from = startOfDayInZone(startKey, business.timezone)
    const to = from + 7 * 24 * 60 * 60 * 1000

    const jobs = await jobsInRange(ctx, listScope, businessId, from, to)
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
          .filter(
            (j) => j.scheduledAt >= dayFrom && j.scheduledAt < dayFrom + dayMs,
          )
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
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return []

    const from = startOfDayInZone(`${monthKey}-01`, business.timezone)
    const [year, month] = monthKey.split('-').map(Number)
    const nextMonth =
      month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`
    const to = startOfDayInZone(nextMonth, business.timezone)

    const jobs = await jobsInRange(ctx, env.listScope, businessId, from, to)

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
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return []

    const from = startOfDayInZone(`${monthKey}-01`, business.timezone)
    const [year, month] = monthKey.split('-').map(Number)
    const nextMonth =
      month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`
    const to = startOfDayInZone(nextMonth, business.timezone)

    const jobs = await jobsInRange(ctx, env.listScope, businessId, from, to)

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
    // Visibility (can this job be seen at all) follows "view as" when active;
    // canEdit below is asked of the ACTOR — the account being worked in when
    // switched, and never the viewed-as person: read access granted by view-as
    // never implies write access.
    const env = await requireActor(ctx, businessId)

    const job = await ctx.db.get(jobId)
    if (!job || job.businessId !== businessId) return null

    if (!isInScope(env.scope, job)) {
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
      ...redactJob(env.caps, job),
      property,
      recurrence: recurrence && {
        _id: recurrence._id,
        frequency: recurrence.frequency,
        active: recurrence.active,
      },
      // No licence number: nothing renders it, and it is exactly the detail
      // the roster withholds from people who do not manage the team.
      assignee: assignee && {
        _id: assignee._id,
        colour: assignee.colour,
        role: assignee.role,
      },
      // Granted read access never implies write access (§4.4). The same
      // question `requireEditableJob` asks, so the button is never an
      // invitation to a refusal.
      canEdit: await mayEditJob(ctx, env.actor, job),
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
  handler: async (
    ctx,
    { propertyId: existingPropertyId, newClient, ...args },
  ) => {
    const env = await requireWriteActor(ctx, args.businessId)

    // Who the ACTING account may put work onto (`canDispatchTo`): the owner
    // anyone, a contractor their team, anyone else themselves. The roster's
    // `bookable` flag is the same function, so a picker cannot offer a
    // refused option.
    await requireBookable(ctx, env, args.businessId, args.assignedMembershipId)

    // A price from someone who cannot see prices is a placeholder, not a
    // figure. Stored as nothing rather than as whatever the form defaulted to.
    const price = hidePrices(env.caps) ? 0 : args.price

    const propertyId = await resolvePropertyId(ctx, args.businessId, {
      propertyId: existingPropertyId,
      newClient,
    })

    const jobNumber = await allocateJobNumber(ctx, args.businessId)
    const jobId = await ctx.db.insert('jobs', {
      ...args,
      price,
      propertyId,
      status: 'booked',
      createdAt: Date.now(),
      jobNumber,
    })

    await recordOnBehalf(ctx, writeAttribution(env.actor), {
      businessId: args.businessId,
      action: 'job.create',
      entityType: 'jobs',
      entityId: jobId,
      meta: { jobNumber, assignedMembershipId: args.assignedMembershipId },
    })
    return jobId
  },
})

/**
 * A job write made inside someone else's account, on that account's record.
 * Nothing when the writer was working as themselves — see `recordOnBehalf`.
 */
async function recordJobWrite(
  ctx: MutationCtx,
  env: WriteEnvelope,
  job: Doc<'jobs'>,
  action: string,
  meta?: unknown,
) {
  await recordOnBehalf(ctx, writeAttribution(env.actor), {
    businessId: job.businessId,
    action,
    entityType: 'jobs',
    entityId: job._id,
    meta,
  })
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
    // Deliberately not `jobStatus`: 'invoiced' is set by the invoicing flow
    // (ARCHITECTURE.md §4.5), never by an edit. Any assignee could previously
    // mark their own job invoiced and move the owner's revenue figures.
    status: v.optional(
      v.union(
        v.literal('booked'),
        v.literal('inProgress'),
        v.literal('completed'),
        v.literal('cancelled'),
      ),
    ),
  },
  handler: async (ctx, { businessId, jobId, ...patch }) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)

    // Moving a job onto someone is booking it onto them, and asks the same
    // question `create` does. A subcontractor's only admissible target is
    // themselves — a no-op on their own job, which the `!==` filters out — and
    // a contractor's is their own team.
    if (
      patch.assignedMembershipId !== undefined &&
      patch.assignedMembershipId !== job.assignedMembershipId
    ) {
      await requireBookable(ctx, env, businessId, patch.assignedMembershipId)
    }

    // An invoiced job is a billed job. Letting anyone with write access move it
    // back to booked, re-price it or reschedule it silently contradicts an
    // invoice that has already gone out.
    if (job.status === 'invoiced') throw new ConvexError('JOB_INVOICED')

    // Same tenant check `create` already performs — a job can be corrected
    // to a different address, never moved to another business's property.
    if (patch.propertyId !== undefined) {
      const property = await ctx.db.get(patch.propertyId)
      if (!property || property.businessId !== businessId) {
        throw new ConvexError('NOT_FOUND')
      }
    }

    const fields = Object.fromEntries(
      Object.entries(patch as Record<string, unknown>).filter(
        ([, value]) => value !== undefined,
      ),
    )

    /**
     * Someone who cannot see a price cannot change one — and this is the half
     * that protects the data rather than the secret.
     *
     * Their edit form has no price box, so whatever it sends is a placeholder
     * standing in for a figure they were never shown. Writing it back would
     * destroy the real one silently, and every total downstream of it with it.
     * Dropped rather than refused, so editing the date on a job still works.
     */
    if (hidePrices(env.caps)) delete fields.price

    // The first time a job says work has begun, record when. A report started
    // from this job prints that as its start time, instead of the technician
    // remembering it an hour later. Stamped once: a job bounced back to
    // `inProgress` after a pause still began when it began.
    if (patch.status === 'inProgress' && job.startedAt === undefined) {
      fields.startedAt = Date.now()
    }

    // `update` can set a job complete too, so the business's "not done until
    // its report is" policy has to be asked here as well as in `complete` —
    // otherwise the policy is a button the status menu walks straight past.
    if (patch.status === 'completed' && job.status !== 'completed') {
      await assertReportIssued(ctx, job)
    }

    if (Object.keys(fields).length > 0) {
      await ctx.db.patch(jobId, fields)
      await recordJobWrite(ctx, env, job, 'job.update', {
        fields: Object.keys(fields),
      })
    }
  },
})

export const complete = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)
    await assertReportIssued(ctx, job)
    await ctx.db.patch(jobId, { status: 'completed', completedAt: Date.now() })
    await recordJobWrite(ctx, env, job, 'job.complete')
  },
})

/**
 * A business that issues a report on every treatment can say so.
 *
 * The record is the job — WA's Pesticides Regulations want it made within two
 * business days, and a report written next week from memory is a worse record
 * than one written in the driveway. Off unless an owner turns it on, and even
 * then only for job types that HAVE a form: blocking a quote visit would
 * teach the business to switch the policy off.
 *
 * A draft does not count. The point of finalising is that the document stops
 * changing, and "there is a half-filled draft somewhere" is the state this
 * exists to catch.
 */
async function assertReportIssued(ctx: MutationCtx, job: Doc<'jobs'>) {
  const business = await ctx.db.get(job.businessId)
  if (business?.requireReportToComplete !== true) return
  if (suggestTemplate(job.jobType) === null) return

  const reports = await ctx.db
    .query('reports')
    .withIndex('by_job', (q) => q.eq('jobId', job._id))
    // Bounded, and generous: a job with this many reports has one finalised.
    .take(10)

  const issued = reports.some(
    (report) =>
      // Only this business's own: a report's job id is not proof on its own.
      report.businessId === job.businessId &&
      report.status === 'finalised' &&
      report.deletedAt === undefined,
  )
  if (!issued) throw new ConvexError('REPORT_REQUIRED')
}

export const cancel = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)
    await ctx.db.patch(jobId, { status: 'cancelled' })
    await recordJobWrite(ctx, env, job, 'job.cancel')
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
    await requireWriteActor(ctx, businessId)
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
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)

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
    await recordJobWrite(ctx, env, job, 'job.photo.add')
  },
})

export const removePhoto = mutation({
  args: {
    businessId: v.id('businesses'),
    jobId: v.id('jobs'),
    photoId: v.id('jobPhotos'),
  },
  handler: async (ctx, { businessId, jobId, photoId }) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)

    const photo = await ctx.db.get(photoId)
    if (!photo || photo.jobId !== jobId) throw new ConvexError('NOT_FOUND')
    await ctx.db.delete(photoId)
    await recordJobWrite(ctx, env, job, 'job.photo.remove')
  },
})

/** Every photo attached to a job, newest first — read access follows the
 * same visibility as the job itself, not the stricter edit gate. */
export const photos = query({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const { scope } = await requireActor(ctx, businessId)

    const job = await ctx.db.get(jobId)
    if (!job || job.businessId !== businessId) return []
    if (!isInScope(scope, job)) return []

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
