import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { allocateJobNumber } from './jobs'
import { requireActor, requireWriteActor } from './lib/actor'
import { recordOnBehalf } from './lib/audit'
import { isInScope, writeAttribution } from './lib/capabilities'
import {
  mayEditJob,
  requireBookable,
  requireEditableJob,
} from './lib/jobAccess'
import {
  NOT_STARTED_STATUSES,
  initialJobStatus,
  setJobStatus,
} from './lib/jobStatus'
import { redactJob } from './lib/prices'
import { normaliseWorkOrder } from './lib/workOrder'
import {
  HORIZON_DAYS,
  assertInterval,
  describeInterval,
  intervalOf,
  occurrencesFrom,
} from './lib/recurrence'
import {
  clientNameOf,
  newClientFields,
  newPropertyFields,
  resolvePropertyId,
} from './properties'
import { intervalUnit } from './schema'
import type { WriteEnvelope } from './lib/actor'
import type { Interval } from './lib/recurrence'
import type { MutationCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'

/**
 * The most visits one materialise run will insert for one series.
 *
 * Daily intervals are bookable, and six months of a daily series is ~180 job
 * inserts — each one also bumping `businesses.nextJobNumber` — in a single
 * transaction. Capping the run keeps any one mutation small and leaves the
 * rest to the next cron pass, which fills the horizon within a few days.
 * Nothing is lost: `materialiseOne` is idempotent and always resumes from
 * whatever is missing.
 */
const MAX_VISITS_PER_RUN = 60

export const listForBusiness = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)

    const all = await ctx.db
      .query('recurrences')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()

    // Scoped like everything else. This query gated on bare membership, so
    // every member could read every repeating contract in the business —
    // including series belonging to people whose schedule they cannot see.
    const recurrences = all.filter((r) =>
      isInScope(env.scope, { assignedMembershipId: r.assignedMembershipId }),
    )

    return Promise.all(
      recurrences.map(async (r) => {
        const property = await ctx.db.get(r.propertyId)
        return {
          ...redactJob(env.caps, r),
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
    newProperty: v.optional(newPropertyFields),
    assignedMembershipId: v.id('memberships'),
    intervalCount: v.number(),
    intervalUnit,
    jobType: v.string(),
    price: v.number(),
    anchorDate: v.number(),
    durationMinutes: v.number(),
    workOrder: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { propertyId: existingPropertyId, newClient, newProperty, ...args },
  ) => {
    const env = await requireWriteActor(ctx, args.businessId)

    // Before anything is written: `v.number()` admits 0, -3 and 2.5, none of
    // which describe a repeat.
    assertInterval({ count: args.intervalCount, unit: args.intervalUnit })
    const workOrder = normaliseWorkOrder(args.workOrder)

    // Same rule as jobs.create, and it matters more here: the daily cron keeps
    // booking a series onto its assignee for as long as it runs.
    await requireBookable(ctx, env, args.businessId, args.assignedMembershipId)

    const propertyId = await resolvePropertyId(ctx, args.businessId, {
      propertyId: existingPropertyId,
      newProperty,
      newClient,
    })

    const recurrenceId = await ctx.db.insert('recurrences', {
      businessId: args.businessId,
      propertyId,
      assignedMembershipId: args.assignedMembershipId,
      intervalCount: args.intervalCount,
      intervalUnit: args.intervalUnit,
      jobType: args.jobType,
      price: args.price,
      anchorDate: args.anchorDate,
      active: true,
      ...(workOrder !== undefined && { workOrder }),
    })

    // The first visit is the one the person just booked by hand, so it is
    // born `pending` like any other job they create — and is inserted here,
    // whatever the horizon. Left to `materialiseOne`, an anchor more than
    // HORIZON_DAYS out would be skipped today and created weeks later by the
    // cron, as `recurring`. The engine then finds its instant taken and
    // projects only the visits after it.
    const recurrence = await ctx.db.get(recurrenceId)
    if (recurrence && !isBackfill(recurrence.anchorDate)) {
      await insertVisit(
        ctx,
        recurrence,
        recurrence.anchorDate,
        args.durationMinutes,
        'manual',
      )
    }
    await materialiseOne(ctx, recurrenceId, args.durationMinutes)
    await recordSeriesWrite(ctx, env, recurrenceId, 'recurrence.create', {
      assignedMembershipId: args.assignedMembershipId,
      interval: describeInterval({
        count: args.intervalCount,
        unit: args.intervalUnit,
      }),
    })
    return recurrenceId
  },
})

/**
 * A series changed inside someone else's account, on that account's record.
 * Nothing when the writer was working as themselves — see `recordOnBehalf`.
 */
async function recordSeriesWrite(
  ctx: MutationCtx,
  env: WriteEnvelope,
  recurrenceId: Id<'recurrences'>,
  action: string,
  meta?: unknown,
) {
  await recordOnBehalf(ctx, writeAttribution(env.actor), {
    businessId: env.actor.real.businessId,
    action,
    entityType: 'recurrences',
    entityId: recurrenceId,
    meta,
  })
}

/**
 * Authority over a whole series: whoever may edit work assigned to its
 * assignee — the owner, the assignee, their contractor — asked of the acting
 * account like every other write here.
 */
async function requireEditableSeries(
  ctx: MutationCtx,
  env: WriteEnvelope,
  recurrence: Doc<'recurrences'>,
) {
  if (!(await mayEditJob(ctx, env.actor, recurrence))) {
    throw new ConvexError('NO_ACCESS')
  }
}

export const setActive = mutation({
  args: {
    businessId: v.id('businesses'),
    recurrenceId: v.id('recurrences'),
    active: v.boolean(),
  },
  handler: async (ctx, { businessId, recurrenceId, active }) => {
    const env = await requireWriteActor(ctx, businessId)

    const recurrence = await ctx.db.get(recurrenceId)
    if (!recurrence || recurrence.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    await requireEditableSeries(ctx, env, recurrence)

    await ctx.db.patch(recurrenceId, { active })
    await recordSeriesWrite(ctx, env, recurrenceId, 'recurrence.setActive', {
      active,
    })

    // Stopping a recurrence removes work not yet started; anything in
    // progress, completed or invoiced is history and stays untouched.
    if (!active) {
      const jobs = await ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect()

      const now = Date.now()
      for (const job of jobs) {
        if (NOT_STARTED_STATUSES.has(job.status) && job.scheduledAt > now) {
          await setJobStatus(ctx, job, 'cancelled')
        }
      }
    }
  },
})

/** Never backfill: a missed visit is not something to invent after the fact. */
function isBackfill(scheduledAt: number): boolean {
  return scheduledAt < Date.now() - 24 * 60 * 60 * 1000
}

/**
 * One visit of a series. `origin` decides its first status: `recurrence` for a
 * visit the engine projects — the only way any job becomes `recurring` — and
 * `manual` for the one a person booked by hand when creating the series.
 */
async function insertVisit(
  ctx: MutationCtx,
  recurrence: Doc<'recurrences'>,
  scheduledAt: number,
  durationMinutes: number,
  origin: 'manual' | 'recurrence',
): Promise<void> {
  await ctx.db.insert('jobs', {
    // Which occurrence this is, kept even if the visit is later moved — see
    // the field's note in schema.ts.
    occurrenceAt: scheduledAt,
    businessId: recurrence.businessId,
    propertyId: recurrence.propertyId,
    assignedMembershipId: recurrence.assignedMembershipId,
    jobType: recurrence.jobType,
    price: recurrence.price,
    scheduledAt,
    durationMinutes,
    status: initialJobStatus(origin),
    recurrenceId: recurrence._id,
    createdAt: Date.now(),
    jobNumber: await allocateJobNumber(ctx, recurrence.businessId),
    // Every visit carries the series' work order, so the office invoicing
    // any one of them has it without looking the series up.
    ...(recurrence.workOrder !== undefined && {
      workOrder: recurrence.workOrder,
    }),
  })
}

/**
 * Creates any missing occurrences inside the horizon, every one `recurring`.
 * Idempotent by design — the cron runs daily and must never double-book a
 * property.
 */
async function materialiseOne(
  ctx: MutationCtx,
  recurrenceId: Id<'recurrences'>,
  durationMinutes = 60,
): Promise<number> {
  const recurrence = await ctx.db.get(recurrenceId)
  if (!recurrence || !recurrence.active) return 0

  // The series repeats on the tenant's calendar, not the server's.
  const business = await ctx.db.get(recurrence.businessId)
  if (!business) return 0

  const existing = await ctx.db
    .query('jobs')
    .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
    .collect()

  // Which OCCURRENCES are spoken for, not which instants — a visit somebody
  // moved still occupies the one it was projected onto (schema.ts).
  const taken = new Set(existing.map((j) => j.occurrenceAt ?? j.scheduledAt))

  const now = Date.now()
  let created = 0
  for (const scheduledAt of occurrencesFrom(
    recurrence.anchorDate,
    intervalOf(recurrence),
    {
      timezone: business.timezone,
      // Never backfill: a missed visit is not something to invent after the
      // fact. Asking for the window directly also means the work of this call
      // is bounded by the horizon rather than by the age of the series.
      from: now - 24 * 60 * 60 * 1000,
      until: now + HORIZON_DAYS * 24 * 60 * 60 * 1000,
      // One more than the run's budget, so the loop below can stop on its own
      // terms without a second pass deciding there was nothing left.
      limit: MAX_VISITS_PER_RUN + existing.length + 1,
    },
  )) {
    if (taken.has(scheduledAt)) continue
    // Stop rather than skip: the occurrences are in order, so everything left
    // is further out than everything taken, and the next run resumes exactly
    // here. Skipping would insert the far end of the horizon and leave a hole.
    if (created >= MAX_VISITS_PER_RUN) break

    await insertVisit(
      ctx,
      recurrence,
      scheduledAt,
      durationMinutes,
      'recurrence',
    )
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
      // Booking work for someone who has left is how a removed subcontractor
      // keeps appearing on the schedule for the next six months.
      const assignee = await ctx.db.get(recurrence.assignedMembershipId)
      if (!assignee || assignee.status !== 'active') continue
      created += await materialiseOne(ctx, recurrence._id)
    }
    return { created }
  },
})

