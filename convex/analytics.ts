import { ConvexError, v } from 'convex/values'
import { query } from './_generated/server'
import { authComponent } from './auth'
import {
  addDaysToKey,
  dayKeyOf,
  startOfDayInZone,
  todayKeyInZone,
} from './lib/dates'
import { splitJobTypes } from './lib/jobTypes'
import { jobsInRange } from './jobs'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import type { RowScope } from './lib/capabilities'
import { requireActor } from './lib/actor'
import { jobsInScope, wireScope } from './lib/jobScope'
import { DONE_STATUSES, isCountedJob } from './lib/jobStatus'
import {
  AGE_BANDS,
  OLD_AFTER_DAYS,
  ageBandOf,
  bucketIndex,
  bucketStarts,
  comparisonRange,
  daysBetween,
  grainFor,
  isRealDayKey,
  isValidRange,
  rangeDays,
} from './lib/analyticsRange'
import type { DayRange } from './lib/analyticsRange'
import { hidePrices, redactTotal } from './lib/prices'
import { UNASSIGNED_COLOUR } from './lib/colours'
import { alsoGoingInWindow, everyoneOn } from './lib/jobPeople'

/** Shifts a `"YYYY-MM"` key by `offset` months (either direction). */
function monthKeyOffset(monthKey: string, offset: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  const total = year * 12 + (month - 1) + offset
  const y = Math.floor(total / 12)
  const m = (total % 12) + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

/**
 * Historical trend data for the Analytics page — a distinct concern from
 * `dashboard.summary`'s "today's operational snapshot", so it lives in its
 * own file rather than growing that one. One query, not several: everything
 * below is a single pass over one scoped `jobsInRange` read, matching the
 * "collect once, aggregate in memory" approach `dashboard.summary` and
 * `jobs.monthTeamLoad` already use at this app's scale.
 */
export const overview = query({
  args: { businessId: v.id('businesses'), months: v.optional(v.number()) },
  handler: async (ctx, { businessId, months: requested = 6 }) => {
    /**
     * Clamped to the three windows the UI offers, for every caller.
     *
     * It was free text. `months: 1` collapses the window to the current month,
     * and a month with one completed job makes `revenueByMonth` that job's
     * price to the cent — an aggregate that reconstructs the row it was
     * aggregating. Narrowing the window is the attack, so the window stops
     * being arbitrary.
     */
    const months = [3, 6, 12].includes(requested) ? requested : 6
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return null

    const currentMonthKey = todayKeyInZone(business.timezone).slice(0, 7)
    const startMonthKey = monthKeyOffset(currentMonthKey, -(months - 1))
    const afterEndMonthKey = monthKeyOffset(currentMonthKey, 1)
    const from = startOfDayInZone(`${startMonthKey}-01`, business.timezone)
    const to = startOfDayInZone(`${afterEndMonthKey}-01`, business.timezone)
    const monthKeys = Array.from({ length: months }, (_, i) =>
      monthKeyOffset(startMonthKey, i),
    )

    // `jobsInRange` already excludes cancelled jobs, so a true cancellation
    // rate would need a second, unfiltered scan — not worth it for a first
    // cut. `statusBreakdown` below can therefore show every status except
    // cancelled.
    const jobs = await jobsInRange(ctx, env.listScope, businessId, from, to)
    // Who was on each job beside its lead: a shared job is in each person's
    // workload (lib/jobPeople.ts), and in the totals once.
    const people = await alsoGoingInWindow(ctx, businessId, from, to)

    const revenueByMonth = new Map(monthKeys.map((k) => [k, 0]))
    const volumeByMonth = new Map(monthKeys.map((k) => [k, 0]))
    const statusCounts = new Map<string, number>()
    const typeCounts = new Map<string, number>()
    const technicianCounts = new Map<Id<'memberships'>, number>()

    for (const job of jobs) {
      const monthKey = dayKeyOf(job.scheduledAt, business.timezone).slice(0, 7)
      volumeByMonth.set(monthKey, (volumeByMonth.get(monthKey) ?? 0) + 1)
      // Only earned money — a booked job hasn't happened yet, matching
      // `dashboard.summary`'s own awaitingInvoiceValue/invoicedThisMonth
      // semantics rather than inventing a third revenue definition.
      if (job.status === 'completed' || job.status === 'invoiced') {
        revenueByMonth.set(
          monthKey,
          (revenueByMonth.get(monthKey) ?? 0) + job.price,
        )
      }
      statusCounts.set(job.status, (statusCounts.get(job.status) ?? 0) + 1)
      // A job for several services counts once under each of them, so a bar
      // is how many jobs included that service (lib/jobTypes.ts). The raw
      // label stands in for one with no service at all.
      const services = splitJobTypes(job.jobType)
      for (const service of services.length > 0 ? services : [job.jobType]) {
        typeCounts.set(service, (typeCounts.get(service) ?? 0) + 1)
      }
      for (const membershipId of everyoneOn(job, people)) {
        technicianCounts.set(
          membershipId,
          (technicianCounts.get(membershipId) ?? 0) + 1,
        )
      }
    }

    // `jobType` is free text (§ schema), so a business's accumulated
    // vocabulary is unbounded — cap the chart to what Miller's Law allows
    // regardless of how many distinct strings a business has typed over time.
    const sortedTypes = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])
    const topTypes = sortedTypes.slice(0, 5)
    const otherTypeCount = sortedTypes
      .slice(5)
      .reduce((sum, [, c]) => sum + c, 0)

    const technicianLoad = await Promise.all(
      [...technicianCounts.entries()].map(async ([membershipId, count]) => {
        const assignee = await ctx.db.get(membershipId)
        const user = assignee
          ? await authComponent.getAnyUserById(ctx, assignee.userId)
          : null
        return {
          membershipId,
          name: user?.name ?? 'Unassigned',
          colour: assignee?.colour ?? UNASSIGNED_COLOUR,
          count,
        }
      }),
    )
    technicianLoad.sort((a, b) => b.count - a.count)

    return {
      // Drives which charts render client-side — an assignee-scoped
      // subcontractor's technicianLoad always degenerates to one row
      // (themselves), so that chart is skipped entirely rather than shown
      // as a meaningless single bar.
      scope: wireScope(env.listScope),
      months: monthKeys,
      // Null rather than zero: a total of zero is a claim about the business,
      // and this is the absence of one.
      revenueByMonth: monthKeys.map((k) => ({
        month: k,
        value: redactTotal(env.caps, revenueByMonth.get(k) ?? 0),
      })),
      pricesHidden: hidePrices(env.caps),
      volumeByMonth: monthKeys.map((k) => ({
        month: k,
        value: volumeByMonth.get(k) ?? 0,
      })),
      statusBreakdown: [...statusCounts.entries()].map(([status, count]) => ({
        status,
        count,
      })),
      typeBreakdown: [
        ...topTypes.map(([jobType, count]) => ({ jobType, count })),
        ...(otherTypeCount > 0
          ? [{ jobType: 'Other', count: otherTypeCount }]
          : []),
      ],
      technicianLoad,
    }
  },
})

