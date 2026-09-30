import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authComponent } from './auth'
import {
  addDaysToKey,
  dayKeyOf,
  endOfDayInZone,
  startOfDayInZone,
  todayKeyInZone,
} from './lib/dates'
import {
  newClientFields,
  newPropertyFields,
  resolvePropertyId,
  withClient,
} from './properties'
import { suggestTemplates } from '../src/lib/reportTemplates/suggest'
import { canonicalLabelFor, loadJobTypes } from './lib/jobTypeList'
import { settableJobStatus } from './schema'
import type { Doc, Id } from './_generated/dataModel'
import { isInScope, writeAttribution } from './lib/capabilities'
import { jobsInScope, jobsNewestFirst } from './lib/jobScope'
import { unbinned } from './lib/bin'
import { activateLeadAt } from './lib/clientRecord'
import {
  insertJobNote,
  insertJobNoteOnce,
  jobNotePreview,
  relinkJobNotes,
} from './notes'
import { heldAnywhere } from './lib/fileClaims'
import { CLAIM_WINDOW_MS } from './lib/products'
import {
  assertStatusChange,
  entersDone,
  initialJobStatus,
  isCountedJob,
  orderForDay,
  setJobStatus,
} from './lib/jobStatus'
import { hidePrices, redactJob } from './lib/prices'
import { HORIZON_DAYS, intervalOf } from './lib/recurrence'
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
import { UNASSIGNED_COLOUR } from './lib/colours'
import {
  alsoGoingInWindow,
  alsoGoingOf,
  everyoneOn,
  jobInScope,
  setAlsoGoing,
  syncAlsoGoingDate,
  tidyAlsoGoing,
} from './lib/jobPeople'
import { normaliseWorkOrder } from './lib/workOrder'
import { normaliseJobNotes } from './lib/jobNotes'

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
  // Neither a cancellation nor a projection is work that has been BOOKED.
  //
  // This is the counting read: the week strip's dots, the month grid's
  // counts, the desktop team legend, analytics. A projected visit is the
  // engine's guess about a date nobody has confirmed, and folding it into
  // those totals tells an owner they have a fortnight's work booked when they
  // have one job and a standing arrangement.
  //
  // `listDay` deliberately does NOT read through here — it shows a projection
  // whose day has arrived, because a due visit nobody can see is a service
  // silently missed. Shown there, counted nowhere. The distinction is
  // future-vs-due, and it lives in `listDay` because this function has no day
  // to compare against.
  return jobs.filter(isCountedJob)
}