/** Exposed for tests and for a manual "generate now" action. */
export const materialise = mutation({
  args: { businessId: v.id('businesses'), recurrenceId: v.id('recurrences') },
  handler: async (ctx, { businessId, recurrenceId }) => {
    await requireWriteActor(ctx, businessId)

    const recurrence = await ctx.db.get(recurrenceId)
    if (!recurrence || recurrence.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    return materialiseOne(ctx, recurrenceId)
  },
})

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
    intervalCount: v.number(),
    intervalUnit,
  },
  handler: async (
    ctx,
    { businessId, jobId, intervalCount, intervalUnit: unit },
  ) => {
    const interval: Interval = { count: intervalCount, unit }
    assertInterval(interval)

    const { env, job } = await requireEditableJob(ctx, businessId, jobId)

    if (job.recurrenceId) {
      const existing = await ctx.db.get(job.recurrenceId)
      if (existing?.active) throw new ConvexError('ALREADY_RECURRING')
    }

    // The same rule `create` applies, and for the same reason: a series keeps
    // booking onto its assignee nightly for as long as it runs, so turning a
    // job into one must ask whether that person can still be booked.
    await requireBookable(ctx, env, businessId, job.assignedMembershipId)

    const recurrenceId = await ctx.db.insert('recurrences', {
      businessId,
      propertyId: job.propertyId,
      assignedMembershipId: job.assignedMembershipId,
      intervalCount,
      intervalUnit: unit,
      jobType: job.jobType,
      price: job.price,
      anchorDate: job.scheduledAt,
      active: true,
      // The job's work order becomes the series', so the visits projected
      // from it are booked under it too.
      ...(job.workOrder !== undefined && { workOrder: job.workOrder }),
    })

    // Attach the EXISTING job to the new series before materialising —
    // materialiseOne's own idempotency check then finds this job already
    // occupying the anchor occurrence and skips generating a duplicate for it.
    await ctx.db.patch(jobId, { recurrenceId, occurrenceAt: job.scheduledAt })

    await materialiseOne(ctx, recurrenceId, job.durationMinutes)
    await recordSeriesWrite(ctx, env, recurrenceId, 'recurrence.convert', {
      jobId,
      interval: describeInterval(interval),
    })

    return recurrenceId
  },
})