/** How far ahead "Booked ahead" looks, in days: four weeks. */
const AHEAD_DAYS = 28

/** Most finished, uninvoiced jobs one question reads, oldest first. Past it
 * the answer says it stopped (`more`), so a total is never quietly short. */
const UNINVOICED_READ = 2000

/** Most uninvoiced jobs the detail page lists, oldest first. */
const UNINVOICED_LISTED = 100

/** Most services the filter offers, most jobs first. */
const SERVICES_OFFERED = 12

const compareArg = v.union(
  v.literal('previous'),
  v.literal('year'),
  v.literal('none'),
)

type People = ReadonlyMap<Id<'jobs'>, ReadonlyArray<Id<'memberships'>>>

/** The services a job is for, or its raw label where it names none
 * (lib/jobTypes.ts): what a job counts under, and what the filter matches. */
function servicesOf(job: Doc<'jobs'>): Array<string> {
  const services = splitJobTypes(job.jobType)
  return services.length > 0 ? services : [job.jobType]
}

function isForService(job: Doc<'jobs'>, service: string | undefined): boolean {
  if (service === undefined) return true
  const wanted = service.trim().toLowerCase()
  return servicesOf(job).some((name) => name.toLowerCase() === wanted)
}

function isForPerson(
  job: Doc<'jobs'>,
  staff: Id<'memberships'> | undefined,
  people: People,
): boolean {
  return staff === undefined || everyoneOn(job, people).includes(staff)
}

/** Every job in scope on these days that someone booked: cancelled ones
 * too (they are counted, as cancelled), and no projected visit. */
