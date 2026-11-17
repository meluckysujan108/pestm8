import { ConvexError, v } from 'convex/values'
import type { Infer } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import { assertReportIssued, recordJobWrite } from './jobs'
import { requireActor, requireCapability, requireWriteActor } from './lib/actor'
import { unbinned } from './lib/bin'
import {
  dayKeyOf,
  monthBoundsInZone,
  startOfDayInZone,
  todayKeyInZone,
} from './lib/dates'
import { mayEditThisJob, requireEditableJob } from './lib/jobAccess'
import { jobInScope } from './lib/jobPeople'
import { jobsInScope, wireScope } from './lib/jobScope'
import {
  DONE_STATUSES,
  entersDone,
  finishedStatus,
  followMoney,
  isSettled,
  moneyOf,
  owingOn,
  statusFromMoney,
} from './lib/jobStatus'
import {
  MAX_PAYMENTS_ON_A_JOB,
  billedAt,
  counts,
  countsFromOf,
  moneyFigures,
  moneyOnJob,
  normaliseHandOverNote,
  normaliseReference,
  paymentsOfJob,
} from './lib/payments'
import { checkClientRequestId } from './lib/clientRequest'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { recordOnBehalf } from './lib/audit'
import { writeAttribution } from './lib/capabilities'
import { hidePrices, redactTotal } from './lib/prices'
import { isDayKey } from './lib/siteWork'
import { paymentMethod } from './schema'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { MembershipFacts } from './lib/capabilities'

/**
 * Money taken for a job.
 *
 * A payment is the last step of finishing a job, never a gate on it: nothing
 * here stops a job being completed with nothing recorded. Which status the
 * money gives a job is decided in lib/jobStatus.ts and only there; this file
 * says who may record it and what it may be.
 */

/**
 * Whoever may edit the job may take a payment on it, so a technician can at
 * the door. Taking one back is your own, or the owner's say.
 */
function mayRemovePayment(
  acting: MembershipFacts,
  payment: Doc<'payments'>,
): boolean {
  return acting.role === 'owner' || payment.recordedBy === acting._id
}

type HandOver = NonNullable<Doc<'payments'>['handOver']>

/**
 * Money marked as someone else's. `from` is who has it, if that is not whoever
 * recorded it: the owner writing up what a subcontractor took.
 */
const handOverArg = v.object({
  from: v.optional(v.id('memberships')),
  to: v.id('memberships'),
  note: v.optional(v.string()),
})

