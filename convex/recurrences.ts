import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { allocateJobNumber } from './jobs'
import { isBinned, unbinned } from './lib/bin'
import { requireActor, requireWriteActor } from './lib/actor'
import { recordOnBehalf } from './lib/audit'
import { activateLeadAt } from './lib/clientRecord'
import { insertJobNote } from './notes'
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
import { normaliseJobNotes } from './lib/jobNotes'
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
import { jobsInScope } from './lib/jobScope'
import type { WriteEnvelope } from './lib/actor'
import type { Interval } from './lib/recurrence'
import type { MutationCtx, QueryCtx } from './_generated/server'
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
export const MAX_VISITS_PER_RUN = 60

export const listForBusiness = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)

    const all = await ctx.db
      .query('recurrences')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
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

const DAY_MS = 24 * 60 * 60 * 1000

/** A visit not yet done or cancelled: one the page may still need to show. */
const STILL_OPEN = new Set(['recurring', 'pending', 'booked'])

/**
 * The Recurring Job page by service: every running service the view shows
 * (`listScope`, as `jobs.listRecurring` counts them), where and for whom,
 * and its visits from as far back as the schedule carries an unbooked one
 * to as far ahead as the engine books — each cut to what a row shows.
 *
 * Which visit is next, what is to book and when a service is next due are
 * the page's to work out (src/lib/clientJobs.ts), against `startOfToday`
 * where the business is: passed in, so nothing here reads the clock. A
 * service with no visit in the window still has its row, and `lastTaken`
 * for when it is next due.
 */