/**
 * Stops a recurring series from one specific job's context, guaranteeing
 * that exact job survives as a standalone one-off even though it may itself
 * be a future, not-yet-started visit that the cleanup below would cancel.
 * Detaching this job's recurrenceId BEFORE the cleanup sweep is what makes
 * that guarantee airtight: the sweep reads jobs `by_recurrence`, and by the
 * time it runs this job no longer carries that recurrenceId, so it can't be
 * found by the scan — no separate "exclude this job" branch needed.
 */
export const stopFromJob = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)
    if (!job.recurrenceId) throw new ConvexError('NOT_RECURRING')

    const recurrenceId = job.recurrenceId
    const recurrence = await ctx.db.get(recurrenceId)
    if (!recurrence || recurrence.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    // Being handed one visit out of a series is not authority over the series.
    // This checked only the job's own assignee, so a subcontractor given a
    // single visit could end the owner's quarterly contract and wipe every
    // remaining booking on it.
    await requireEditableSeries(ctx, env, recurrence)

    await ctx.db.patch(jobId, { recurrenceId: undefined })
    // A one-off is not a projected visit of anything, so a kept job that was
    // still `recurring` becomes an ordinary job the person has in hand. This
    // is it LEAVING `recurring`, which is always allowed.
    if (job.status === 'recurring') await setJobStatus(ctx, job, 'pending')
    await ctx.db.patch(recurrenceId, { active: false })

    const siblings = await ctx.db
      .query('jobs')
      .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
      .collect()

    const now = Date.now()
    for (const sibling of siblings) {
      if (
        NOT_STARTED_STATUSES.has(sibling.status) &&
        sibling.scheduledAt > now
      ) {
        // Cancelled, not deleted: someone turned up to these, or planned to.
        // A hard delete leaves the owner no way to see what was dropped.
        await setJobStatus(ctx, sibling, 'cancelled')
      }
    }
    await recordSeriesWrite(ctx, env, recurrenceId, 'recurrence.stop', {
      keptJobId: jobId,
    })
  },
})