/** Who owes whom is theirs to say, so anyone in the business can be either. */
async function makeHandOver(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  markedBy: Id<'memberships'>,
  payment: Pick<Doc<'payments'>, 'method' | 'recordedBy'>,
  arg: Infer<typeof handOverArg>,
): Promise<HandOver> {
  const from = arg.from ?? payment.recordedBy
  // "No charge" moved no money, and nobody hands money over to themselves.
  if (payment.method === 'noCharge' || from === arg.to) {
    throw new ConvexError('INVALID_PAYMENT')
  }
  for (const id of [from, arg.to]) {
    const member = await ctx.db.get(id)
    if (!member || member.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
  }
  const note = normaliseHandOverNote(arg.note)
  return {
    from,
    to: arg.to,
    ...(note ? { note } : {}),
    markedBy,
    markedAt: Date.now(),
  }
}

/** Either of the two it is between, or the owner. Nobody else's business. */
function mayTickHandOver(
  acting: MembershipFacts,
  mark: Pick<HandOver, 'from' | 'to'>,
): boolean {
  return (
    acting.role === 'owner' ||
    mark.from === acting._id ||
    mark.to === acting._id
  )
}

export const record = mutation({
  args: {
    businessId: v.id('businesses'),
    jobId: v.id('jobs'),
    method: paymentMethod,
    // Cents. Left out, it is whatever is owing, which is the only way someone
    // who cannot see prices records anything: "Cash, paid in full".
    amount: v.optional(v.number()),
    // This also finishes the job, as at the door. Left out on a job not done
    // yet, the money is a deposit and the job stays as it is.
    complete: v.optional(v.boolean()),
    reference: v.optional(v.string()),
    // The day it arrived, for a transfer that lands after the visit: the
    // middle of that day, stored as a day only (`dayOnly`). Now if absent.
    receivedAt: v.optional(v.number()),
    // Someone else's money, said in the same tap. Usually absent.
    handOver: v.optional(handOverArg),
    // Required, unlike a booking's, because no older screen sends this: "in
    // full" repeated is refused anyway, but a part payment sent twice would
    // otherwise be taken twice.
    clientRequestId: v.string(),
  },
  handler: async (ctx, args) => {
    const clientRequestId = checkClientRequestId(args.clientRequestId)
    const { env, job } = await requireEditableJob(
      ctx,
      args.businessId,
      args.jobId,
    )
    const rows = await paymentsOfJob(ctx, job._id)

    // A save the phone sends twice is one payment, even if it has since been
    // taken back: the removal stands.
    const same = rows.find((row) => row.clientRequestId === clientRequestId)
    if (same) return { paymentId: same._id, status: job.status }

    const finishing = args.complete === true && !DONE_STATUSES.has(job.status)
    // A projected visit is the engine's guess until someone goes: money can
    // be taken for one being finished, but not held against a date nobody has
    // agreed. A cancelled job is not owed anything.
    if (
      job.status === 'cancelled' ||
      (job.status === 'recurring' && !finishing) ||
      rows.length >= MAX_PAYMENTS_ON_A_JOB
    ) {
      throw new ConvexError('PAYMENT_NOT_ALLOWED')
    }

    /**
     * Someone who cannot see prices cannot name an amount. A figure from them
     * is either a guess at a price they were never shown, or a way of finding
     * it: the refusal below, for more than is owing, would answer "is it more
     * than $200?" for as long as they cared to keep asking.
     */
    if (hidePrices(env.caps) && args.amount !== undefined) {
      throw new ConvexError('NO_ACCESS')
    }

    const before = moneyOf(rows)
    if (isSettled(job.price, before)) throw new ConvexError('NOTHING_OWING')
    const owed = owingOn(job.price, before)
    const noCharge = args.method === 'noCharge'
    const amount = noCharge ? 0 : (args.amount ?? owed)
    if (!noCharge) {
      if (owed === 0) throw new ConvexError('NOTHING_OWING')
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new ConvexError('INVALID_PAYMENT')
      }
      if (amount > owed) throw new ConvexError('PAYMENT_OVER_OWING')
    }

    const now = Date.now()
    if (
      args.receivedAt !== undefined &&
      (!Number.isFinite(args.receivedAt) || args.receivedAt <= 0)
    ) {
      throw new ConvexError('INVALID_PAYMENT')
    }

    // Finishing it answers the report policy, however the job gets to done.
    if (finishing && entersDone(job.status, 'completed')) {
      await assertReportIssued(ctx, job)
    }

    const recordedBy = env.actor.acting._id
    const handOver =
      args.handOver &&
      (await makeHandOver(
        ctx,
        job.businessId,
        recordedBy,
        { method: args.method, recordedBy },
        args.handOver,
      ))

    const deposit = !DONE_STATUSES.has(job.status) && !finishing
    const paymentId = await ctx.db.insert('payments', {
      businessId: job.businessId,
      jobId: job._id,
      method: args.method,
      amount,
      // A phone whose clock runs ahead does not put money in next month.
      receivedAt: Math.min(args.receivedAt ?? now, now),
      ...(args.receivedAt !== undefined ? { dayOnly: true } : {}),
      recordedBy,
      recordedAt: now,
      reference: normaliseReference(args.reference),
      ...(deposit ? { deposit: true } : {}),
      ...(handOver ? { handOver } : {}),
      clientRequestId,
    })

    const after = moneyOf([...rows, { amount, method: args.method, deposit }])
    const status = statusFromMoney(
      finishing ? { ...job, status: 'completed' } : job,
      after,
    )
    // Billed before this field existed, or it would have one: the first
    // payment on it writes that down, whatever it does to the status, because
    // the payment itself would otherwise be the only reason it says Invoiced
    // and taking it back would take the invoice with it.
    const billedBefore =
      job.status === 'invoiced' &&
      job.invoicedAt === undefined &&
      before.afterWork === 0
    if (status !== job.status || finishing || billedBefore) {
      await followMoney(ctx, job, status, {
        ...(finishing ? { completedAt: now } : {}),
        ...(billedBefore ? { invoicedAt: now } : {}),
      })
    }

    await recordJobWrite(ctx, env, job, 'payment.record', { paymentId })
    return { paymentId, status }
  },
})