async function decorate(
  ctx: QueryCtx,
  env: ActorEnvelope,
  jobs: Array<Doc<'jobs'>>,
  // Series the caller has already read, so they are not read again.
  knownSeries: Array<Doc<'recurrences'>> = [],
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

  // The series behind a recurring visit, for the card's "Every 2 weeks". Read
  // once per series per query, not once per visit — a day holds a few visits
  // of one series, the Job tab up to 200 — and memoised the same way, on the
  // in-flight promise.
  const series = new Map<Id<'recurrences'>, Promise<Doc<'recurrences'> | null>>(
    knownSeries.map((r) => [r._id, Promise.resolve(r)]),
  )
  const seriesOf = (recurrenceId: Id<'recurrences'>) => {
    const inFlight = series.get(recurrenceId)
    if (inFlight) return inFlight
    const pending = ctx.db.get(recurrenceId)
    series.set(recurrenceId, pending)
    return pending
  }

  // Everyone also going on these jobs (lib/jobPeople.ts), in one range read
  // over their dates rather than one read per job: a list of a thousand
  // projected visits must not spend a thousand of its reads finding nobody.
  const dates = jobs.map((job) => job.scheduledAt)
  const people =
    jobs.length === 0
      ? new Map<Id<'jobs'>, Array<Id<'memberships'>>>()
      : await alsoGoingInWindow(
          ctx,
          jobs[0].businessId,
          Math.min(...dates),
          Math.max(...dates) + 1,
        )

  return Promise.all(
    jobs
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map(async (job) => {
        const property = await ctx.db.get(job.propertyId)
        const client = property ? await ctx.db.get(property.clientId) : null
        const assignee = await ctx.db.get(job.assignedMembershipId)
        const recurrence = job.recurrenceId
          ? await seriesOf(job.recurrenceId)
          : null
        return {
          ...redactJob(env.caps, job),
          // The card SHOWS the suburb alone (§2.3: scanning a day wants the
          // suburb). The street address still rides along for its Map.
          addressLine: property?.addressLine ?? '',
          suburb: property?.suburb ?? '',
          postcode: property?.postcode ?? '',
          // For the forecast: a suburb is found in its own state, which is
          // not always the business's (a Perth business's Darwin job).
          propertyState: property?.state ?? '',
          clientName: client?.name ?? '',
          // With the site contact below, for who the card's Call dials
          // (convex/lib/siteContact.ts: a business site's own contact wins).
          // Added beside `clientPhone`, never folded into it: an older
          // frontend still live while this backend ships reads `clientPhone`
          // as the client's line, and would dial the site under its name.
          clientKind: client?.kind,
          siteContactName: property?.siteContactName ?? '',
          siteContactPhone: property?.siteContactPhone ?? '',
          // For the card's Call. The same number the job detail sheet dials
          // (`get` embeds the whole client), read off a document this row
          // loads anyway — and the client book is open to everyone who can
          // see the job (`clients.directory` is 'always' for every role).
          clientPhone: client?.phone ?? '',
          // For the card's Email: the address the job sheet's Email uses,
          // off the same document, with the same exposure as the phone.
          clientEmail: client?.email ?? '',
          // How often the visit's series repeats, for the card's indicator —
          // only while the series is running, as the job sheet shows it, so
          // a visit left over from a stopped series does not read as one
          // that will come round again.
          repeats: recurrence?.active ? intervalOf(recurrence) : undefined,
          assigneeColour: assignee?.colour ?? UNASSIGNED_COLOUR,
          assigneeName: assignee
            ? await nameOf(job.assignedMembershipId, assignee.userId)
            : '',
          // Everyone also going beside the lead (lib/jobPeople.ts), each with
          // their own colour and name for the card's Technicians row. Beside
          // `assignee*`, never folded into it: an older build reads those as
          // the job's one person.
          alsoGoing: await Promise.all(
            (people.get(job._id) ?? []).map(async (membershipId) => {
              const member = await ctx.db.get(membershipId)
              return {
                _id: membershipId,
                colour: member?.colour ?? UNASSIGNED_COLOUR,
                name: member ? await nameOf(membershipId, member.userId) : '',
              }
            }),
          ),
          // The card's Note row: the job's newest note in Notes.
          notePreview: await jobNotePreview(ctx, job._id),
        }
      }),
  )
}

/**
 * How far BACK a projection that nobody actioned is carried forward.
 *
 * Symmetric with the forward horizon, and bounded for the same reason: this
 * is a date-range scan, and "every projection ever" has no ceiling. Anything
 * older than this is still listed in the Recurring Job view, which reads the
 * same window — so nothing becomes permanently invisible, it just stops
 * chasing you on today's schedule after six months of being ignored.
 */
const OVERDUE_LOOKBACK_DAYS = HORIZON_DAYS

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Projected visits whose day has passed and which nobody has acted on.
 *
 * The failure this exists to catch: a recurring visit comes due, nobody opens
 * that day, and the service never happens. There is no empty slot to notice —
 * the job was never `pending`, so nothing looks wrong anywhere. Carried
 * forward onto today, the way an unpaid invoice does not vanish tomorrow.
 */
async function overdueRecurring(
  ctx: QueryCtx,
  scope: RowScope,
  businessId: Id<'businesses'>,
  startOfToday: number,
): Promise<Array<Doc<'jobs'>>> {
  const jobs = await jobsInScope(ctx, scope, {
    businessId,
    from: startOfToday - OVERDUE_LOOKBACK_DAYS * DAY_MS,
    to: startOfToday,
    // Projections only: nobody is also going on one until it is booked.
    withShared: false,
  })
  return jobs.filter((j) => j.status === 'recurring')
}

/**
 * How many of them there are, for the badge in the nav.
 *
 * Its own query, deliberately without `decorate`: this is read on every page
 * — that is the point of it, since a badge nobody has to navigate to is what
 * actually prevents the miss — and `decorate` resolves an assignee name per
 * job through the auth component. A count needs none of that.
 */
