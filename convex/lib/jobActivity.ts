import type { Infer } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { intervalUnit, jobActivityAction, jobChange } from '../schema'
import type { AuditAttribution } from './audit'

/**
 * A job's history (`jobActivity` in schema.ts): one row each time someone
 * changes it, saying what each fact was and what it became.
 *
 * Written by comparing the job before a write with the job after it, rather
 * than by each mutation listing what it meant to change. A write's own idea
 * of what it did misses the knock-ons — a payment that settles a job moves
 * its status too (`followMoney`) — and the comparison sees them, and sees a
 * field that was sent but left as it was for what it is: no change.
 */

export type JobActivityAction = Infer<typeof jobActivityAction>
export type JobChange = Infer<typeof jobChange>

/** Who was also going, before a write and after it. */
export type PeopleChange = {
  from: ReadonlyArray<Id<'memberships'>>
  to: ReadonlyArray<Id<'memberships'>>
}

export type JobActivityExtra = {
  /** Who was also going, when the write may have changed it: the job row
   * does not carry them (lib/jobPeople.ts). */
  people?: PeopleChange
  paymentId?: Id<'payments'>
  interval?: { count: number; unit: Infer<typeof intervalUnit> }
  binRoot?: 'job' | 'recurrence' | 'property' | 'client' | 'contact'
  /** Only when the row must share a timestamp with the write it describes. */
  at?: number
}

/** The facts a job's history follows, as a job before and after a write
 * show them. In the order its sheet says them: what happens to the visit
 * first, then who and where, then what it is for and what it costs. */
export function jobChanges(
  before: Doc<'jobs'>,
  after: Doc<'jobs'>,
  people?: PeopleChange,
): Array<JobChange> {
  const changes: Array<JobChange> = []
  if (before.status !== after.status) {
    changes.push({ field: 'status', from: before.status, to: after.status })
  }
  if (before.scheduledAt !== after.scheduledAt) {
    changes.push({
      field: 'scheduledAt',
      from: before.scheduledAt,
      to: after.scheduledAt,
    })
  }
  if (before.durationMinutes !== after.durationMinutes) {
    changes.push({
      field: 'durationMinutes',
      from: before.durationMinutes,
      to: after.durationMinutes,
    })
  }
  if (before.assignedMembershipId !== after.assignedMembershipId) {
    changes.push({
      field: 'lead',
      from: before.assignedMembershipId,
      to: after.assignedMembershipId,
    })
  }
  if (people) {
    const added = people.to.filter((id) => !people.from.includes(id))
    // Someone also going who is made the lead is still on it: the lead line
    // says what happened to them.
    const removed = people.from.filter(
      (id) => !people.to.includes(id) && id !== after.assignedMembershipId,
    )
    if (added.length > 0 || removed.length > 0) {
      changes.push({ field: 'alsoGoing', added, removed })
    }
  }
  if (before.propertyId !== after.propertyId) {
    changes.push({
      field: 'propertyId',
      from: before.propertyId,
      to: after.propertyId,
    })
  }
  if (before.jobType !== after.jobType) {
    changes.push({ field: 'jobType', from: before.jobType, to: after.jobType })
  }
  if (before.price !== after.price) {
    changes.push({ field: 'price', from: before.price, to: after.price })
  }
  if (before.workOrder !== after.workOrder) {
    changes.push({
      field: 'workOrder',
      ...(before.workOrder !== undefined && { from: before.workOrder }),
      ...(after.workOrder !== undefined && { to: after.workOrder }),
    })
  }
  return changes
}

/**
 * A line in `before`'s history for what was just done to it: read the job
 * again, and write down how it differs.
 *
 * Call it AFTER the write, with the job as it was read before. An edit that
 * changed nothing the history follows (the same date sent back, a service
 * saved under the name it already had) writes nothing; any other action is
 * a line of its own, changes or none — a photo added changes no field.
 */
export async function recordJobActivity(
  ctx: MutationCtx,
  by: AuditAttribution,
  before: Doc<'jobs'>,
  action: JobActivityAction,
  extra: JobActivityExtra = {},
): Promise<void> {
  const after = await ctx.db.get(before._id)
  const changes = after ? jobChanges(before, after, extra.people) : []
  if (action === 'job.update' && changes.length === 0) return
  await ctx.db.insert('jobActivity', {
    businessId: before.businessId,
    jobId: before._id,
    action,
    actorMembershipId: by.actorMembershipId,
    ...(by.onBehalfOfMembershipId !== undefined && {
      onBehalfOfMembershipId: by.onBehalfOfMembershipId,
    }),
    changes,
    ...(extra.paymentId !== undefined && { paymentId: extra.paymentId }),
    ...(extra.interval !== undefined && { interval: extra.interval }),
    ...(extra.binRoot !== undefined && { binRoot: extra.binRoot }),
    at: extra.at ?? Date.now(),
  })
}

/**
 * A wiped job's history, with it (bin.ts): up to `max` of its rows, saying
 * how many went and whether that was all of them. A step of the wipe that
 * runs out of room ends and lets the next one carry on, so a long history
 * never makes one transaction too big.
 */
export async function dropJobActivity(
  ctx: MutationCtx,
  jobId: Id<'jobs'>,
  max: number,
): Promise<{ deleted: number; done: boolean }> {
  if (max <= 0) return { deleted: 0, done: false }
  const rows = await ctx.db
    .query('jobActivity')
    .withIndex('by_jobId_and_at', (q) => q.eq('jobId', jobId))
    .take(max)
  for (const row of rows) await ctx.db.delete('jobActivity', row._id)
  return { deleted: rows.length, done: rows.length < max }
}