/** Taking a payment back. The row stays, saying who did it; the status follows. */
export const remove = mutation({
  args: {
    businessId: v.id('businesses'),
    jobId: v.id('jobs'),
    paymentId: v.id('payments'),
  },
  handler: async (ctx, { businessId, jobId, paymentId }) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)
    const payment = await ctx.db.get(paymentId)
    if (!payment || payment.jobId !== job._id) {
      throw new ConvexError('NOT_FOUND')
    }
    if (payment.removedAt !== undefined) return { status: job.status }
    if (!mayRemovePayment(env.actor.acting, payment)) {
      throw new ConvexError('NO_ACCESS')
    }

    await ctx.db.patch(payment._id, {
      removedAt: Date.now(),
      removedBy: env.actor.acting._id,
    })

    // Only a status the money put there comes undone. A deposit coming off a
    // Booked job leaves it Booked, and someone's own choice of Completed is
    // not second-guessed by a payment leaving.
    let status = job.status
    if (job.status === 'paid' || job.status === 'invoiced') {
      status = statusFromMoney(job, await moneyOnJob(ctx, job._id))
      if (status !== job.status) await followMoney(ctx, job, status)
    }

    await recordJobWrite(ctx, env, job, 'payment.remove', { paymentId })
    return { status }
  },
})

/**
 * Billed. As the last step of a visit it finishes the job, so it asks the
 * report policy as Completed would. Nothing to bill if a deposit covers it.
 */
export const markInvoiced = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)
    if (job.status === 'cancelled') {
      throw new ConvexError('PAYMENT_NOT_ALLOWED')
    }
    if (job.status === 'paid') throw new ConvexError('JOB_PAID')
    if (job.status === 'invoiced') {
      // Part-paid or older, it never said it was billed. Now it has.
      if (job.invoicedAt === undefined) {
        await ctx.db.patch(job._id, { invoicedAt: Date.now() })
        await recordJobWrite(ctx, env, job, 'job.invoice')
      }
      return { status: job.status }
    }

    if (entersDone(job.status, 'invoiced')) await assertReportIssued(ctx, job)
    const now = Date.now()
    const status = finishedStatus(
      'invoiced',
      job.price,
      await moneyOnJob(ctx, job._id),
    )
    await followMoney(ctx, job, status, {
      invoicedAt: now,
      ...(DONE_STATUSES.has(job.status) ? {} : { completedAt: now }),
    })
    await recordJobWrite(ctx, env, job, 'job.invoice')
    return { status }
  },
})

/**
 * Says whose money it is, changes that, or, with null, says it was nobody
 * else's after all. Whoever may edit the job may, so nobody has to go through
 * the owner to write down what they agreed.
 */
export const setHandOver = mutation({
  args: {
    businessId: v.id('businesses'),
    jobId: v.id('jobs'),
    paymentId: v.id('payments'),
    handOver: v.union(v.null(), handOverArg),
  },
  handler: async (ctx, { businessId, jobId, paymentId, handOver }) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)
    const payment = await ctx.db.get(paymentId)
    if (
      !payment ||
      payment.jobId !== job._id ||
      payment.removedAt !== undefined
    ) {
      throw new ConvexError('NOT_FOUND')
    }
    await ctx.db.patch(payment._id, {
      handOver:
        handOver === null
          ? undefined
          : await makeHandOver(
              ctx,
              businessId,
              env.actor.acting._id,
              payment,
              handOver,
            ),
    })
    await recordJobWrite(ctx, env, job, 'payment.handOver', { paymentId })
  },
})

/**
 * Ticks hand-overs off, or with `done: false` puts the tick back. By the
 * payments the person saw and no others: money marked a minute ago is not in
 * the envelope yet.
 */
export const setHandOverDone = mutation({
  args: {
    businessId: v.id('businesses'),
    paymentIds: v.array(v.id('payments')),
    done: v.boolean(),
  },
  handler: async (ctx, { businessId, paymentIds, done }) => {
    const env = await requireWriteActor(ctx, businessId)
    const acting = env.actor.acting
    const now = Date.now()

    for (const paymentId of paymentIds) {
      const payment = await ctx.db.get(paymentId)
      if (!payment || payment.businessId !== businessId) {
        throw new ConvexError('NOT_FOUND')
      }
      const mark = payment.handOver
      if (!mark || payment.removedAt !== undefined) continue
      if (!mayTickHandOver(acting, mark)) throw new ConvexError('NO_ACCESS')
      if (done === (mark.doneAt !== undefined)) continue

      await ctx.db.patch(payment._id, {
        handOver: {
          from: mark.from,
          to: mark.to,
          ...(mark.note ? { note: mark.note } : {}),
          markedBy: mark.markedBy,
          markedAt: mark.markedAt,
          ...(done ? { doneAt: now, doneBy: acting._id } : {}),
        },
      })
      await recordOnBehalf(ctx, writeAttribution(env.actor), {
        businessId,
        action: 'payment.handOverDone',
        entityType: 'payments',
        entityId: payment._id,
        meta: { done },
      })
    }
  },
})