export const overdueRecurringCount = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return 0

    const startOfToday = startOfDayInZone(
      todayKeyInZone(business.timezone),
      business.timezone,
    )
    return (
      await overdueRecurring(ctx, env.listScope, businessId, startOfToday)
    ).length
  },
})

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

    /**
     * The one place a projected visit IS shown on the schedule: its own day,
     * once that day has arrived.
     *
     * Hiding `recurring` is about not burying the calendar under six months
     * of machine-generated work — a visit ninety days out is noise. A visit
     * due TODAY is the opposite: for a pest business, recurring treatments
     * happening on time IS the product, and a due visit that appears on no
     * schedule is a service silently missed. There is no empty slot to notice
     * and no card to chase, just a customer who did not get treated.
     *
     * So the rule is future-vs-due, not recurring-vs-not. It stays out of
     * every COUNT either way (`jobsInRange` above, which is what the week
     * strip, the month grid, the team legend and the dashboard read): a
     * projection is not work anybody has committed to until it is actioned,
     * and the count is of real bookings. Shown, not counted.
     */
    const todayKey = todayKeyInZone(business.timezone)
    const dayHasArrived = dayKey <= todayKey
    const jobs = (
      await jobsInScope(ctx, env.listScope, { businessId, from, to })
    ).filter(
      (j) =>
        j.status !== 'cancelled' && (j.status !== 'recurring' || dayHasArrived),
    )

    /**
     * ...and today also carries forward everything that came due and was
     * never acted on.
     *
     * Showing a due visit on its own day only helps the person who opens that
     * day. Miss it and the window shuts: tomorrow it is behind a back
     * button, and the service quietly never happens. The day it fails is
     * precisely the day nobody was looking, so the fix cannot be "look on the
     * right day". These are still counted nowhere.
     */
    if (dayKey === todayKey) {
      jobs.push(
        ...(await overdueRecurring(ctx, env.listScope, businessId, from)),
      )
    }

    // Completed work sinks to the bottom of the day (lib/jobStatus.ts), so
    // the card that moves when a job is finished moves for every viewer at
    // once — the day's cards and the Week View render this order as given.
    return orderForDay(await decorate(ctx, env, jobs))
  },
})

/**
 * How many jobs the Job tab holds. Bounded because jobs are the fastest-growing
 * table in the app — one recurring series projects six months of them — and a
 * list nobody scrolls to the end of does not need to be complete. The page says
 * so when it is showing a capped list.
 */
const JOB_LIST_LIMIT = 200

/** Every status but `recurring`: the ones a person can set, which is to say
 * every job somebody booked (schema.ts `settableJobStatus`). */
const BOOKED_STATUSES = settableJobStatus.members.map((m) => m.value)

/**
 * The Job tab's list: every job in scope that somebody booked, most recently
 * booked first, whatever its status and whatever day it is on. Cancelled jobs
 * are included — the status filter is the reader's to set, and a list that
 * silently omits them would make "Cancelled" an empty filter.
 *
 * Projected `recurring` visits are NOT (Phase 4, from the Phase 3 carry-
 * forward). They are the engine's projections of a series, read on purpose in
 * the Recurring Job view one tab across and counted there as series; here
 * they buried the booked work under six months of them and put projections
 * into the tab's "N jobs". They are left out by the read itself — one indexed
 * scan per status that a person can set (`jobsNewestFirst`) — because they
 * are the newest rows, and dropping them after a fixed-size read would empty
 * the page.
 */
export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)

    // One more than the limit, so "there are more" needs no second query.
    const found = await jobsNewestFirst(ctx, env.listScope, {
      businessId,
      limit: JOB_LIST_LIMIT + 1,
      statuses: BOOKED_STATUSES,
    })
    const jobs = await decorate(ctx, env, found.slice(0, JOB_LIST_LIMIT))

    return {
      // `decorate` orders a day's work by start time; this list is read the
      // other way round — newest first, so a job just booked is at the top.
      jobs: jobs.sort((a, b) => b._creationTime - a._creationTime),
      capped: found.length > JOB_LIST_LIMIT,
      limit: JOB_LIST_LIMIT,
    }
  },
})

/**
 * The Recurring Job view: the projected visits in scope, and how many
 * Recurring Jobs they belong to.
 *
 * THE COUNT IS OF SERIES, NOT OF VISITS, and that distinction is the whole
 * reason this returns two things. The engine only materialises visits inside
 * HORIZON_DAYS, so counting `recurring` job records answers "how many
 * projected visits fall in the next six months" — a number that says 26 for a
 * fortnightly contract, 0 for a job set to repeat every 15 years, and changes
 * every night as the cron runs. Neither is what an owner means by "how many
 * recurring jobs do I have". `seriesCount` is the arrangements; the UI labels
 * it as such.
 *
 * No row limit on the visits: the horizon bounds the scan already, and a
 * limit would silently truncate a busy schedule's projections rather than
 * capping anything unbounded.
 */