export const services = query({
  args: { businessId: v.id('businesses'), startOfToday: v.number() },
  handler: async (ctx, { businessId, startOfToday }) => {
    const env = await requireActor(ctx, businessId)

    const series = (
      await ctx.db
        .query('recurrences')
        .withIndex('by_business_active', (q) =>
          q.eq('businessId', businessId).eq('active', true),
        )
        .filter((q) => q.eq(q.field('deletedAt'), undefined))
        .collect()
    ).filter((r) => isInScope(env.listScope, r))
    const ids = new Set<Id<'recurrences'>>(series.map((r) => r._id))

    const inWindow = (
      await jobsInScope(ctx, env.listScope, {
        businessId,
        from: startOfToday - HORIZON_DAYS * DAY_MS,
        // A day's slack past the horizon: the engine books from its own
        // "now", up to a day ahead of the caller's today.
        to: startOfToday + (HORIZON_DAYS + 2) * DAY_MS,
      })
    ).filter((j) => j.recurrenceId !== undefined)
    const visits = inWindow.filter((j) => ids.has(j.recurrenceId!))
    // A recurring visit the view shows whose service it does not: one left
    // to book when its service was stopped (stopping cancels only what is
    // still to come), or one handed to this person out of someone else's
    // service. The overdue badge counts these; the page must show them.
    const loose = inWindow.filter(
      (j) => !ids.has(j.recurrenceId!) && STILL_OPEN.has(j.status),
    )

    // A service with nothing live ahead in the window is next due after the
    // latest occurrence it has used — by anyone's visit, in the Recycle bin
    // or not — which the engine never books again. A visit booked further
    // ahead than the window (a first yearly visit seven months out) is
    // found the same way, and is its next.
    const ahead = new Set(
      visits
        .filter(
          (j) => j.scheduledAt >= startOfToday && STILL_OPEN.has(j.status),
        )
        .map((j) => j.recurrenceId),
    )
    const beyond: Array<Doc<'jobs'>> = []
    const lastTaken = new Map(
      await Promise.all(
        series
          .filter((r) => !ahead.has(r._id))
          .map(async (r) => {
            const recent = await ctx.db
              .query('jobs')
              .withIndex('by_recurrence', (q) => q.eq('recurrenceId', r._id))
              .order('desc')
              .take(20)
            const seen = new Set(visits.map((j) => j._id))
            beyond.push(
              ...recent.filter(
                (j) =>
                  !seen.has(j._id) &&
                  j.deletedAt === undefined &&
                  j.scheduledAt >= startOfToday &&
                  STILL_OPEN.has(j.status) &&
                  isInScope(env.listScope, j),
              ),
            )
            const taken = recent.map((j) => j.occurrenceAt ?? j.scheduledAt)
            return [
              r._id,
              taken.length > 0 ? Math.max(...taken) : undefined,
            ] as const
          }),
      ),
    )
    const compact = (j: Doc<'jobs'>) => ({
      _id: j._id,
      jobNumber: j.jobNumber,
      scheduledAt: j.scheduledAt,
      status: j.status,
      jobType: j.jobType,
      propertyId: j.propertyId,
      recurrenceId: j.recurrenceId,
      occurrenceAt: j.occurrenceAt,
      assignedMembershipId: j.assignedMembershipId,
    })

    const properties = new Map<
      Id<'properties'>,
      Promise<{ clientName: string; addressLine: string; suburb: string }>
    >()
    const place = (propertyId: Id<'properties'>) => {
      let found = properties.get(propertyId)
      if (!found) {
        found = ctx.db.get(propertyId).then(async (property) => ({
          clientName: await clientNameOf(ctx, property),
          addressLine: property?.addressLine ?? '',
          suburb: property?.suburb ?? '',
        }))
        properties.set(propertyId, found)
      }
      return found
    }

    return {
      services: await Promise.all(
        series.map(async (r) => ({
          _id: r._id,
          jobType: r.jobType,
          interval: intervalOf(r),
          active: r.active,
          propertyId: r.propertyId,
          ...(await place(r.propertyId)),
          assignedMembershipId: r.assignedMembershipId,
          anchorDate: r.anchorDate,
          lastTaken: lastTaken.get(r._id),
        })),
      ),
      visits: [...visits, ...beyond].map(compact),
      loose: await Promise.all(
        loose.map(async (j) => ({
          ...compact(j),
          clientName: (await place(j.propertyId)).clientName,
          suburb: (await place(j.propertyId)).suburb,
        })),
      ),
      horizonDays: HORIZON_DAYS,
    }
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
    /**
     * A note typed while booking. It goes on the FIRST visit only — a job's
     * note is about that visit (schema.ts), and the series copies no note onto
     * the rest. What every visit needs is a site note ("Before you arrive"),
     * which each visit at the address already shows.
     */
    notes: v.optional(v.string()),
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
    const notes = normaliseJobNotes(args.notes)

    // Same rule as jobs.create, and it matters more here: the daily cron keeps
    // booking a series onto its assignee for as long as it runs.
    await requireBookable(ctx, env, args.businessId, args.assignedMembershipId)

    const propertyId = await resolvePropertyId(ctx, args.businessId, {
      propertyId: existingPropertyId,
      newProperty,
      newClient,
    })
    // A standing arrangement is booked work: a lead becomes a client
    // (lib/clientRecord.ts), even when its first visit is in the past.
    await activateLeadAt(ctx, propertyId)

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
    // Onto the series' first visit: the one booked above, or — for a series
    // that starts in the past, where no visit is invented for the missed
    // date — the first one projected. With no visit inside the horizon yet,
    // it waits on the series for the first the engine books. Never dropped.
    if (notes !== undefined) {
      const visits = await ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        // A new series holds at most the first visit and one run's worth.
        .take(MAX_VISITS_PER_RUN + 1)
      const first = visits.reduce<Doc<'jobs'> | null>(
        (earliest, visit) =>
          earliest === null || visit.scheduledAt < earliest.scheduledAt
            ? visit
            : earliest,
        null,
      )
      // A note in Notes on that visit (`insertJobNote`), by whoever booked.
      if (first) {
        await insertJobNote(ctx, {
          job: first,
          authorMembershipId: env.actor.real._id,
          text: notes,
        })
      } else {
        await ctx.db.patch(recurrenceId, {
          firstVisitNotes: notes,
          firstVisitNotesBy: env.actor.real._id,
        })
      }
    }
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

    const recurrence = unbinned(await ctx.db.get(recurrenceId))
    if (!recurrence || recurrence.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    await requireEditableSeries(ctx, env, recurrence)

    if (active) {
      await ctx.db.patch(recurrenceId, { active })
      await recordSeriesWrite(ctx, env, recurrenceId, 'recurrence.setActive', {
        active,
      })
    } else {
      await stopSeries(ctx, env, recurrence)
    }
  },
})

/**
 * Stops a series: no more visits are booked, and its visits still to come
 * that nobody has started are cancelled — they stay on the schedule, marked
 * cancelled. Anything in progress, completed or invoiced is history and stays
 * as it is, and so does a visit already due that nobody actioned.
 */
async function stopSeries(
  ctx: MutationCtx,
  env: WriteEnvelope,
  recurrence: Doc<'recurrences'>,
) {
  await ctx.db.patch(recurrence._id, { active: false })
  await recordSeriesWrite(ctx, env, recurrence._id, 'recurrence.setActive', {
    active: false,
  })
  const jobs = await ctx.db
    .query('jobs')
    .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrence._id))
    .collect()
  const now = Date.now()
  for (const job of jobs) {
    if (NOT_STARTED_STATUSES.has(job.status) && job.scheduledAt > now) {
      await setJobStatus(ctx, job, 'cancelled')
    }
  }
}

/** A client's series still running, at every one of their properties. */
async function runningSeriesOf(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
): Promise<Array<Doc<'recurrences'>>> {
  const properties = await ctx.db
    .query('properties')
    .withIndex('by_client', (q) => q.eq('clientId', clientId))
    .collect()
  const series = await Promise.all(
    properties
      .filter((p) => p.businessId === businessId && !isBinned(p))
      .map((p) =>
        ctx.db
          .query('recurrences')
          .withIndex('by_property', (q) => q.eq('propertyId', p._id))
          .collect(),
      ),
  )
  return series.flat().filter((r) => r.active && !isBinned(r))
}