async function memberNames(
  ctx: QueryCtx,
  ids: ReadonlyArray<Id<'memberships'> | undefined>,
): Promise<Map<Id<'memberships'>, string | null>> {
  const unique = [...new Set(ids)].filter((id) => id !== undefined)
  const entries = await Promise.all(
    unique.map(async (id) => {
      const member = await ctx.db.get(id)
      const user = member
        ? await authComponent.getAnyUserById(ctx, member.userId)
        : null
      return [id, user?.name ?? null] as const
    }),
  )
  return new Map(entries)
}

/** Enough earlier work at one address to find a payment, if it has any. */
const LAST_TIME_JOBS = 12

/**
 * How the client paid at this address last time, as a hint beside the
 * question and never an answer to it: nothing is chosen for the technician.
 * Only from work this person may see, as everything else on the sheet is.
 */
async function paidLastTime(
  ctx: QueryCtx,
  scope: Parameters<typeof jobInScope>[1],
  job: Doc<'jobs'>,
) {
  const earlier = await ctx.db
    .query('jobs')
    .withIndex('by_property', (q) => q.eq('propertyId', job.propertyId))
    .order('desc')
    // Projections are the newest rows here, and would fill any fixed read.
    .filter((q) =>
      q.and(
        q.eq(q.field('deletedAt'), undefined),
        q.or(
          q.eq(q.field('status'), 'paid'),
          q.eq(q.field('status'), 'invoiced'),
        ),
      ),
    )
    .take(LAST_TIME_JOBS)

  for (const other of earlier) {
    if (other._id === job._id) continue
    if (!(await jobInScope(ctx, scope, other))) continue
    const last = (await paymentsOfJob(ctx, other._id))
      .filter((row) => row.removedAt === undefined && row.method !== 'noCharge')
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .at(0)
    if (last) return { method: last.method, receivedAt: last.receivedAt }
  }
  return null
}

/**
 * A job's payments, for whoever may see the job. Amounts stay zeroed with
 * `pricesHidden` beside them, as a job's price does (lib/prices.ts); how and
 * when it was paid is not a price, and a technician who took the cash needs
 * to see that they did.
 */
export const forJob = query({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const env = await requireActor(ctx, businessId)
    const job = unbinned(await ctx.db.get(jobId))
    if (!job || job.businessId !== businessId) return null
    // Null rather than an error, as `jobs.get`: someone else's job must look
    // the same as one that does not exist.
    if (!(await jobInScope(ctx, env.scope, job))) return null

    const rows = await paymentsOfJob(ctx, job._id)
    rows.sort((a, b) => a.receivedAt - b.receivedAt)
    const names = await memberNames(
      ctx,
      rows.flatMap((row) => [
        row.recordedBy,
        row.removedBy,
        row.handOver?.from,
        row.handOver?.to,
      ]),
    )
    const hidden = hidePrices(env.caps)
    const canEdit = await mayEditThisJob(ctx, env.actor, job)
    const money = moneyOf(rows)

    const toWire = (row: Doc<'payments'>) => ({
      _id: row._id,
      method: row.method,
      amount: hidden ? 0 : row.amount,
      receivedAt: row.receivedAt,
      recordedAt: row.recordedAt,
      recordedBy: row.recordedBy,
      recordedByName: names.get(row.recordedBy) ?? null,
      reference: row.reference ?? null,
      deposit: row.deposit === true,
      dayOnly: row.dayOnly === true,
      handOver: row.handOver
        ? {
            from: row.handOver.from,
            fromName: names.get(row.handOver.from) ?? null,
            to: row.handOver.to,
            toName: names.get(row.handOver.to) ?? null,
            note: row.handOver.note ?? null,
            doneAt: row.handOver.doneAt ?? null,
            canTick:
              row.removedAt === undefined &&
              mayTickHandOver(env.actor.acting, row.handOver),
          }
        : null,
      removedAt: row.removedAt ?? null,
      removedByName: row.removedBy ? (names.get(row.removedBy) ?? null) : null,
      canRemove:
        canEdit &&
        row.removedAt === undefined &&
        mayRemovePayment(env.actor.acting, row),
    })

    return {
      payments: rows.filter((r) => r.removedAt === undefined).map(toWire),
      removed: rows.filter((r) => r.removedAt !== undefined).map(toWire),
      paid: hidden ? 0 : money.paid,
      // A cancelled job is not owed anything, whatever was taken on it.
      owing:
        hidden || job.status === 'cancelled' ? 0 : owingOn(job.price, money),
      // A price corrected below what came in: someone is owed that back.
      overpaid: hidden ? 0 : Math.max(0, money.paid - job.price),
      settled: isSettled(job.price, money),
      pricesHidden: hidden,
      lastTime:
        job.status === 'paid' || job.status === 'cancelled'
          ? null
          : await paidLastTime(ctx, env.scope, job),
    }
  },
})