async function jobsOn(
  ctx: QueryCtx,
  scope: RowScope,
  businessId: Id<'businesses'>,
  range: DayRange,
  timezone: string,
): Promise<{ jobs: Array<Doc<'jobs'>>; from: number; to: number }> {
  const from = startOfDayInZone(range.from, timezone)
  const to = startOfDayInZone(addDaysToKey(range.to, 1), timezone)
  const jobs = await jobsInScope(ctx, scope, { businessId, from, to })
  return { jobs: jobs.filter((job) => job.status !== 'recurring'), from, to }
}

type Totals = {
  revenue: number
  completed: number
  booked: number
  cancelled: number
}

function totalsOf(jobs: ReadonlyArray<Doc<'jobs'>>): Totals {
  const totals: Totals = { revenue: 0, completed: 0, booked: 0, cancelled: 0 }
  for (const job of jobs) {
    if (job.status === 'cancelled') {
      totals.cancelled += 1
      continue
    }
    totals.booked += 1
    // Earned money only, as the dashboard counts it: a booked job has not
    // happened yet.
    if (DONE_STATUSES.has(job.status)) {
      totals.completed += 1
      totals.revenue += job.price
    }
  }
  return totals
}

/**
 * Finished work nobody has invoiced, in scope, oldest first.
 *
 * The whole business reads it by status, so a long history costs nothing; a
 * narrower scope is one person's or one team's jobs, read as every list
 * reads them.
 */
async function uninvoicedInScope(
  ctx: QueryCtx,
  scope: RowScope,
  businessId: Id<'businesses'>,
): Promise<{ jobs: Array<Doc<'jobs'>>; more: boolean }> {
  if (scope.kind !== 'business') {
    const all = await jobsInScope(ctx, scope, { businessId })
    return {
      jobs: all.filter((job) => job.status === 'completed'),
      more: false,
    }
  }
  const jobs = await ctx.db
    .query('jobs')
    .withIndex('by_businessId_and_status_and_scheduledAt', (q) =>
      q.eq('businessId', businessId).eq('status', 'completed'),
    )
    .filter((f) => f.eq(f.field('deletedAt'), undefined))
    .take(UNINVOICED_READ + 1)
  return {
    jobs: jobs.slice(0, UNINVOICED_READ),
    more: jobs.length > UNINVOICED_READ,
  }
}

/** Who else was on these jobs, read over the days they span — only when a
 * person is being asked about, which is the only question it answers. */
async function peopleOn(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
  jobs: ReadonlyArray<Doc<'jobs'>>,
  staff: Id<'memberships'> | undefined,
): Promise<People> {
  if (staff === undefined || jobs.length === 0) return new Map()
  let from = Infinity
  let to = -Infinity
  for (const job of jobs) {
    from = Math.min(from, job.scheduledAt)
    to = Math.max(to, job.scheduledAt)
  }
  return alsoGoingInWindow(ctx, businessId, from, to + 1)
}

/** Days a finished job has waited for its invoice, as of `today`. */
function waitedDays(job: Doc<'jobs'>, today: string, timezone: string): number {
  const done = dayKeyOf(job.completedAt ?? job.scheduledAt, timezone)
  return Math.max(0, daysBetween(done, today))
}

function assertDays(range: DayRange, today: string): void {
  if (!isValidRange(range) || !isRealDayKey(today))
    throw new ConvexError('INVALID_RANGE')
}

/**
 * The Analytics page's overview: the figures for a range of days, the same
 * figures for the range it is compared with, a chart's worth of points for
 * both, the work booked ahead and the finished work not yet invoiced.
 *
 * The page says which days (`from`, `to`, and `today` for the two figures
 * that look from now), so nothing here reads a clock. A person who may not
 * see prices gets every count and no money (`redactTotal`), whatever range
 * they ask for.
 *
 * `overview` above stays until this page's frontend is live everywhere
 * (CLAUDE.md, "Ship the frontend and backend together").
 */
