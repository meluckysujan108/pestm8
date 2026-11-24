import { v } from 'convex/values'
import { query } from './_generated/server'
import { authComponent } from './auth'
import { requireActor } from './lib/actor'
import { unbinned } from './lib/bin'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { jobInScope } from './lib/jobPeople'
import { hidePrices } from './lib/prices'
import { describeInterval } from './lib/recurrence'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import type { ActorEnvelope } from './lib/actor'
import type { JobActivityAction, JobChange } from './lib/jobActivity'

/**
 * A job's Activity, for the foot of its sheet: who changed what on it, and
 * from what to what (`jobActivity` in schema.ts, written by
 * lib/jobActivity.ts).
 *
 * For whoever may open the job, as `jobs.get` decides that — its history is
 * the job's own, read with it. Every figure is withheld from someone who
 * cannot see prices, as on the job itself: a price changed reads as changed,
 * and a payment says how it was paid but not how much.
 *
 * Read into words here, not on the phone: names from the team as it is now
 * (a member since removed is still named), addresses from the site as it is
 * now, and only ids and figures stored.
 */

/** How many of a job's latest changes the sheet is sent. A job changed more
 * often than this says the rest weren't sent (`more`). */
export const ACTIVITY_LIMIT = 50

export type ActivityPerson = {
  name: string
  /** The person reading it, who reads "You". */
  you: boolean
}

export type ShownChange =
  | Extract<
      JobChange,
      {
        field:
          'status' | 'scheduledAt' | 'durationMinutes' | 'jobType' | 'workOrder'
      }
    >
  | { field: 'lead'; from: ActivityPerson; to: ActivityPerson }
  | {
      field: 'alsoGoing'
      added: Array<ActivityPerson>
      removed: Array<ActivityPerson>
    }
  /** An address, or null for a site since wiped from the Recycle bin. */
  | { field: 'property'; from: string | null; to: string | null }
  /** Null both ways for someone who cannot see prices. */
  | { field: 'price'; from: number | null; to: number | null }

export type ActivityEntry = {
  _id: Id<'jobActivity'>
  at: number
  action: JobActivityAction
  by: ActivityPerson
  /** Whose account it was done in, when that was someone else's. */
  inAccountOf: ActivityPerson | null
  changes: Array<ShownChange>
  /** payment.*: how it was paid, and — for someone who sees prices — how
   * much. Null when the payment is gone with a wiped job's. */
  payment: {
    method: Doc<'payments'>['method']
    amount: number | null
    deposit: boolean
  } | null
  /** recurrence.convert: "Every 3 months". */
  interval: string | null
  binRoot: Doc<'jobActivity'>['binRoot'] | null
}

export const list = query({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const env = await requireActor(ctx, businessId)
    // Whoever may open the job may read its history, and nobody else: a job
    // in the Recycle bin, or one out of scope, reads as nothing, as in
    // `jobs.get`.
    const job = unbinned(await ctx.db.get(jobId))
    if (!job || job.businessId !== businessId) return null
    if (!(await jobInScope(ctx, env.scope, job))) return null

    const rows = await ctx.db
      .query('jobActivity')
      .withIndex('by_jobId_and_at', (q) => q.eq('jobId', jobId))
      .order('desc')
      .take(ACTIVITY_LIMIT + 1)
    const more = rows.length > ACTIVITY_LIMIT
    const shown = rows.slice(0, ACTIVITY_LIMIT)

    const pricesHidden = hidePrices(env.caps)
    const person = personReader(ctx, businessId, env.actor.real._id)
    const address = addressReader(ctx, env)

    const entries: Array<ActivityEntry> = []
    for (const row of shown) {
      const changes: Array<ShownChange> = []
      for (const change of row.changes) {
        changes.push(
          await showChange(change, { person, address, pricesHidden }),
        )
      }
      entries.push({
        _id: row._id,
        at: row.at,
        action: row.action,
        by: await person(row.actorMembershipId),
        inAccountOf:
          row.onBehalfOfMembershipId === undefined
            ? null
            : await person(row.onBehalfOfMembershipId),
        changes,
        payment: await paymentOf(ctx, job, row.paymentId, pricesHidden),
        interval: row.interval ? describeInterval(row.interval) : null,
        binRoot: row.binRoot ?? null,
      })
    }

    // Where the business's history begins: the first line it ever wrote.
    // A job booked before then has had changes nobody wrote down. One whose
    // own booking is here began inside it, whatever its clock says: the job
    // is stamped a moment before the line that books it.
    const first = await ctx.db
      .query('jobActivity')
      .withIndex('by_businessId_and_at', (q) => q.eq('businessId', businessId))
      .first()
    const recordedSince = first?.at ?? null
    const hasBooking = shown.some((row) => row.action === 'job.create')
    const bookedBefore =
      !more &&
      !hasBooking &&
      (recordedSince === null || job.createdAt < recordedSince)

    // Its first line, when the history holds none: a booking made before the
    // history began, or a visit its Recurring Job put on the schedule, which
    // nobody booked by hand. Not while older lines are still to come.
    const origin =
      more || hasBooking
        ? null
        : {
            at: job.createdAt,
            bySeries: !bookedBefore && job.occurrenceAt !== undefined,
          }

    return {
      entries,
      more,
      origin,
      /** When the business's history began, for a job booked before it;
       * null for one whose whole history is here. */
      recordedSince: bookedBefore ? recordedSince : null,
      /** Whether the job was booked before its business's history began. */
      bookedBefore,
    }
  },
})