/** The owner's money at a glance, scoped as the schedule is. */
export const summary = query({
  args: {
    businessId: v.id('businesses'),
    // "2026-11", the month Paid this month adds up, sent by the page from
    // its own day: a query's answer is kept until its data changes, so one
    // that read the clock would go on saying October into November.
    month: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, month }) => {
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return null
    if (month !== undefined && !MONTH_KEY.test(month)) {
      throw new ConvexError('INVALID_DAY')
    }
    const monthDay = month ? `${month}-01` : todayKeyInZone(business.timezone)

    const jobs = await jobsInScope(ctx, env.listScope, { businessId })
    const { handOvers, byPerson, ...figures } = await moneyFigures(
      ctx,
      env.caps,
      businessId,
      jobs,
      monthBoundsInZone(monthDay, business.timezone),
      env.actor.acting._id,
      countsFromOf(business),
    )
    const names = await memberNames(ctx, [
      ...handOvers.flatMap((pair) => [pair.from, pair.to]),
      ...byPerson.map((one) => one.membershipId),
    ])
    const viewer = env.actor.acting._id
    return {
      ...figures,
      // The person looking first, then by name.
      byPerson: byPerson
        .map((one) => ({
          ...one,
          name: names.get(one.membershipId) ?? null,
        }))
        .sort(
          (a, b) =>
            Number(b.membershipId === viewer) -
              Number(a.membershipId === viewer) ||
            (a.name ?? '').localeCompare(b.name ?? ''),
        ),
      toHandOver: handOvers.map((pair) => ({
        ...pair,
        fromName: names.get(pair.from) ?? null,
        toName: names.get(pair.to) ?? null,
        canTick: mayTickHandOver(env.actor.acting, pair),
      })),
      pricesHidden: hidePrices(env.caps),
      scope: wireScope(env.listScope),
      // The day older work stops being counted, if there is one (0 is the
      // owner's "every job"), and whether this person may move it.
      countsFrom: business.paymentsFrom ? business.paymentsFrom : null,
      canMoveCountsFrom: env.caps['business.manage'],
    }
  },
})

/**
 * Where the Payments page counts from: a day, "YYYY-MM-DD" in the business's
 * zone, or null for every job there has been. Only the owner's to say, as
 * any setting of the business is. Nothing about a job changes: this decides
 * only which ones the page adds up.
 */
export const setCountsFrom = mutation({
  args: {
    businessId: v.id('businesses'),
    day: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { businessId, day }) => {
    const env = await requireWriteActor(ctx, businessId)
    requireCapability(env, 'business.manage')
    const business = await ctx.db.get(businessId)
    if (!business) throw new ConvexError('NOT_FOUND')

    // 0 is "every job", kept apart from never having been set, which the
    // migration would set again.
    let from = 0
    if (day !== null) {
      // A day still to come would hide work already done.
      if (!isDayKey(day) || day > todayKeyInZone(business.timezone)) {
        throw new ConvexError('INVALID_DAY')
      }
      from = startOfDayInZone(day, business.timezone)
    }
    if (from === business.paymentsFrom) return

    await ctx.db.patch(businessId, { paymentsFrom: from })
    await recordOnBehalf(ctx, writeAttribution(env.actor), {
      businessId,
      action: 'business.update',
      entityType: 'businesses',
      entityId: businessId,
      meta: { fields: ['paymentsFrom'], day },
    })
  },
})

/** Each job's client and suburb, reading each property once. */
async function placesOf(ctx: QueryCtx, jobs: ReadonlyArray<Doc<'jobs'>>) {
  const byProperty = new Map<
    Id<'properties'>,
    Promise<{ clientName: string; suburb: string }>
  >()
  const placeOf = (propertyId: Id<'properties'>) => {
    const inFlight = byProperty.get(propertyId)
    if (inFlight) return inFlight
    const pending = (async () => {
      const property = await ctx.db.get(propertyId)
      const client = property ? await ctx.db.get(property.clientId) : null
      return { clientName: client?.name ?? '', suburb: property?.suburb ?? '' }
    })()
    byProperty.set(propertyId, pending)
    return pending
  }
  return new Map(
    await Promise.all(
      jobs.map(
        async (job) => [job._id, await placeOf(job.propertyId)] as const,
      ),
    ),
  )
}

/** More than anyone chases at once. The oldest come first, so none is lost. */
export const OUTSTANDING_ROWS = 200

/**
 * How many waiting jobs one list reads, the uncounted older ones included,
 * before it stops and says there are more.
 */
const OUTSTANDING_READ = 3000

