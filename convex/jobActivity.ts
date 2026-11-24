import { v } from 'convex/values'
import { paginationOptsValidator } from 'convex/server'
import { query } from './_generated/server'
import { authComponent } from './auth'
import { requireActor, requireCapability } from './lib/actor'
import { isBinned, unbinned } from './lib/bin'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { jobInScope } from './lib/jobPeople'
import { hidePrices } from './lib/prices'
import { describeInterval } from './lib/recurrence'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import type { ActorEnvelope } from './lib/actor'
import type { JobActivityAction, JobChange } from './lib/jobActivity'

/**
 * Who changed what on a job, and from what to what (`jobActivity` in
 * schema.ts, written by lib/jobActivity.ts), read two ways:
 *
 * - `list`: one job's, for the foot of its sheet. For whoever may open the
 *   job, as `jobs.get` decides that — its history is the job's own, read
 *   with it.
 * - `feed`: the whole business's, newest first, for the owner's Settings →
 *   Activity, a page at a time.
 *
 * Both read a line the same way (`activityReader`), so the two never
 * disagree: every figure is withheld from someone who cannot see prices, as
 * on the job itself — a price changed reads as changed, and a payment says
 * how it was paid but not how much — and an address the reader can't be
 * shown reads as "another address".
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

    const read = activityReader(ctx, env, businessId)
    const entries: Array<ActivityEntry> = []
    for (const row of shown) entries.push(await read.entry(row))

    // Where the business's history begins: the first line it ever wrote.
    // A job booked before then has had changes nobody wrote down. One whose
    // own booking is here began inside it, whatever its clock says: the job
    // is stamped a moment before the line that books it.
    const recordedSince = await historyBegan(ctx, businessId)
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

/**
 * The job a line of the business's Activity is about, as its line names it:
 * what it is, for whom, and when.
 *
 * - `open`: the job is there, and its sheet opens from the line.
 * - `binned`: in the Recycle bin. Named still — this is the owner's, who
 *   reads the bin itself — but its sheet doesn't open, as `jobs.get` doesn't.
 * - `gone`: wiped for good. Its history goes with it (bin.ts), so a line
 *   about one is a moment's leftover of a wipe still under way.
 */
export type FeedJob =
  | {
      state: 'open' | 'binned'
      jobType: string
      /** The client's name, or null for one outside the reader's book. */
      client: string | null
      /** The site's suburb, under the same rule as the client's name. */
      suburb: string | null
      scheduledAt: number
    }
  | { state: 'gone' }

export type FeedEntry = ActivityEntry & {
  jobId: Id<'jobs'>
  job: FeedJob
}

/**
 * Every change to every job in the business, newest first: the owner's
 * Settings → Activity. With `staffId`, only the changes that person made
 * (`actorMembershipId`: the real person, never the account they were
 * working in).
 *
 * The owner's, as the Recycle bin is (`business.manage`): it is the answer
 * to "who changed this job?" across jobs nobody else may open. An owner
 * working in someone else's account has no `business.manage` for the length
 * of the switch, and is refused.
 *
 * `staffId` is a string from the page's address: one that names nobody is a
 * list with nothing in it, not a refusal.
 */
export const feed = query({
  args: {
    businessId: v.id('businesses'),
    staffId: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { businessId, staffId, paginationOpts }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'business.manage')

    let actorId: Id<'memberships'> | null = null
    if (staffId !== undefined) {
      actorId = ctx.db.normalizeId('memberships', staffId)
      if (actorId === null) {
        return { page: [], isDone: true, continueCursor: '' }
      }
    }
    const rows = await (
      actorId === null
        ? ctx.db
            .query('jobActivity')
            .withIndex('by_businessId_and_at', (q) =>
              q.eq('businessId', businessId),
            )
        : ctx.db
            .query('jobActivity')
            .withIndex('by_businessId_and_actorMembershipId_and_at', (q) =>
              q.eq('businessId', businessId).eq('actorMembershipId', actorId),
            )
    )
      .order('desc')
      .paginate(paginationOpts)

    const read = activityReader(ctx, env, businessId)
    const page: Array<FeedEntry> = []
    for (const row of rows.page) {
      page.push({
        ...(await read.entry(row)),
        jobId: row.jobId,
        job: await read.job(row.jobId),
      })
    }
    return { ...rows, page }
  },
})

/**
 * Where the business's Activity begins, for the foot of Settings → Activity
 * once its last page is in: the time of its first line, when a job was
 * booked before then and so had changes nobody wrote down — or null when
 * the history holds every change there is, as for a business that began
 * with it.
 *
 * `list`'s rule for one job, asked of the business's oldest: booked before
 * the first line, and its own booking not among the lines. Every job after
 * it was booked inside the history. Owner only, like `feed`.
 */