/**
 * How many of a client's recurring services are still running, and how many
 * of those the caller may stop — asked when a client is marked Inactive, so
 * the sheet can offer to stop them (`stopForClient`). Only series the caller
 * can see are counted.
 */
export const runningForClient = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireActor(ctx, businessId)
    const visible = (await runningSeriesOf(ctx, businessId, clientId)).filter(
      (r) => isInScope(env.scope, r),
    )
    const stoppable = await Promise.all(
      visible.map((r) => mayEditJob(ctx, env.actor, r)),
    )
    return {
      running: visible.length,
      stoppable: stoppable.filter(Boolean).length,
    }
  },
})

/**
 * Stops every recurring service of a client that the caller may stop, as
 * "Stop repeating" does for one (`stopSeries`). Offered when a client is
 * marked Inactive. A series the caller can see but may not edit is left
 * running and counted, so the sheet can say so.
 */
export const stopForClient = mutation({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireWriteActor(ctx, businessId)
    const client = unbinned(await ctx.db.get(clientId))
    if (!client || client.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    let stopped = 0
    let skipped = 0
    // Only what the caller can see: a series outside their schedule is not
    // theirs to stop, nor to learn of from the count.
    const visible = (await runningSeriesOf(ctx, businessId, clientId)).filter(
      (r) => isInScope(env.scope, r),
    )
    for (const recurrence of visible) {
      if (await mayEditJob(ctx, env.actor, recurrence)) {
        await stopSeries(ctx, env, recurrence)
        stopped++
      } else {
        skipped++
      }
    }
    return { stopped, skipped }
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
export async function insertVisit(
  ctx: MutationCtx,
  recurrence: Doc<'recurrences'>,
  scheduledAt: number,
  durationMinutes: number,
  origin: 'manual' | 'recurrence',
): Promise<Id<'jobs'>> {
  return ctx.db.insert('jobs', {
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
export async function materialiseOne(
  ctx: MutationCtx,
  recurrenceId: Id<'recurrences'>,
  durationMinutes = 60,
): Promise<number> {
  // Nothing is booked for a series in the Recycle bin, or at a site that is
  // in it or gone. The site is checked on its own, not taken on trust from
  // the series: `insertVisit` never reads it, so a series whose property was
  // binned or wiped without it would go on booking visits at an address no
  // screen can open, for six months ahead, every night (lib/bin.ts).
  const recurrence = unbinned(await ctx.db.get(recurrenceId))
  if (!recurrence || !recurrence.active) return 0
  if (!unbinned(await ctx.db.get(recurrence.propertyId))) return 0

  // The series repeats on the tenant's calendar, not the server's.
  const business = await ctx.db.get(recurrence.businessId)
  if (!business) return 0

  const existing = await ctx.db
    .query('jobs')
    .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
    .collect()

  // Which OCCURRENCES are spoken for, not which instants — a visit somebody
  // moved still occupies the one it was projected onto (schema.ts). A visit
  // in the Recycle bin still occupies its occurrence too: deleting one visit
  // must not have the next run book it again.
  const taken = new Set(existing.map((j) => j.occurrenceAt ?? j.scheduledAt))

  const now = Date.now()
  let created = 0
  // A booking's note still waiting for a visit goes on the first one booked
  // here, and on no other.
  let waitingNotes = recurrence.firstVisitNotes
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

    const visitId = await insertVisit(
      ctx,
      recurrence,
      scheduledAt,
      durationMinutes,
      'recurrence',
    )
    if (waitingNotes !== undefined) {
      const visit = await ctx.db.get(visitId)
      if (visit) {
        await insertJobNote(ctx, {
          job: visit,
          // A series set up before notes were Notes has no author on file;
          // its note is then the assignee's, whose visit it is.
          authorMembershipId:
            recurrence.firstVisitNotesBy ?? recurrence.assignedMembershipId,
          text: waitingNotes,
        })
      }
      await ctx.db.patch(recurrence._id, {
        firstVisitNotes: undefined,
        firstVisitNotesBy: undefined,
      })
      waitingNotes = undefined
    }
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
      if (!recurrence.active || isBinned(recurrence)) continue
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

    const recurrence = unbinned(await ctx.db.get(recurrenceId))
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
      const existing = unbinned(await ctx.db.get(job.recurrenceId))
      if (existing?.active) throw new ConvexError('ALREADY_RECURRING')
    }

    // The same rule `create` applies, and for the same reason: a series keeps
    // booking onto its assignee nightly for as long as it runs, so turning a
    // job into one must ask whether that person can still be booked.
    await requireBookable(ctx, env, businessId, job.assignedMembershipId)
    await activateLeadAt(ctx, job.propertyId)

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
    const recurrence = unbinned(await ctx.db.get(recurrenceId))
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