/**
 * The jobs behind To bill or Owing, oldest visit first: the list to chase.
 * Counted as the figures are (`moneyFigures`): work from the day the business
 * counts from, in the caller's scope, and with `person` only the jobs they
 * lead, whose balance is theirs.
 */
export const outstanding = query({
  args: {
    businessId: v.id('businesses'),
    list: v.union(v.literal('toBill'), v.literal('owing')),
    person: v.optional(v.id('memberships')),
  },
  handler: async (ctx, { businessId, list, person }) => {
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return null
    const from = countsFromOf(business)
    const status = list === 'owing' ? 'invoiced' : 'completed'
    const hidden = hidePrices(env.caps)
    const nobody = { rows: [], more: false, pricesHidden: hidden }

    let jobs: Array<Doc<'jobs'>> = []
    let more = false
    if (env.listScope.kind === 'business') {
      if (person !== undefined) {
        const member = await ctx.db.get(person)
        if (!member || member.businessId !== businessId) return nobody
      }
      // Read by status, so years of paid work cost nothing here. Not from
      // the day, though: a visit booked before it and done after it counts,
      // so the older ones waiting are passed over here instead (`counts`).
      const waiting = (
        person === undefined
          ? ctx.db
              .query('jobs')
              .withIndex('by_businessId_and_status_and_scheduledAt', (q) =>
                q.eq('businessId', businessId).eq('status', status),
              )
          : ctx.db
              .query('jobs')
              .withIndex(
                'by_assignedMembershipId_and_status_and_scheduledAt',
                (q) =>
                  q.eq('assignedMembershipId', person).eq('status', status),
              )
      ).filter((q) => q.eq(q.field('deletedAt'), undefined))
      let looked = 0
      for await (const job of waiting) {
        if (counts(job, from)) jobs.push(job)
        looked += 1
        if (jobs.length > OUTSTANDING_ROWS || looked >= OUTSTANDING_READ) {
          more = true
          break
        }
      }
    } else {
      // The same jobs the figures add up, the shared ones included.
      jobs = (await jobsInScope(ctx, env.listScope, { businessId }))
        .filter(
          (job) =>
            job.status === status &&
            counts(job, from) &&
            (person === undefined || job.assignedMembershipId === person),
        )
        .sort((a, b) => a.scheduledAt - b.scheduledAt)
      more = jobs.length > OUTSTANDING_ROWS
    }

    const shown = jobs.slice(0, OUTSTANDING_ROWS)
    const places = await placesOf(ctx, shown)
    const names = await memberNames(
      ctx,
      shown.map((job) => job.assignedMembershipId),
    )
    const rows = await Promise.all(
      shown.map(async (job) => {
        const money = await moneyOnJob(ctx, job._id)
        return {
          _id: job._id,
          jobNumber: job.jobNumber ?? null,
          jobType: job.jobType,
          scheduledAt: job.scheduledAt,
          completedAt: job.completedAt ?? null,
          invoicedAt: job.invoicedAt ?? null,
          clientName: places.get(job._id)?.clientName ?? '',
          suburb: places.get(job._id)?.suburb ?? '',
          price: hidden ? 0 : job.price,
          paid: hidden ? 0 : money.paid,
          owing: hidden ? 0 : owingOn(job.price, money),
          lead: job.assignedMembershipId,
          leadName: names.get(job.assignedMembershipId) ?? null,
        }
      }),
    )
    return { rows, more, pricesHidden: hidden }
  },
})

/** Most of a client's sites read for their sheet, as `clients.summary` reads
 * them (none has come close). */
const CLIENT_SITES = 50

/**
 * Most of one client's billed or finished jobs looked at for their sheet: far
 * more than any client waits on. Each costs a read for its payments and maybe
 * one more for whether the caller may see it, well inside a query's reads.
 */
const CLIENT_JOBS_READ = 500

/** Most of those jobs the sheet lists, Owing first. */
export const CLIENT_ROWS = 50

/**
 * What one client owes, for their sheet: Owing (billed, less what has come
 * in) and To bill (done, not yet billed, less any deposit), with the jobs
 * behind them, oldest first. Counted as the Payments page counts them
 * (`moneyFigures`): work from the day the business counts from, and nothing
 * in the Recycle bin.
 *
 * Over the jobs the caller may open (`scope`, not the list's view): a client's
 * sheet is one record, as their history is. Somebody who cannot see prices is
 * told nothing, not even how many: one job beside a hidden total is its price.
 */