export const listRecurring = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business)
      return { jobs: [], seriesCount: 0, horizonDays: HORIZON_DAYS }

    const now = Date.now()
    const startOfToday = startOfDayInZone(
      todayKeyInZone(business.timezone),
      business.timezone,
    )
    const visits = (
      await jobsInScope(ctx, env.listScope, {
        businessId,
        // Reaches BACKWARDS as well, so a projection nobody actioned is
        // listed here for as long as today's schedule carries it forward.
        // This view is the backstop: nothing should ever be invisible in
        // both places at once. From the start of today, exactly as
        // `overdueRecurring` reads: measured from `now`, a visit at 09:00 on
        // the last day of the lookback was still counted by the nav badge and
        // the Job tab's link all afternoon, but gone from the view they open.
        from: startOfToday - OVERDUE_LOOKBACK_DAYS * DAY_MS,
        // One day's slack past the horizon: the cron projects from its own
        // "now", which is up to a day ahead of this query's.
        to: now + (HORIZON_DAYS + 1) * DAY_MS,
        // Projections only (below): nobody is also going on one.
        withShared: false,
      })
    ).filter((j) => j.status === 'recurring')

    // `listScope`, exactly as the visits above — NOT `scope`.
    //
    // The two differ whenever the owner is in "Just my jobs": `scope` is
    // everything they may read, `listScope` is what the view they chose is
    // showing (lib/actor.ts). Counting series by `scope` while listing visits
    // by `listScope` puts a bar reading "12 Recurring Jobs" over a handful of
    // the owner's own cards, which is not a summary of anything on screen. It
    // is also the stricter of the two, so a subcontractor still cannot learn
    // the size of the owner's book from it.
    const series = await ctx.db
      .query('recurrences')
      .withIndex('by_business_active', (q) =>
        q.eq('businessId', businessId).eq('active', true),
      )
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
      .collect()

    return {
      jobs: await decorate(ctx, env, visits, series),
      seriesCount: series.filter((r) =>
        isInScope(env.listScope, {
          assignedMembershipId: r.assignedMembershipId,
        }),
      ).length,
      horizonDays: HORIZON_DAYS,
    }
  },
})

/**
 * Seven days from `startKey`, grouped by the tenant's own calendar day — the
 * week strip's per-person dots and job count, and the Week View's headers.
 *
 * TWO NUMBERS PER DAY, NEVER ONE (Phase 4.4):
 * - `count` is booked work, exactly as `jobsInRange` counts it: no
 *   projection and no cancellation. It is the same number the month grid,
 *   the team legend and the dashboard show.
 * - `recurringCount` is that day's projected visits — status `recurring`,
 *   counted on their OWN day, past, today or future alike. Not carried onto
 *   today the way `listDay` carries an overdue one (that and the nav badge
 *   are the escalation), not series (the Recurring Job view counts those),
 *   and never added to `count` here or anywhere a caller might.
 *
 * Its own read rather than `jobsInRange`'s, because that one throws the
 * projections away before the days are built — the rows are the same, and
 * so is the cost. No wall clock: which days have arrived is the caller's
 * question, asked against its own "today".
 */