export const report = query({
  args: {
    businessId: v.id('businesses'),
    /** The range, as day keys in the business's calendar, both counted. */
    from: v.string(),
    to: v.string(),
    /** Today's day key there. */
    today: v.string(),
    compare: v.optional(compareArg),
    /** Narrow to one person's jobs: the whole business's view only. */
    staff: v.optional(v.id('memberships')),
    /** Narrow to jobs that include this service. */
    service: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { businessId, today, service } = args
    const range: DayRange = { from: args.from, to: args.to }
    assertDays(range, today)
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return null
    const timezone = business.timezone
    const scope = env.listScope
    // One person out of a list that is already one person's is no choice.
    const staff = scope.kind === 'business' ? args.staff : undefined

    const before = comparisonRange(range, args.compare ?? 'previous')
    const ahead: DayRange = {
      from: today,
      to: addDaysToKey(today, AHEAD_DAYS - 1),
    }
    const [now, then, coming, waiting] = await Promise.all([
      jobsOn(ctx, scope, businessId, range, timezone),
      before ? jobsOn(ctx, scope, businessId, before, timezone) : null,
      jobsOn(ctx, scope, businessId, ahead, timezone),
      uninvoicedInScope(ctx, scope, businessId),
    ])
    // Who was on each job beside its lead: a shared job is in each person's
    // figures (lib/jobPeople.ts), and in the totals once.
    const [nowPeople, thenPeople, comingPeople, waitingPeople] =
      await Promise.all([
        scope.kind === 'business'
          ? alsoGoingInWindow(ctx, businessId, now.from, now.to)
          : new Map<Id<'jobs'>, Array<Id<'memberships'>>>(),
        then && staff !== undefined
          ? alsoGoingInWindow(ctx, businessId, then.from, then.to)
          : new Map<Id<'jobs'>, Array<Id<'memberships'>>>(),
        staff !== undefined
          ? alsoGoingInWindow(ctx, businessId, coming.from, coming.to)
          : new Map<Id<'jobs'>, Array<Id<'memberships'>>>(),
        peopleOn(ctx, businessId, waiting.jobs, staff),
      ])

    const keep = (people: People) => (job: Doc<'jobs'>) =>
      isForService(job, service) && isForPerson(job, staff, people)

    // What each filter offers is counted among the jobs the OTHER filter
    // lets through, as on the Schedule: a choice's number is what choosing
    // it would show.
    const serviceCounts = new Map<string, { name: string; count: number }>()
    const personCounts = new Map<Id<'memberships'>, number>()
    for (const job of now.jobs) {
      if (!isCountedJob(job)) continue
      if (isForPerson(job, staff, nowPeople)) {
        for (const name of servicesOf(job)) {
          const key = name.toLowerCase()
          const seen = serviceCounts.get(key)
          if (seen) seen.count += 1
          else serviceCounts.set(key, { name, count: 1 })
        }
      }
      if (isForService(job, service)) {
        for (const membershipId of everyoneOn(job, nowPeople)) {
          personCounts.set(
            membershipId,
            (personCounts.get(membershipId) ?? 0) + 1,
          )
        }
      }
    }

    const current = now.jobs.filter(keep(nowPeople))
    const earlier = then ? then.jobs.filter(keep(thenPeople)) : null
    const totals = totalsOf(current)
    const beforeTotals = earlier ? totalsOf(earlier) : null

    const grain = grainFor(rangeDays(range))
    const starts = bucketStarts(range, grain)
    const points = starts.map((start) => ({
      start,
      revenue: 0,
      completed: 0,
      beforeRevenue: 0,
      beforeCompleted: 0,
    }))
    const plot = (
      jobs: ReadonlyArray<Doc<'jobs'>>,
      within: DayRange,
      which: 'now' | 'before',
    ) => {
      for (const job of jobs) {
        if (!DONE_STATUSES.has(job.status)) continue
        const dayKey = dayKeyOf(job.scheduledAt, timezone)
        // A range and the one before it are the same number of days, but a
        // month can be a day longer than the one before: past the last
        // point is the last point.
        const at = Math.min(
          Math.max(0, bucketIndex(within, grain, dayKey)),
          points.length - 1,
        )
        if (which === 'now') {
          points[at].revenue += job.price
          points[at].completed += 1
        } else {
          points[at].beforeRevenue += job.price
          points[at].beforeCompleted += 1
        }
      }
    }
    plot(current, range, 'now')
    if (earlier && before) plot(earlier, before, 'before')

    const booked = coming.jobs
      .filter(keep(comingPeople))
      .filter((job) => job.status === 'pending' || job.status === 'booked')
    const unbilled = waiting.jobs.filter(keep(waitingPeople))
    const old = unbilled.filter(
      (job) => waitedDays(job, today, timezone) > OLD_AFTER_DAYS,
    )
    const sum = (jobs: ReadonlyArray<Doc<'jobs'>>) =>
      jobs.reduce((total, job) => total + job.price, 0)

    const people =
      scope.kind === 'business'
        ? await Promise.all(
            [...personCounts.entries()].map(async ([membershipId, count]) => {
              const member = await ctx.db.get(membershipId)
              const user = member
                ? await authComponent.getAnyUserById(ctx, member.userId)
                : null
              return {
                membershipId,
                name: user?.name ?? 'Unassigned',
                colour: member?.colour ?? UNASSIGNED_COLOUR,
                count,
              }
            }),
          )
        : []
    people.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

    const money = (cents: number) => redactTotal(env.caps, cents)
    const wire = (t: Totals) => ({
      revenue: money(t.revenue),
      completed: t.completed,
      booked: t.booked,
      cancelled: t.cancelled,
      averageJob: money(
        // To the dollar: an average to the cent is a precision nobody has.
        t.completed > 0 ? Math.round(t.revenue / t.completed / 100) * 100 : 0,
      ),
    })

    return {
      scope: wireScope(scope),
      pricesHidden: hidePrices(env.caps),
      range,
      comparison: before,
      grain,
      totals: wire(totals),
      before: beforeTotals ? wire(beforeTotals) : null,
      series: points.map((point) => ({
        start: point.start,
        revenue: money(point.revenue),
        completed: point.completed,
        beforeRevenue: before ? money(point.beforeRevenue) : null,
        beforeCompleted: before ? point.beforeCompleted : null,
      })),
      bookedAhead: {
        days: AHEAD_DAYS,
        count: booked.length,
        value: money(sum(booked)),
      },
      // The counts travel with the values, as on the dashboard: one job
      // waiting beside a hidden total would say its price.
      uninvoiced: {
        count: money(unbilled.length),
        value: money(sum(unbilled)),
        oldCount: money(old.length),
        oldValue: money(sum(old)),
        oldAfterDays: OLD_AFTER_DAYS,
        more: waiting.more,
      },
      services: [...serviceCounts.values()]
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, SERVICES_OFFERED),
      people,
    }
  },
})