type PersonReader = (id: Id<'memberships'>) => Promise<ActivityPerson>

/** Each member's name, read once however often they appear. */
function personReader(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  me: Id<'memberships'>,
): PersonReader {
  const names = new Map<Id<'memberships'>, Promise<string>>()
  const nameOf = async (id: Id<'memberships'>): Promise<string> => {
    const member = await ctx.db.get(id)
    if (!member || member.businessId !== businessId) return 'Someone'
    if (member.displayName) return member.displayName
    try {
      const user = await authComponent.getAnyUserById(ctx, member.userId)
      return user?.name || 'Someone'
    } catch (error) {
      // A history must never fail to open because one name could not be
      // read; the line still says what was done.
      console.error(`activity name lookup failed for ${id}`, error)
      return 'Someone'
    }
  }
  return async (id) => {
    let name = names.get(id)
    if (name === undefined) {
      name = nameOf(id)
      names.set(id, name)
    }
    return { name: await name, you: id === me }
  }
}

type AddressReader = (id: Id<'properties'>) => Promise<string | null>

/** Each site's address as it reads now, once each — or null, read as
 * "another address", for a site that is gone, in the Recycle bin, or at a
 * client this reader can't see (lib/clientScope.ts: nobody today, but the
 * history shouldn't be the way round a narrowed client book). */
function addressReader(ctx: QueryCtx, env: ActorEnvelope): AddressReader {
  const addresses = new Map<Id<'properties'>, Promise<string | null>>()
  // Only asked for when a line moved the job, which most never do.
  let visible: ReturnType<typeof visibleClientIds> | undefined
  const read = async (id: Id<'properties'>) => {
    const site = unbinned(await ctx.db.get(id))
    if (!site || site.businessId !== env.readScope.businessId) return null
    visible ??= visibleClientIds(ctx, env)
    if (!inClientScope(await visible, site.clientId)) return null
    return [site.addressLine, site.suburb].filter(Boolean).join(', ')
  }
  return async (id) => {
    let address = addresses.get(id)
    if (address === undefined) {
      address = read(id)
      addresses.set(id, address)
    }
    return address
  }
}

async function showChange(
  change: JobChange,
  read: {
    person: PersonReader
    address: AddressReader
    pricesHidden: boolean
  },
): Promise<ShownChange> {
  switch (change.field) {
    case 'lead':
      return {
        field: 'lead',
        from: await read.person(change.from),
        to: await read.person(change.to),
      }
    case 'alsoGoing':
      return {
        field: 'alsoGoing',
        added: await Promise.all(change.added.map(read.person)),
        removed: await Promise.all(change.removed.map(read.person)),
      }
    case 'propertyId':
      return {
        field: 'property',
        from: await read.address(change.from),
        to: await read.address(change.to),
      }
    case 'price':
      return read.pricesHidden
        ? { field: 'price', from: null, to: null }
        : change
    default:
      return change
  }
}

/** The payment a line is about, as the person reading may see it. */
async function paymentOf(
  ctx: QueryCtx,
  job: Doc<'jobs'>,
  paymentId: Id<'payments'> | undefined,
  pricesHidden: boolean,
): Promise<ActivityEntry['payment']> {
  if (paymentId === undefined) return null
  const payment = await ctx.db.get(paymentId)
  if (!payment || payment.jobId !== job._id) return null
  return {
    method: payment.method,
    amount: pricesHidden ? null : payment.amount,
    deposit: payment.deposit === true,
  }
}