export const listWeek = query({
  args: { businessId: v.id('businesses'), startKey: v.string() },
  handler: async (ctx, { businessId, startKey }) => {
    const { listScope } = await requireActor(ctx, businessId)
    const business = await ctx.db.get(businessId)
    if (!business) return []
    const tz = business.timezone

    // Day boundaries by the calendar, not in 24-hour steps: a week holding a
    // daylight-saving change has one 23- or 25-hour day in it.
    const dayKeys = Array.from({ length: 7 }, (_, i) =>
      addDaysToKey(startKey, i),
    )
    const from = startOfDayInZone(startKey, tz)
    const to = startOfDayInZone(addDaysToKey(startKey, 7), tz)

    const rows = await jobsInScope(ctx, listScope, { businessId, from, to })
    // Each person on a job gets their dot, the people also going too.
    const people = await alsoGoingInWindow(ctx, businessId, from, to)
    const byDay = new Map<string, Array<Doc<'jobs'>>>()
    for (const job of rows) {
      const key = dayKeyOf(job.scheduledAt, tz)
      byDay.set(key, [...(byDay.get(key) ?? []), job])
    }

    const colours = new Map<Id<'memberships'>, string>()
    const colourOf = async (membershipId: Id<'memberships'>) => {
      if (!colours.has(membershipId)) {
        const m = await ctx.db.get(membershipId)
        colours.set(membershipId, m?.colour ?? UNASSIGNED_COLOUR)
      }
      return colours.get(membershipId) ?? UNASSIGNED_COLOUR
    }

    const days = []
    for (const [offset, dayKey] of dayKeys.entries()) {
      const inDay = (byDay.get(dayKey) ?? []).sort(
        (a, b) => a.scheduledAt - b.scheduledAt,
      )
      const counted = inDay.filter(isCountedJob)

      // The first booked job's suburb stands for the day's weather. A day
      // spanning several suburbs has no single forecast, so the UI labels
      // which one.
      const property = counted[0]
        ? await ctx.db.get(counted[0].propertyId)
        : null

      const dayColours: Array<string> = []
      for (const job of counted) {
        for (const membershipId of everyoneOn(job, people)) {
          const colour = await colourOf(membershipId)
          if (!dayColours.includes(colour)) dayColours.push(colour)
        }
      }

      days.push({
        offset,
        dayKey,
        count: counted.length,
        recurringCount: inDay.filter((j) => j.status === 'recurring').length,
        suburb: property?.suburb ?? '',
        postcode: property?.postcode ?? '',
        colours: dayColours,
      })
    }
    return days
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
    const people = await alsoGoingInWindow(ctx, businessId, from, to)

    const byDay = new Map<
      string,
      { count: number; colours: Set<string>; suburb: string; postcode: string }
    >()

    for (const job of jobs.sort((a, b) => a.scheduledAt - b.scheduledAt)) {
      const dayKey = dayKeyOf(job.scheduledAt, business.timezone)
      const property = await ctx.db.get(job.propertyId)

      const entry = byDay.get(dayKey) ?? {
        count: 0,
        colours: new Set<string>(),
        suburb: property?.suburb ?? '',
        postcode: property?.postcode ?? '',
      }
      entry.count += 1
      for (const membershipId of everyoneOn(job, people)) {
        const member = await ctx.db.get(membershipId)
        entry.colours.add(member?.colour ?? UNASSIGNED_COLOUR)
      }
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
    const people = await alsoGoingInWindow(ctx, businessId, from, to)

    // A shared job counts for each person on it: Kevin's month shows the
    // school job he worked. So the rows can add up to more than the month's
    // jobs, which are counted once, elsewhere.
    const counts = new Map<Id<'memberships'>, number>()
    for (const job of jobs) {
      for (const membershipId of everyoneOn(job, people)) {
        counts.set(membershipId, (counts.get(membershipId) ?? 0) + 1)
      }
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
          colour: assignee?.colour ?? UNASSIGNED_COLOUR,
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

    // In the Recycle bin reads as gone (lib/bin.ts): the bin page is where
    // a deleted job is seen, not a deep link to it.
    const job = unbinned(await ctx.db.get(jobId))
    if (!job || job.businessId !== businessId) return null

    // Its lead, or one of the people also going on it (lib/jobPeople.ts).
    if (!(await jobInScope(ctx, env.scope, job))) {
      // Null rather than an error: a subcontractor must not be able to tell a
      // colleague's job apart from one that does not exist.
      return null
    }

    const rawProperty = await ctx.db.get(job.propertyId)
    const property = rawProperty && (await withClient(ctx, rawProperty))
    const assignee = await ctx.db.get(job.assignedMembershipId)
    const alsoGoing = await alsoGoingOf(ctx, job._id)
    const people = await Promise.all(
      alsoGoing.map(async (membershipId) => {
        const member = await ctx.db.get(membershipId)
        return (
          member && {
            _id: member._id,
            colour: member.colour,
            role: member.role,
          }
        )
      }),
    )
    const recurrence = job.recurrenceId
      ? await ctx.db.get(job.recurrenceId)
      : null

    return {
      ...redactJob(env.caps, job),
      property,
      recurrence: recurrence && {
        _id: recurrence._id,
        // The shape the UI renders, resolved here so no client has to know
        // that rows written before the custom-interval migration carry a
        // `frequency` enum instead.
        interval: intervalOf(recurrence),
        active: recurrence.active,
      },
      // No licence number: nothing renders it, and it is exactly the detail
      // the roster withholds from people who do not manage the team.
      assignee: assignee && {
        _id: assignee._id,
        colour: assignee.colour,
        role: assignee.role,
      },
      // The people also going, beside the lead, in the order added.
      alsoGoing: people.filter((p) => p !== null),
      // Granted read access never implies write access (§4.4). The same
      // question `requireEditableJob` asks, so the button is never an
      // invitation to a refusal — everyone on the job may edit it.
      canEdit: await mayEditJob(ctx, env.actor, { ...job, alsoGoing }),
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
    // Or a new site for a client that already exists (Prompt 6.3).
    newProperty: v.optional(newPropertyFields),
    assignedMembershipId: v.id('memberships'),
    jobType: v.string(),
    price: v.number(),
    scheduledAt: v.number(),
    durationMinutes: v.number(),
    workOrder: v.optional(v.string()),
    // A note typed while booking: it becomes a note in Notes, on this job
    // (`insertJobNote`). Sent only when one was typed.
    notes: v.optional(v.string()),
    // Everyone going beside the lead (lib/jobPeople.ts). Sent only when
    // someone was added: an older backend refuses an argument it does not
    // know.
    alsoGoing: v.optional(v.array(v.id('memberships'))),
  },
  handler: async (
    ctx,
    {
      propertyId: existingPropertyId,
      newClient,
      newProperty,
      workOrder: rawWorkOrder,
      notes: rawNotes,
      alsoGoing: rawAlsoGoing,
      ...args
    },
  ) => {
    const env = await requireWriteActor(ctx, args.businessId)
    // Refused before any other work: a throw rolls the whole booking back,
    // new client included, so nothing is left half-made either way.
    const workOrder = normaliseWorkOrder(rawWorkOrder)
    const notes = normaliseJobNotes(rawNotes)

    // Who the ACTING account may put work onto (`canDispatchTo`): the owner
    // anyone, a contractor their team, anyone else themselves. The roster's
    // `bookable` flag is the same function, so a picker cannot offer a
    // refused option.
    await requireBookable(ctx, env, args.businessId, args.assignedMembershipId)
    // Everyone else on it by the same rule: whoever may be booked onto work
    // by this writer may be put on it beside the lead, and nobody else.
    const alsoGoing = tidyAlsoGoing(
      args.assignedMembershipId,
      rawAlsoGoing ?? [],
    )
    for (const membershipId of alsoGoing) {
      await requireBookable(ctx, env, args.businessId, membershipId)
    }

    // A price from someone who cannot see prices is a placeholder, not a
    // figure. Stored as nothing rather than as whatever the form defaulted to.
    const price = hidePrices(env.caps) ? 0 : args.price

    const propertyId = await resolvePropertyId(ctx, args.businessId, {
      propertyId: existingPropertyId,
      newProperty,
      newClient,
    })
    // Booked work makes a lead a client (lib/clientRecord.ts).
    await activateLeadAt(ctx, propertyId)

    const jobNumber = await allocateJobNumber(ctx, args.businessId)
    const jobId = await ctx.db.insert('jobs', {
      ...args,
      // In the business's own words (lib/jobTypeList.ts): a renamed service
      // sent under its old name is saved under its new one.
      jobType: await canonicalLabelFor(ctx, args.businessId, args.jobType),
      price,
      propertyId,
      status: initialJobStatus('manual'),
      createdAt: Date.now(),
      jobNumber,
      ...(workOrder !== undefined && { workOrder }),
    })
    if (alsoGoing.length > 0) {
      const job = await ctx.db.get(jobId)
      if (job) await setAlsoGoing(ctx, job, alsoGoing, env.actor.real._id)
    }
    if (notes !== undefined) {
      const job = await ctx.db.get(jobId)
      // By the person booking, as themselves: switched into someone else's
      // account, a note is still the real person's own (notes.create).
      if (job) {
        await insertJobNote(ctx, {
          job,
          authorMembershipId: env.actor.real._id,
          text: notes,
        })
      }
    }

    await recordOnBehalf(ctx, writeAttribution(env.actor), {
      businessId: args.businessId,
      action: 'job.create',
      entityType: 'jobs',
      entityId: jobId,
      meta: {
        jobNumber,
        assignedMembershipId: args.assignedMembershipId,
        ...(alsoGoing.length > 0 && { alsoGoing }),
      },
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
    // A blank string clears it; leaving it out leaves it alone.
    workOrder: v.optional(v.string()),
    // Sent only by an app from before a job's notes were Notes (30 Sept
    // 2026), whose job sheet kept the note as text on the job. That field is
    // gone; what it sends becomes a note in Notes on the job (below).
    notes: v.optional(v.string()),
    // Everyone going beside the lead, as it should be afterwards — the whole
    // list, not a change to it. Absent leaves them alone.
    alsoGoing: v.optional(v.array(v.id('memberships'))),
    // Deliberately not `jobStatus`: 'recurring' is system-only
    // (lib/jobStatus.ts), refused here at the door so a client that sends it
    // fails argument validation before any handler code runs.
    // `assertStatusChange` below repeats the rule for the day this is widened
    // by mistake. 'invoiced' is an ordinary choice for whoever may edit the
    // job — the owner's decision, 2026-09-22.
    status: v.optional(settableJobStatus),
  },
  handler: async (
    ctx,
    { businessId, jobId, alsoGoing: rawAlsoGoing, ...patch },
  ) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)

    // Who is going afterwards: the list as sent, or as it is — without the
    // lead either way, so someone made lead is no longer also going. And when
    // someone also going is made lead, the lead they replace takes their
    // place rather than leaving the job without a word.
    const lead = patch.assignedMembershipId ?? job.assignedMembershipId
    const currentAlsoGoing = await alsoGoingOf(ctx, job._id)
    const promoted =
      lead !== job.assignedMembershipId && currentAlsoGoing.includes(lead)
    const alsoGoing = tidyAlsoGoing(
      lead,
      rawAlsoGoing ??
        (promoted
          ? [...currentAlsoGoing, job.assignedMembershipId]
          : currentAlsoGoing),
    )
    const peopleChanged =
      alsoGoing.length !== currentAlsoGoing.length ||
      alsoGoing.some((id) => !currentAlsoGoing.includes(id))

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

    if (patch.status !== undefined) assertStatusChange(job.status, patch.status)

    // An invoiced job is a billed job: re-pricing, rescheduling or moving it
    // silently contradicts an invoice that has already gone out. Its STATUS is
    // an ordinary choice like any other, so a status-only change still passes
    // — moving it back out of invoiced is how its details are reopened. So
    // does its note, which the invoice does not carry: "paid cash on the day"
    // is written after the invoice, not before it.
    const touchesDetails = Object.entries(
      patch as Record<string, unknown>,
    ).some(
      ([field, value]) =>
        field !== 'status' && field !== 'notes' && value !== undefined,
    )
    // Who went is a detail of the invoice like who led it.
    if (job.status === 'invoiced' && (touchesDetails || peopleChanged)) {
      throw new ConvexError('JOB_INVOICED')
    }
    // Only those added are asked about: whoever is already on it — the lead
    // stepping aside included — stays, whoever may book them or not.
    for (const membershipId of alsoGoing) {
      if (
        !currentAlsoGoing.includes(membershipId) &&
        membershipId !== job.assignedMembershipId
      ) {
        await requireBookable(ctx, env, businessId, membershipId)
      }
    }

    // Same tenant check `create` already performs — a job can be corrected
    // to a different address, never moved to another business's property.
    if (patch.propertyId !== undefined) {
      // Nor onto a property in the Recycle bin.
      const property = unbinned(await ctx.db.get(patch.propertyId))
      if (!property || property.businessId !== businessId) {
        throw new ConvexError('NOT_FOUND')
      }
      if (patch.propertyId !== job.propertyId) {
        // Work moved onto a lead's property is work booked for them.
        await activateLeadAt(ctx, patch.propertyId)
        // The job's notes go with it: a note on a job is linked to its site
        // and client too (notes.resolveLinks), which is what puts it on the
        // job's sheet, the client's, and in the Recycle bin with either.
        await relinkJobNotes(ctx, job._id, property)
      }
    }

    const fields: Record<string, unknown> = Object.fromEntries(
      Object.entries(patch as Record<string, unknown>).filter(
        ([, value]) => value !== undefined,
      ),
    )

    // Written only when it changes, and as `undefined` when cleared — which
    // is how a patch removes a field. Without this a blank would be stored as
    // an empty string, and a work order could never be taken off again.
    if (patch.workOrder !== undefined) {
      const workOrder = normaliseWorkOrder(patch.workOrder)
      if (workOrder === job.workOrder) delete fields.workOrder
      else fields.workOrder = workOrder
    }
    if (patch.jobType !== undefined) {
      fields.jobType = await canonicalLabelFor(ctx, businessId, patch.jobType)
    }
    // An older app's note is not a field of the job any more: it is kept as
    // a note in Notes on the job, once the job's own changes are in — never
    // refused, never lost on a phone still running that app. '' has nothing
    // to clear, and the same words twice are one note.
    const olderAppNote =
      patch.notes === undefined ? undefined : normaliseJobNotes(patch.notes)
    delete fields.notes

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

    // `update` can finish a job too — as Completed or straight to Invoiced —
    // so the business's "not done until its report is" policy has to be asked
    // here as well as in `complete`; otherwise the policy is a button the
    // status menu walks straight past.
    if (patch.status !== undefined && entersDone(job.status, patch.status)) {
      await assertReportIssued(ctx, job)
    }

    if (Object.keys(fields).length > 0) {
      await ctx.db.patch(jobId, fields)
    }
    // The people rows carry the job's date, for their schedules' index.
    if (fields.scheduledAt !== undefined) {
      await syncAlsoGoingDate(ctx, jobId, fields.scheduledAt as number)
    }
    if (peopleChanged) {
      const moved = await ctx.db.get(jobId)
      if (moved) await setAlsoGoing(ctx, moved, alsoGoing, env.actor.real._id)
    }
    if (Object.keys(fields).length > 0 || peopleChanged) {
      await recordJobWrite(ctx, env, job, 'job.update', {
        fields: [
          ...Object.keys(fields),
          ...(peopleChanged ? ['alsoGoing'] : []),
        ],
      })
    }
    if (olderAppNote !== undefined) {
      const updated = await ctx.db.get(jobId)
      if (updated) {
        await insertJobNoteOnce(ctx, {
          job: updated,
          authorMembershipId: env.actor.real._id,
          text: olderAppNote,
        })
      }
    }
  },
})

export const complete = mutation({
  args: { businessId: v.id('businesses'), jobId: v.id('jobs') },
  handler: async (ctx, { businessId, jobId }) => {
    const { env, job } = await requireEditableJob(ctx, businessId, jobId)
    // Asked on the way into finished work only: an invoiced job moved back to
    // Completed already answered it.
    if (entersDone(job.status, 'completed')) await assertReportIssued(ctx, job)
    await setJobStatus(ctx, job, 'completed', { completedAt: Date.now() })
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
  // Any of the job's services with a form is enough: a general pest service
  // done alongside a quote visit still leaves a record behind. One finalised
  // report answers it, as it always has — not one per form.
  // Each service's form as the business's own list says (Settings → Job
  // types), so a service it added is held up like the built-in ones are.
  const jobTypes = await loadJobTypes(ctx, job.businessId)
  if (suggestTemplates(job.jobType, jobTypes).length === 0) return

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
    await setJobStatus(ctx, job, 'cancelled')
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
      ...((await claimableForJob(ctx, storageId)) && { claimed: true }),
    })
    await recordJobWrite(ctx, env, job, 'job.photo.add')
  },
})

/**
 * Whether a file just added to a job is that job's alone: uploaded within
 * the claim window (as a product's or a licence's file must be), and held by
 * no other job photo and by none of the rows `heldAnywhere` can ask.
 *
 * It does not refuse the photo — the job sheet adds each upload straight
 * after it lands, so a real one always passes, and a photo is never lost to
 * a slow network. It decides only whether wiping the job may delete the file
 * too (`jobPhotos.claimed`, convex/bin.ts): an id that fails this could be
 * any file in the deployment, a signed report's included.
 */
async function claimableForJob(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
): Promise<boolean> {
  const file = await ctx.db.system.get('_storage', storageId)
  if (!file || Date.now() - file._creationTime > CLAIM_WINDOW_MS) return false
  const other = await ctx.db
    .query('jobPhotos')
    .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
    .first()
  if (other) return false
  return !(await heldAnywhere(ctx, storageId))
}

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

    const job = unbinned(await ctx.db.get(jobId))
    if (!job || job.businessId !== businessId) return []
    if (!(await jobInScope(ctx, scope, job))) return []

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