export const feedStart = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'business.manage')

    const began = await historyBegan(ctx, businessId)
    if (began === null) return { recordedSince: null }
    const oldest = await ctx.db
      .query('jobs')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .first()
    if (oldest === null || oldest.createdAt >= began) {
      return { recordedSince: null }
    }
    const itsFirst = await ctx.db
      .query('jobActivity')
      .withIndex('by_jobId_and_at', (q) => q.eq('jobId', oldest._id))
      .first()
    return {
      recordedSince: itsFirst?.action === 'job.create' ? null : began,
    }
  },
})

/** When the business's history began: the first line it ever wrote, or null
 * before it has written one. */
async function historyBegan(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
): Promise<number | null> {
  const first = await ctx.db
    .query('jobActivity')
    .withIndex('by_businessId_and_at', (q) => q.eq('businessId', businessId))
    .first()
  return first?.at ?? null
}

/**
 * Reads lines of Activity into what a reader may be shown, for `list` and
 * `feed` alike: each person's name, each site's address and each job once,
 * however often they appear on a page.
 */
function activityReader(
  ctx: QueryCtx,
  env: ActorEnvelope,
  businessId: Id<'businesses'>,
) {
  const pricesHidden = hidePrices(env.caps)
  // Only asked for when a line names a site or a job's client, which a
  // job's own sheet seldom does.
  let visible: ReturnType<typeof visibleClientIds> | undefined
  const inBook = async (clientId: Id<'clients'>) => {
    visible ??= visibleClientIds(ctx, env)
    return inClientScope(await visible, clientId)
  }
  const person = personReader(ctx, businessId, env.actor.real._id)
  const address = addressReader(ctx, businessId, inBook)
  const jobs = new Map<Id<'jobs'>, Promise<FeedJob>>()

  return {
    entry: async (row: Doc<'jobActivity'>): Promise<ActivityEntry> => {
      const changes: Array<ShownChange> = []
      for (const change of row.changes) {
        changes.push(
          await showChange(change, { person, address, pricesHidden }),
        )
      }
      return {
        _id: row._id,
        at: row.at,
        action: row.action,
        by: await person(row.actorMembershipId),
        inAccountOf:
          row.onBehalfOfMembershipId === undefined
            ? null
            : await person(row.onBehalfOfMembershipId),
        changes,
        payment: await paymentOf(ctx, row, pricesHidden),
        interval: row.interval ? describeInterval(row.interval) : null,
        binRoot: row.binRoot ?? null,
      }
    },
    job: (id: Id<'jobs'>): Promise<FeedJob> => {
      let job = jobs.get(id)
      if (job === undefined) {
        job = feedJob(ctx, businessId, id, inBook)
        jobs.set(id, job)
      }
      return job
    },
  }
}

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
type BookCheck = (clientId: Id<'clients'>) => Promise<boolean>

/** Each site's address as it reads now, once each — or null, read as
 * "another address", for a site that is gone, in the Recycle bin, or at a
 * client this reader can't see (lib/clientScope.ts: nobody today, but the
 * history shouldn't be the way round a narrowed client book). */
function addressReader(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  inBook: BookCheck,
): AddressReader {
  const addresses = new Map<Id<'properties'>, Promise<string | null>>()
  const read = async (id: Id<'properties'>) => {
    const site = unbinned(await ctx.db.get(id))
    if (!site || site.businessId !== businessId) return null
    if (!(await inBook(site.clientId))) return null
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

/**
 * A job as a line of the business's Activity names it. Its client and
 * suburb are read whether or not they are in the Recycle bin: the feed is
 * the owner's, who reads the bin, and a line saying "Deleted it with its
 * client" is no use without saying which. A client outside the reader's
 * book is never named, as nowhere else names one.
 */
async function feedJob(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  jobId: Id<'jobs'>,
  inBook: BookCheck,
): Promise<FeedJob> {
  const job = await ctx.db.get(jobId)
  if (!job || job.businessId !== businessId) return { state: 'gone' }
  const site = await ctx.db.get(job.propertyId)
  const named =
    site !== null &&
    site.businessId === businessId &&
    (await inBook(site.clientId))
      ? site
      : null
  const client = named ? await ctx.db.get(named.clientId) : null
  return {
    state: isBinned(job) ? 'binned' : 'open',
    jobType: job.jobType,
    client: client?.name || null,
    suburb: named?.suburb || null,
    scheduledAt: job.scheduledAt,
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
  row: Doc<'jobActivity'>,
  pricesHidden: boolean,
): Promise<ActivityEntry['payment']> {
  if (row.paymentId === undefined) return null
  const payment = await ctx.db.get(row.paymentId)
  if (!payment || payment.jobId !== row.jobId) return null
  return {
    method: payment.method,
    amount: pricesHidden ? null : payment.amount,
    deposit: payment.deposit === true,
  }
}