export const forClient = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireActor(ctx, businessId)
    const client = unbinned(await ctx.db.get(clientId))
    if (!client || client.businessId !== businessId) return null
    if (!inClientScope(await visibleClientIds(ctx, env), clientId)) return null
    const business = await ctx.db.get(businessId)
    if (!business) return null
    if (hidePrices(env.caps)) {
      return {
        pricesHidden: true as const,
        owing: null,
        toBill: null,
        rows: [],
        more: false,
      }
    }
    const from = countsFromOf(business)

    const sites = (
      await ctx.db
        .query('properties')
        .withIndex('by_client', (q) => q.eq('clientId', clientId))
        .filter((q) => q.eq(q.field('deletedAt'), undefined))
        .take(CLIENT_SITES)
    ).filter((site) => site.businessId === businessId)

    // Only the jobs waiting on money: years of paid visits cost nothing.
    let more = false
    const waiting: Array<Doc<'jobs'>> = []
    for (const site of sites) {
      const room = CLIENT_JOBS_READ - waiting.length
      if (room <= 0) {
        more = true
        break
      }
      const found = await ctx.db
        .query('jobs')
        .withIndex('by_property', (q) => q.eq('propertyId', site._id))
        .filter((q) =>
          q.and(
            q.eq(q.field('deletedAt'), undefined),
            q.or(
              q.eq(q.field('status'), 'completed'),
              q.eq(q.field('status'), 'invoiced'),
            ),
          ),
        )
        .take(room + 1)
      if (found.length > room) more = true
      waiting.push(...found.slice(0, room))
    }

    const counted: Array<Doc<'jobs'>> = []
    for (const job of waiting) {
      if (job.businessId !== businessId || !counts(job, from)) continue
      if (await jobInScope(ctx, env.scope, job)) counted.push(job)
    }
    const balances = await Promise.all(
      counted.map(async (job) => {
        const money = await moneyOnJob(ctx, job._id)
        return { job, paid: money.paid, owed: owingOn(job.price, money) }
      }),
    )
    const doneAt = (job: Doc<'jobs'>) => job.completedAt ?? job.scheduledAt
    const owing = balances
      .filter(({ job }) => job.status === 'invoiced')
      .sort((a, b) => billedAt(a.job) - billedAt(b.job))
    const toBill = balances
      .filter(({ job }) => job.status === 'completed')
      .sort((a, b) => doneAt(a.job) - doneAt(b.job))
    const total = (list: typeof balances) =>
      list.reduce((sum, { owed }) => sum + owed, 0)
    const listed = [
      ...owing.map((balance) => ({ ...balance, list: 'owing' as const })),
      ...toBill.map((balance) => ({ ...balance, list: 'toBill' as const })),
    ]

    return {
      pricesHidden: false as const,
      owing: {
        count: owing.length,
        value: total(owing),
        // How long the oldest bill has waited, for "billed 34 days ago".
        since: owing.length > 0 ? billedAt(owing[0].job) : null,
      },
      toBill: { count: toBill.length, value: total(toBill) },
      rows: listed.slice(0, CLIENT_ROWS).map(({ job, paid, owed, list }) => ({
        _id: job._id,
        list,
        jobNumber: job.jobNumber ?? null,
        jobType: job.jobType,
        scheduledAt: job.scheduledAt,
        completedAt: job.completedAt ?? null,
        invoicedAt: job.invoicedAt ?? null,
        price: job.price,
        paid,
        owed,
      })),
      // Some not listed, or not read at all.
      more: more || listed.length > CLIENT_ROWS,
    }
  },
})

/** "2026-11": a calendar month. */
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * More payments than a business takes in a month; the newest if not. Each
 * costs a read or three (its job, its place), and a query may only make so
 * many.
 */
export const PAID_ROWS = 1000

/** How many earlier payments are looked through for one this caller sees. */
const EARLIER_LOOK = 200

/**
 * Money that came in during one calendar month in the business's zone, newest
 * first, with its totals by method and by person, for checking against the
 * cash tin, the EFTPOS settlement and the bank. Every month is kept, so
 * nothing disappears before it has been reconciled.
 *
 * Counted as `moneyFigures` counts Paid this month: payments on jobs in the
 * caller's scope, each one the person's it is marked for, else the lead's.
 * No charge moved no money, and is left out.
 */