/**
 * Finished work not yet invoiced, by how long it has waited: the page behind
 * the overview's "Awaiting invoice". Every such job in scope, whatever range
 * the overview is on — work is owed until it is billed — in four bands, with
 * the oldest listed so they can be opened and invoiced.
 */
export const uninvoiced = query({
  args: {
    businessId: v.id('businesses'),
    today: v.string(),
    staff: v.optional(v.id('memberships')),
    service: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, today, service, ...args }) => {
    if (!isRealDayKey(today)) throw new ConvexError('INVALID_RANGE')
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return null
    const scope = env.listScope
    const staff = scope.kind === 'business' ? args.staff : undefined

    const waiting = await uninvoicedInScope(ctx, scope, businessId)
    const people = await peopleOn(ctx, businessId, waiting.jobs, staff)
    const jobs = waiting.jobs
      .filter(
        (job) => isForService(job, service) && isForPerson(job, staff, people),
      )
      .map((job) => ({ job, days: waitedDays(job, today, business.timezone) }))
      .sort((a, b) => b.days - a.days || a.job.scheduledAt - b.job.scheduledAt)

    const hidden = hidePrices(env.caps)
    const bands = AGE_BANDS.map((band) => {
      const inBand = jobs.filter(({ days }) => ageBandOf(days) === band.key)
      return {
        key: band.key,
        count: inBand.length,
        value: redactTotal(
          env.caps,
          inBand.reduce((total, { job }) => total + job.price, 0),
        ),
      }
    })

    const listed = await Promise.all(
      jobs.slice(0, UNINVOICED_LISTED).map(async ({ job, days }) => {
        const property = await ctx.db.get(job.propertyId)
        const client = property ? await ctx.db.get(property.clientId) : null
        return {
          jobId: job._id,
          jobNumber: job.jobNumber ?? null,
          client: client?.name ?? 'Client removed',
          suburb: property?.suburb ?? '',
          jobType: job.jobType,
          price: hidden ? null : job.price,
          dayKey: dayKeyOf(
            job.completedAt ?? job.scheduledAt,
            business.timezone,
          ),
          days,
        }
      }),
    )

    return {
      scope: wireScope(scope),
      pricesHidden: hidden,
      count: jobs.length,
      value: redactTotal(
        env.caps,
        jobs.reduce((total, { job }) => total + job.price, 0),
      ),
      bands,
      jobs: listed,
      // More waiting than is listed, or than was read at all.
      more: jobs.length > listed.length || waiting.more,
    }
  },
})