export const paidIn = query({
  args: {
    businessId: v.id('businesses'),
    // This month when absent.
    month: v.optional(v.string()),
    person: v.optional(v.id('memberships')),
  },
  handler: async (ctx, { businessId, month, person }) => {
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return null
    const zone = business.timezone
    const thisMonth = todayKeyInZone(zone).slice(0, 7)
    const key = month ?? thisMonth
    if (!MONTH_KEY.test(key)) throw new ConvexError('INVALID_DAY')
    const bounds = monthBoundsInZone(`${key}-01`, zone)
    const hidden = hidePrices(env.caps)

    const read = await ctx.db
      .query('payments')
      .withIndex('by_businessId_and_receivedAt', (q) =>
        q
          .eq('businessId', businessId)
          .gte('receivedAt', bounds.start)
          .lt('receivedAt', bounds.end),
      )
      .order('desc')
      .take(PAID_ROWS + 1)

    const jobsById = new Map<Id<'jobs'>, Promise<Doc<'jobs'> | null>>()
    const visibleJob = (jobId: Id<'jobs'>) => {
      const inFlight = jobsById.get(jobId)
      if (inFlight) return inFlight
      const pending = (async () => {
        const job = unbinned(await ctx.db.get(jobId))
        if (!job || job.businessId !== businessId) return null
        return (await jobInScope(ctx, env.listScope, job)) ? job : null
      })()
      jobsById.set(jobId, pending)
      return pending
    }

    const kept: Array<{ row: Doc<'payments'>; job: Doc<'jobs'> }> = []
    for (const row of read.slice(0, PAID_ROWS)) {
      if (row.removedAt !== undefined || row.amount === 0) continue
      const job = await visibleJob(row.jobId)
      if (!job) continue
      if (person !== undefined && whoseMoney(row, job) !== person) continue
      kept.push({ row, job })
    }

    const places = await placesOf(
      ctx,
      kept.map(({ job }) => job),
    )
    const names = await memberNames(
      ctx,
      kept.flatMap(({ row, job }) => [
        whoseMoney(row, job),
        row.recordedBy,
        row.handOver?.to,
      ]),
    )

    const methods = new Map<
      Doc<'payments'>['method'],
      { value: number; count: number }
    >()
    const people = new Map<Id<'memberships'>, number>()
    for (const { row, job } of kept) {
      const method = methods.get(row.method) ?? { value: 0, count: 0 }
      methods.set(row.method, {
        value: method.value + row.amount,
        count: method.count + 1,
      })
      const whose = whoseMoney(row, job)
      people.set(whose, (people.get(whose) ?? 0) + row.amount)
    }

    // Whether there is a month before this one worth stepping back to: one
    // with money in it that this caller would see, as this month is counted.
    // Past what is worth looking through, say there may be.
    let hasEarlier = false
    let looked = 0
    for await (const row of ctx.db
      .query('payments')
      .withIndex('by_businessId_and_receivedAt', (q) =>
        q.eq('businessId', businessId).lt('receivedAt', bounds.start),
      )
      .order('desc')) {
      looked += 1
      if (looked > EARLIER_LOOK) {
        hasEarlier = true
        break
      }
      if (row.removedAt !== undefined || row.amount === 0) continue
      const job = await visibleJob(row.jobId)
      if (!job) continue
      if (person !== undefined && whoseMoney(row, job) !== person) continue
      hasEarlier = true
      break
    }

    return {
      month: key,
      thisMonth: key === thisMonth,
      hasEarlier,
      total: redactTotal(
        env.caps,
        kept.reduce((sum, { row }) => sum + row.amount, 0),
      ),
      byMethod: hidden
        ? []
        : [...methods.entries()]
            .map(([method, { value, count }]) => ({ method, value, count }))
            .sort((a, b) => b.value - a.value),
      byPerson: hidden
        ? []
        : [...people.entries()]
            .map(([membershipId, value]) => ({
              membershipId,
              name: names.get(membershipId) ?? null,
              value,
            }))
            .sort((a, b) => b.value - a.value),
      rows: kept.map(({ row, job }) => {
        const place = places.get(job._id)
        const whose = whoseMoney(row, job)
        return {
          _id: row._id,
          jobId: job._id,
          jobNumber: job.jobNumber ?? null,
          clientName: place?.clientName ?? '',
          method: row.method,
          amount: hidden ? 0 : row.amount,
          receivedAt: row.receivedAt,
          dayKey: dayKeyOf(row.receivedAt, zone),
          reference: row.reference ?? null,
          deposit: row.deposit === true,
          dayOnly: row.dayOnly === true,
          whose,
          whoseName: names.get(whose) ?? null,
          // Still to be passed on, and to whom.
          handOverTo:
            row.handOver && row.handOver.doneAt === undefined
              ? (names.get(row.handOver.to) ?? null)
              : null,
        }
      }),
      more: read.length > PAID_ROWS,
      pricesHidden: hidden,
    }
  },
})

/**
 * Whose money a payment is, as the figures split it: the person it is marked
 * for, else whoever leads the job.
 */
function whoseMoney(
  row: Pick<Doc<'payments'>, 'handOver'>,
  job: Pick<Doc<'jobs'>, 'assignedMembershipId'>,
): Id<'memberships'> {
  return row.handOver?.to ?? job.assignedMembershipId
}
