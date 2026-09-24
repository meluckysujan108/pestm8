import { ConvexError, v } from 'convex/values'
import { internalMutation } from '../_generated/server'
import { allocateJobNumber } from '../jobs'
import { addDaysToKey, startOfWeekKey } from '../lib/dates'
import {
  NOT_STARTED_STATUSES,
  initialJobStatus,
  setJobStatus,
} from '../lib/jobStatus'
import {
  HORIZON_DAYS,
  assertInterval,
  occurrencesFrom,
} from '../lib/recurrence'
import { resolvePropertyId } from '../properties'
import { MAX_VISITS_PER_RUN, insertVisit, materialiseOne } from '../recurrences'
import { normaliseWorkOrder } from '../lib/workOrder'
import {
  NAMED_JOBS,
  NAMED_VISITS,
  at,
  demoBaseV,
  manifestJobV,
  propertyMapV,
} from './shared'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { JobStatus } from '../lib/jobStatus'
import type { Interval } from '../lib/recurrence'
import type { DemoBase, ManifestJob, MemberKey } from './shared'

/**
 * The demo's jobs: six months of one-off work, today, the next few weeks, and
 * the Recurring Jobs with their visits.
 *
 * Each row is what the app's own path leaves: a one-off is inserted as
 * jobs.create inserts it (`pending`, a job number, `createdAt` when it was
 * booked) and then moved as the status menu moves it — Completed through
 * jobs.complete (which stamps `completedAt`), Cancelled through jobs.cancel,
 * Booked and Invoiced through jobs.update. A series is inserted as
 * recurrences.create inserts it, its visits through the engine's own
 * `insertVisit` / `materialiseOne` at the instants `occurrencesFrom` gives, so
 * the nightly cron finds every occurrence already taken and books nothing
 * twice.
 *
 * Nobody here is signed in and every write is one a person would make as
 * themselves, which the app does not audit (lib/audit.ts `recordOnBehalf`):
 * no audit rows. Only `_creationTime` gives away that it was all written
 * today, and the Job tab orders by it, so one-offs go in in the order they
 * were booked.
 */

type BookedStatus = Exclude<JobStatus, 'recurring'>
type Worker = Exclude<MemberKey, 'former'>

const MEMBER_KEYS: ReadonlyArray<MemberKey> = [
  'owner',
  'former',
  'contractor',
  'sub',
  'dana',
]

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const HORIZON_MS = HORIZON_DAYS * DAY

// ───────────────────────────────────────────────────────────── calendar

/** Calendar arithmetic on day keys: `Date.UTC` as a counter, no zone. */
function keyParts(key: string): [number, number, number] {
  const [y, m, d] = key.split('-').map(Number)
  return [y, m, d]
}

function daysBetween(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = keyParts(fromKey)
  const [ty, tm, td] = keyParts(toKey)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY)
}

/** 0 is Monday, 6 Sunday: the week strip's week. */
function weekdayOf(key: string): number {
  const [y, m, d] = keyParts(key)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function monthKeyOf(total: number): string {
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}`
}

/** Where the demo's days are, relative to the seed's today. */
function calendar(base: DemoBase) {
  const keyOf = (offset: number) => addDaysToKey(base.todayKey, offset)
  const offsetOf = (key: string) => daysBetween(base.todayKey, key)
  const weekday = (offset: number) => weekdayOf(keyOf(offset))
  const [year, month] = keyParts(base.todayKey)
  const thisMonth = year * 12 + (month - 1)
  return {
    keyOf,
    offsetOf,
    weekday,
    isWorkday: (offset: number) => weekday(offset) < 5,
    /** 0 for this month, -1 for last month… */
    monthOf: (offset: number) => {
      const [y, m] = keyParts(keyOf(offset))
      return y * 12 + (m - 1) - thisMonth
    },
    /** The 1st of the month `back` months ago. */
    monthStart: (back: number) =>
      offsetOf(`${monthKeyOf(thisMonth - back)}-01`),
    lastOfThisMonth: offsetOf(
      `${monthKeyOf(thisMonth)}-${daysInMonth(year, month)}`,
    ),
    /** Monday of the week after this one. */
    nextWeek: offsetOf(addDaysToKey(startOfWeekKey(base.todayKey), 7)),
    /** The weekday nearest `around` that `ok` accepts, looking a few days
     * either side. */
    nearestWorkday: (
      around: number,
      ok: (offset: number) => boolean = () => true,
    ) => {
      for (let step = 0; step < 14; step++) {
        const offset = around + (step % 2 === 0 ? step / 2 : -(step + 1) / 2)
        if (weekday(offset) < 5 && ok(offset)) return offset
      }
      throw new Error(`demo: no workday near ${around}`)
    },
    year,
    month,
  }
}

type Calendar = ReturnType<typeof calendar>

// ────────────────────────────────────────────────────────── the one-offs

type OneOff = {
  key?: string
  propertyKey: string
  assignee: MemberKey
  scheduledAt: number
  durationMinutes: number
  jobType: string
  price: number
  status: BookedStatus
  /** The legacy start time the retired inProgress status left. */
  startedAt?: number
  /** Invoiced before the work was done, so never through Completed. */
  billedAhead?: boolean
}

/** Who is on the books when (demo/team.ts), read off their memberships. */
type Tenure = {
  openedAt: number
  joinedAt: Record<MemberKey, number>
  formerRemovedAt: number
}

async function tenureOf(ctx: MutationCtx, base: DemoBase): Promise<Tenure> {
  const business = await ctx.db.get(base.businessId)
  if (!business) throw new ConvexError('demo: the business is missing')
  const membership = async (key: MemberKey) => {
    const row = await ctx.db.get(base.members[key])
    if (!row || row.businessId !== base.businessId) {
      throw new ConvexError(`demo: the ${key} membership is missing`)
    }
    return row
  }
  const former = await membership('former')
  if (former.removedAt === undefined) {
    throw new ConvexError('demo: the former technician was never removed')
  }
  return {
    openedAt: business.createdAt,
    joinedAt: {
      owner: (await membership('owner')).createdAt,
      former: former.createdAt,
      contractor: (await membership('contractor')).createdAt,
      sub: (await membership('sub')).createdAt,
      dana: (await membership('dana')).createdAt,
    },
    formerRemovedAt: former.removedAt,
  }
}

/**
 * The jobs being planned, and who is busy when, so the generated work fills
 * gaps around the fixed jobs and the series' visits instead of stacking on
 * them. The one deliberate double-booking (today at 10am) is added as is.
 */
function planner(dayOf: (ts: number) => number) {
  const jobs: Array<OneOff> = []
  const busy = new Map<MemberKey, Array<[number, number]>>()
  const reserve = (who: MemberKey, start: number, minutes: number) => {
    busy.set(who, [...(busy.get(who) ?? []), [start, start + minutes * MINUTE]])
  }
  const isFree = (who: MemberKey, start: number, minutes: number) => {
    const end = start + minutes * MINUTE
    return (busy.get(who) ?? []).every(([s, e]) => end <= s || start >= e)
  }
  const add = (job: OneOff) => {
    jobs.push(job)
    reserve(job.assignee, job.scheduledAt, job.durationMinutes)
  }
  return {
    jobs,
    reserve,
    isFree,
    add,
    /** At its time, or the first half hour after it that its person has
     * free that day: a fixed job on a day a named job or a visit already
     * holds moves along rather than double-booking them. */
    place(job: OneOff) {
      const day = dayOf(job.scheduledAt)
      for (let step = 0; step <= 16; step++) {
        const start = job.scheduledAt + step * 30 * MINUTE
        if (dayOf(start) !== day) break
        if (isFree(job.assignee, start, job.durationMinutes)) {
          add({ ...job, scheduledAt: start })
          return
        }
      }
      add(job)
    },
  }
}

/** The types a Perth pest business sells most, in the order the generated
 * history cycles through them: general pest work dominates. */
const HISTORY_TYPES: Array<string> = [
  'General Pest Control',
  'Rodents',
  'General Pest Control',
  'Ants',
  'Cockroaches',
  'General Pest Control',
  'Spiders',
  'Termite Inspection',
  'Rodents',
  'Wasps',
  'General Pest Control',
  'Bed Bugs',
  'Cockroaches',
  'Possum Removal',
  'General Pest Control',
  'Ants',
  'Rodents',
  'Spiders',
]

/** Price variations per type, in cents, and how long each takes. */
const RATES: Record<string, { prices: Array<number>; minutes: number }> = {
  'General Pest Control': { prices: [22000, 24500, 19500, 26000], minutes: 60 },
  Rodents: { prices: [18000, 16500, 21000], minutes: 45 },
  Ants: { prices: [16000, 17500], minutes: 45 },
  Cockroaches: { prices: [19000, 21000], minutes: 60 },
  Spiders: { prices: [15000, 14000], minutes: 30 },
  'Termite Inspection': { prices: [38000, 42000], minutes: 90 },
  Wasps: { prices: [17000, 18500], minutes: 30 },
  'Bed Bugs': { prices: [45000, 52000], minutes: 120 },
  'Possum Removal': { prices: [29500, 33000], minutes: 75 },
}

/** Everything but the interstate addresses and the archived client's house:
 * where the generated work goes. */
function localProperties(properties: Record<string, Id<'properties'>>) {
  const away = new Set([
    'fannieBay',
    'nightcliff',
    'barooga',
    'braddon',
    'bayswaterVic',
    'colinHome',
  ])
  return Object.keys(properties).filter((key) => !away.has(key))
}

/** Jobs per working day, cycled: some days off, the odd four-job day. */
const HISTORY_PATTERN = [1, 2, 0, 1, 2, 1, 0, 3, 1, 1, 0, 2, 1, 1, 4, 0]
const HISTORY_BANDS: Array<[number, number]> = [
  [7, 30],
  [10, 0],
  [13, 0],
  [15, 0],
]
const AHEAD_PATTERN = [1, 2, 1, 1, 2]
const AHEAD_BANDS: Array<[number, number]> = [
  [8, 0],
  [10, 30],
  [13, 0],
  [15, 0],
]

/** The month (counted back from this one) the owner took off: its revenue
 * bar is the short one. */
const LIGHT_MONTH = -3

/** One fixed job: who, the time of day, where, minutes, what, cents, and
 * where it ended up. */
type Row = [
  Worker,
  number,
  number,
  string,
  number,
  string,
  number,
  BookedStatus,
]

/** Today: every status for each person, and the awkward hours. Kept as a
 * table, which is how it is read. */
// prettier-ignore
const TODAY: Array<Row> = [
  // A completed job at 7am, which the day sinks to the bottom.
  ['owner', 7, 0, 'ppm1', 45, 'General Pest Control', 22000, 'completed'],
  ['owner', 8, 0, 'terryHome', 30, 'Spiders', 15000, 'invoiced'],
  // Double-booked at 10am.
  ['owner', 10, 0, 'sofiaRental', 90, 'Termite Inspection', 38000, 'booked'],
  ['owner', 10, 0, 'bayswaterUpper', 30, 'Rodents', 16500, 'pending'],
  ['owner', 12, 30, 'huongHome', 60, 'Cockroaches', 19000, 'cancelled'],
  ['contractor', 7, 30, 'kewdaleWarehouse', 45, 'Rodents', 18000, 'completed'],
  ['contractor', 8, 30, 'ridgeOsborne2', 60, 'General Pest Control', 26000, 'invoiced'],
  ['contractor', 11, 0, 'bayswaterLower', 45, 'Ants', 16000, 'booked'],
  ['contractor', 13, 30, 'smithMidland', 30, 'Wasps', 17000, 'pending'],
  ['contractor', 15, 0, 'oconnorHouse', 30, 'Spiders', 15000, 'cancelled'],
  // After the café closes, through midnight: "10:30pm – 12:30am".
  ['contractor', 22, 30, 'harbourCafe', 120, 'Cockroaches', 34000, 'booked'],
  ['sub', 6, 45, 'ppm7', 45, 'Ants', 16000, 'invoiced'],
  ['sub', 8, 0, 'ppm6', 60, 'Cockroaches', 19000, 'completed'],
  ['sub', 11, 30, 'ppm8', 60, 'General Pest Control', 24500, 'booked'],
  ['sub', 14, 0, 'lenaHome', 30, 'Spiders', 14000, 'pending'],
  // Ends exactly at midnight.
  ['sub', 23, 0, 'longAddress', 60, 'General Pest Control', 26000, 'pending'],
  ['dana', 6, 0, 'joondalopTypo', 30, 'Rodents', 16500, 'completed'],
  ['dana', 7, 0, 'oddPostcode', 30, 'Wasps', 17000, 'invoiced'],
  ['dana', 9, 0, 'hanaMidland', 120, 'Bed Bugs', 45000, 'booked'],
  ['dana', 11, 30, 'dayoHome', 75, 'Possum Removal', 29500, 'pending'],
  ['dana', 15, 30, 'ridgeJoondalup', 45, 'Ants', 17500, 'cancelled'],
]

/** Tuesday next week: everyone out, fourteen jobs, a day that scrolls. */
// prettier-ignore
const BUSY_DAY: Array<Row> = [
  ['owner', 7, 0, 'ppm1', 60, 'General Pest Control', 22000, 'booked'],
  ['owner', 8, 30, 'kewdaleWarehouse', 15, 'Rodents', 9500, 'booked'],
  ['owner', 10, 0, 'smithMidland', 90, 'Termite Inspection', 38000, 'booked'],
  ['owner', 13, 0, 'arthurHome', 75, 'Possum Removal', 29500, 'pending'],
  ['owner', 15, 30, 'terryHome', 90, 'Pre-Purchase Inspection', 42000, 'booked'],
  ['contractor', 7, 30, 'harbourCafe', 60, 'Cockroaches', 21000, 'booked'],
  ['contractor', 10, 0, 'ridgeJoondalup', 120, 'Bird Proofing', 64000, 'booked'],
  ['contractor', 13, 30, 'sofiaHome', 45, 'Ants', 16000, 'pending'],
  ['sub', 7, 45, 'ppm6', 60, 'General Pest Control', 24500, 'booked'],
  ['sub', 10, 30, 'ppm7', 30, 'Spiders', 15000, 'booked'],
  ['sub', 14, 0, 'bayswaterLower', 45, 'Ants', 17500, 'pending'],
  ['dana', 9, 0, 'dayoHome', 30, 'Wasps', 17000, 'booked'],
  ['dana', 11, 0, 'hanaMidland', 120, 'Bed Bugs', 45000, 'booked'],
  ['dana', 14, 30, 'oconnorHouse', 45, 'Rodents', 18000, 'pending'],
]

/** A type typed out in full, for the cards that have to wrap it. */
const LONG_JOB_TYPE =
  'Commercial kitchen follow-up: German cockroach flush and gel baiting (after hours)'

function seedOneOffs(
  base: DemoBase,
  cal: Calendar,
  tenure: Tenure,
  properties: Record<string, Id<'properties'>>,
  now: number,
): Array<OneOff> {
  const when = (day: number, hh: number, mm = 0) => at(base, day, hh, mm)
  const dayOf = (ts: number) => cal.offsetOf(dayKeyIn(base, ts))
  const plan = planner(dayOf)
  const fromRow = (day: number, row: Row): OneOff => {
    const [assignee, hh, mm, propertyKey, minutes, jobType, price, status] = row
    return {
      assignee,
      scheduledAt: when(day, hh, mm),
      propertyKey,
      durationMinutes: minutes,
      jobType,
      price,
      status,
    }
  }

  // Series visits first, so the generated work goes round them.
  const specs = seriesPlan(base, cal)
  for (const series of specs) {
    for (const t of occurrencesFrom(series.anchorDate, series.interval, {
      timezone: base.timezone,
      from: when(-200, 0),
      until: when(28, 0),
    })) {
      plan.reserve(series.assignee, t, series.durationMinutes)
    }
  }

  // ── The named jobs, exactly as shared.ts gives them ──────────────────
  for (const named of NAMED_JOBS) {
    const scheduledAt = when(named.day, named.hh, named.mm)
    plan.add({
      key: named.key,
      propertyKey: named.propertyKey,
      assignee: named.assignee,
      scheduledAt,
      durationMinutes: named.durationMinutes,
      jobType: named.jobType,
      price: named.priceCents,
      status: named.status,
      ...(named.startedMinutesAfter !== undefined
        ? { startedAt: scheduledAt + named.startedMinutesAfter * MINUTE }
        : {}),
    })
  }

  // ── Today, added as written: the 10am clash is the point ─────────────
  // Except that nothing is done before it ends: seeded at 7am, this
  // morning's later finished work is still booked.
  for (const row of TODAY) {
    const job = fromRow(0, row)
    const over = job.scheduledAt + job.durationMinutes * MINUTE <= now
    const done = job.status === 'completed' || job.status === 'invoiced'
    plan.add(done && !over ? { ...job, status: 'booked' } : job)
  }

  // ── A quiet weekday in each of the next two weeks ────────────────────
  // Chosen before anything movable is placed, and kept clear of it: not a
  // named job's day, not the busy day or the month boundary, and not the
  // day the stopped series keeps its next visit as a one-off (seedSeries).
  const { nextWeek } = cal
  const busyDay = nextWeek + 1
  const stopped = specs.find((s) => s.key === 'stopped')
  const kept = stopped
    ? occurrencesFrom(stopped.anchorDate, stopped.interval, {
        timezone: base.timezone,
        from: now + 1,
        until: now + 8 * DAY,
        limit: 1,
      })
    : []
  const unavailable = new Set([
    ...[...plan.jobs.map((j) => j.scheduledAt), ...kept].map(dayOf),
    busyDay,
    cal.lastOfThisMonth,
    cal.lastOfThisMonth + 1,
  ])
  const quiet = new Set<number>()
  for (const weekStart of [nextWeek, nextWeek + 7]) {
    // Midweek first, so the quiet day is not simply the day after the busy
    // one.
    const day = [2, 3, 4, 0, 1]
      .map((i) => weekStart + i)
      .find((d) => !unavailable.has(d))
    if (day !== undefined) quiet.add(day)
  }
  const notQuiet = (day: number) => {
    let d = day
    while (quiet.has(d)) d++
    return d
  }

  // ── Fixed history and future, each nudged later if its person is busy ─
  const decemberYear =
    base.todayKey < `${cal.year}-12-08` ? cal.year : cal.year + 1
  // Seeded on the last day of a month, the contractor is already out
  // overnight; the owner takes the boundary pair instead.
  const boundary: Worker = cal.lastOfThisMonth === 0 ? 'owner' : 'contractor'
  // prettier-ignore
  const fixed: Array<[number, Row]> = [
    // A strata complex's termite barrier: the biggest invoice the business
    // has sent, and a whole day. Mid-month, two months back: never in the
    // light month.
    [cal.nearestWorkday(cal.monthStart(2) + 12), ['owner', 7, 0, 'ridgeMidland', 480, 'Termite Treatment', 1250000, 'invoiced']],
    // Back after the sub's ant job at the same block, under warranty:
    // finished, and nothing to bill.
    [cal.nearestWorkday(-2, (d) => d > -4 && d < 0), ['sub', 14, 0, 'ppm5', 30, 'Ants', 0, 'completed']],
    // Nine cents: someone typed 0.09.
    [cal.nearestWorkday(-16), ['dana', 11, 30, 'terryHome', 30, 'Spiders', 9, 'completed']],
    // A general service last week, the kind a client then signs up to have
    // every quarter: seedSeries converts the one nearest seven days ago.
    [cal.nearestWorkday(-7, (d) => d >= -9 && d <= -5), ['owner', 13, 0, 'oconnorHouse', 60, 'General Pest Control', 23000, 'completed']],
    // Last week's work nobody closed off.
    [cal.nearestWorkday(-7, (d) => d >= -9 && d <= -3), ['owner', 15, 30, 'lenaHome', 90, 'Pre-Purchase Inspection', 42000, 'pending']],
    [cal.nearestWorkday(-5, (d) => d >= -8 && d <= -3), ['contractor', 10, 30, 'dayoHome', 30, 'Wasps', 17000, 'booked']],
    ...BUSY_DAY.map((row): [number, Row] => [busyDay, row]),
    // Either side of the month boundary, back to back: which month do the
    // grid and analytics put each in?
    [cal.lastOfThisMonth, [boundary, 23, 30, 'kewdaleWarehouse', 45, 'Rodents', 18000, 'booked']],
    [cal.lastOfThisMonth + 1, [boundary, 0, 15, 'ridgeOsborne2', 60, 'General Pest Control', 26000, 'booked']],
    // A full day at a commercial site.
    [nextWeek + 8, ['owner', 7, 0, 'ridgeMidland', 480, 'Bird Proofing', 386000, 'pending']],
    [nextWeek, ['dana', 10, 30, 'bayswaterUpper', 45, 'Ants', 19995, 'booked']],
    [nextWeek + 9, ['sub', 19, 0, 'ridgeOsborne1', 90, LONG_JOB_TYPE, 48000, 'pending']],
    // Out of state, and the addresses the geocoder trips on.
    [nextWeek, ['owner', 11, 0, 'nightcliff', 90, 'Termite Inspection', 38000, 'pending']],
    [nextWeek + 8, ['contractor', 10, 0, 'barooga', 60, 'General Pest Control', 31000, 'booked']],
    [nextWeek + 10, ['sub', 9, 0, 'braddon', 120, 'Bed Bugs', 52000, 'pending']],
    [nextWeek + 14, ['dana', 13, 0, 'bayswaterVic', 75, 'Possum Removal', 33000, 'pending']],
    [nextWeek + 4, ['dana', 15, 0, 'joondalopTypo', 30, 'Spiders', 15000, 'booked']],
    [nextWeek + 7, ['sub', 11, 0, 'oddPostcode', 45, 'Ants', 16000, 'booked']],
    // Far enough out that the date carries its year.
    [cal.offsetOf(`${decemberYear}-12-08`), ['owner', 9, 30, 'smithArmadale', 120, 'Pre-Purchase Inspection', 45000, 'pending']],
    [cal.offsetOf(`${decemberYear + 1}-01-12`), ['owner', 8, 0, 'ppm1', 90, 'Termite Inspection', 38000, 'pending']],
  ]
  for (const [day, row] of fixed) plan.place(fromRow(notQuiet(day), row))
  // Billed ahead: a barrier the client paid for up front. Invoiced, so it
  // cannot be edited, and it never went through Completed.
  plan.place({
    ...fromRow(notQuiet(nextWeek + 2), [
      'owner',
      7,
      30,
      'sofiaHome',
      240,
      'Termite Treatment',
      485000,
      'invoiced',
    ]),
    billedAhead: true,
  })

  // ── Generated: the everyday work around all of that ──────────────────
  const locals = localProperties(properties)
  let n = 0
  const generate = (
    day: number,
    count: number,
    people: Array<MemberKey>,
    bands: Array<[number, number]>,
    status: (i: number) => BookedStatus,
  ) => {
    for (let j = 0; j < count && people.length > 0; j++) {
      const i = n++
      const jobType = HISTORY_TYPES[i % HISTORY_TYPES.length]
      const rate = RATES[jobType]
      const assignee =
        people[(((day + j) % people.length) + people.length) % people.length]
      // The job's own band first, then any later one that is free.
      let start: number | undefined
      for (let b = j; b < j + bands.length; b++) {
        const [hh, mm] = bands[b % bands.length]
        const candidate = when(day, hh, mm)
        if (plan.isFree(assignee, candidate, rate.minutes)) {
          start = candidate
          break
        }
      }
      if (start === undefined) continue
      plan.add({
        propertyKey: locals[(i * 7) % locals.length],
        assignee,
        scheduledAt: start,
        durationMinutes: rate.minutes,
        jobType,
        price: rate.prices[i % rate.prices.length],
        status: status(i),
      })
    }
  }

  // Who could be booked on a day: nobody before they joined, and the
  // former technician only before the day they left.
  const onBooks = (day: number): Array<MemberKey> =>
    MEMBER_KEYS.filter(
      (who) =>
        when(day, 0) > tenure.joinedAt[who] &&
        (who !== 'former' || when(day + 1, 0) <= tenure.formerRemovedAt),
    )

  // From the 1st of the month five months back (never before the business
  // opened), through yesterday.
  const firstDay = Math.max(cal.monthStart(5), dayOf(tenure.openedAt) + 1)
  let workday = 0
  for (let day = firstDay; day <= -1; day++) {
    const weekday = cal.weekday(day)
    if (weekday === 6) continue
    let count: number
    if (weekday === 5) {
      // Every third Saturday, one job.
      count = Math.floor((day - firstDay) / 7) % 3 === 0 ? 1 : 0
    } else if (cal.monthOf(day) === LIGHT_MONTH) {
      // The owner's month off: the odd urgent call.
      count = workday % 8 === 0 ? 1 : 0
      workday++
    } else {
      count = HISTORY_PATTERN[workday % HISTORY_PATTERN.length]
      workday++
    }
    generate(day, count, onBooks(day), HISTORY_BANDS, (i) => {
      // Billed once it is a few weeks old; the last three weeks are mostly
      // done and waiting on an invoice.
      if (day <= -22) {
        if (i % 13 === 5) return 'cancelled'
        return i % 19 === 7 ? 'completed' : 'invoiced'
      }
      if (i % 11 === 3) return 'cancelled'
      return i % 5 === 1 ? 'invoiced' : 'completed'
    })
  }

  // The rest of the next three weeks.
  for (let day = 1; day <= 20; day++) {
    if (!cal.isWorkday(day) || day === busyDay || quiet.has(day)) continue
    generate(
      day,
      AHEAD_PATTERN[day % AHEAD_PATTERN.length],
      ['owner', 'contractor', 'sub', 'dana'],
      AHEAD_BANDS,
      // Confirmed this week, mostly still to confirm after that.
      (i) =>
        day <= 7
          ? i % 3 === 2
            ? 'pending'
            : 'booked'
          : i % 3 === 0
            ? 'booked'
            : 'pending',
    )
  }

  return plan.jobs
}

/** The day an instant falls on in the business's zone, found through the
 * same `at` every instant here was made with. */
function dayKeyIn(base: DemoBase, ts: number): string {
  const guess = Math.floor((ts - at(base, 0, 0)) / DAY)
  for (const offset of [guess - 1, guess, guess + 1]) {
    if (ts >= at(base, offset, 0) && ts < at(base, offset + 1, 0)) {
      return addDaysToKey(base.todayKey, offset)
    }
  }
  return addDaysToKey(base.todayKey, guess)
}

/** Days between booking a job and doing it, cycled. */
const LEADS = [3, 1, 6, 2, 9, 4, 1, 13, 5, 2, 7, 1]

/**
 * When each job was booked: a few days to a fortnight before it, in office
 * hours, never before the business opened or its assignee joined, and never
 * in the future. This is its `createdAt`, and the order it goes in.
 */
function bookingTime(
  base: DemoBase,
  tenure: Tenure,
  job: OneOff,
  i: number,
  now: number,
): number {
  const day = daysBetween(base.todayKey, dayKeyIn(base, job.scheduledAt))
  const lead = LEADS[i % LEADS.length]
  const bookedDay = day < 0 ? day - lead : Math.min(day - lead, -1 - (i % 9))
  const officeHours = at(base, bookedDay, 7 + ((i * 5) % 11), (i * 17) % 60)
  const earliest =
    Math.max(tenure.openedAt, tenure.joinedAt[job.assignee]) + 15 * MINUTE
  return Math.min(Math.max(officeHours, earliest), now)
}

type Settle = {
  status: JobStatus
  completedAt?: number
  startedAt?: number
  /** jobs.update moving it to another time first. */
  movedTo?: number
}

/**
 * Moves a job from where jobs.create (or the engine) left it to where it
 * ended up, through the path the app takes for each: jobs.update for
 * Pending/Booked/Invoiced and a new time, jobs.complete for Completed (the
 * only thing that stamps completedAt), jobs.cancel for Cancelled.
 */
async function settle(ctx: MutationCtx, jobId: Id<'jobs'>, to: Settle) {
  const read = async () => {
    const job = await ctx.db.get(jobId)
    if (!job) throw new Error('demo: a job vanished mid-seed')
    return job
  }
  if (to.movedTo !== undefined) {
    await ctx.db.patch(jobId, { scheduledAt: to.movedTo })
  }
  const job = await read()
  if (job.status === to.status) return

  switch (to.status) {
    case 'recurring':
      throw new Error('demo: nothing moves a job into recurring')
    case 'pending':
      await ctx.db.patch(jobId, { status: 'pending' })
      return
    case 'booked':
      // The legacy row: moved to the retired inProgress (stamping startedAt)
      // and back to booked by the jobStatusV1 migration.
      await ctx.db.patch(jobId, {
        status: 'booked',
        ...(to.startedAt !== undefined ? { startedAt: to.startedAt } : {}),
      })
      return
    case 'completed':
      await setJobStatus(ctx, job, 'completed', {
        completedAt: to.completedAt ?? Date.now(),
      })
      return
    case 'invoiced':
      if (to.completedAt !== undefined) {
        await setJobStatus(ctx, job, 'completed', {
          completedAt: to.completedAt,
        })
      }
      await ctx.db.patch(jobId, { status: 'invoiced' })
      return
    case 'cancelled':
      await setJobStatus(ctx, job, 'cancelled')
      return
  }
}

/** When a job was marked done: soon after it ended, never later than now. */
function doneAt(
  scheduledAt: number,
  durationMinutes: number,
  i: number,
  now: number,
) {
  return Math.min(
    scheduledAt + (durationMinutes + 3 + (i % 4) * 6) * MINUTE,
    now,
  )
}

function propertyOf(
  properties: Record<string, Id<'properties'>>,
  key: string,
): Id<'properties'> {
  const id = properties[key]
  if (!id) throw new ConvexError(`demo: no property "${key}"`)
  return id
}

/**
 * Every one-off job: the named ones later steps look up, six months of
 * history, today, and the weeks ahead, plus the photos on one of them.
 * Returns an entry for each, keyed where it is a named job.
 */
/**
 * The client's own reference for a job (jobs.create's `workOrder`), in each
 * commercial client's format — and missing on every fourth, as it is when a
 * portal has not issued one yet and the office is chasing it. Residential
 * work has none.
 */
function workOrderFor(propertyKey: string, i: number): string | undefined {
  if (i % 4 === 3) return undefined
  if (propertyKey.startsWith('ridge')) return `WO-${448120 + i}`
  if (propertyKey.startsWith('ppm')) return `PO ${4500123456 + i * 17}`
  if (propertyKey.startsWith('coast')) return `SC#${12345 + i}-0${(i % 9) + 1}`
  if (propertyKey === 'kewdaleWarehouse') {
    // Pasted whole from the client's portal: long, but within the limit.
    return `FM job ${55012 + i} / cost centre 7710-MAINT / approver R Chan`
  }
  return undefined
}

export const seedOneOff = internalMutation({
  args: { base: demoBaseV, properties: propertyMapV },
  returns: v.array(manifestJobV),
  handler: async (ctx, { base, properties }) => {
    const now = Date.now()
    const cal = calendar(base)
    const tenure = await tenureOf(ctx, base)

    const planned = seedOneOffs(base, cal, tenure, properties, now)
    const ordered = planned
      .map((job, i) => ({
        job,
        bookedAt: bookingTime(base, tenure, job, i, now),
      }))
      .sort((a, b) => a.bookedAt - b.bookedAt)

    const manifest: Array<ManifestJob> = []
    for (const [i, { job, bookedAt: createdAt }] of ordered.entries()) {
      // jobs.create: the property checked against the business, the next
      // number, and a pending job.
      const propertyId = await resolvePropertyId(ctx, base.businessId, {
        propertyId: propertyOf(properties, job.propertyKey),
      })
      const jobNumber = await allocateJobNumber(ctx, base.businessId)
      const workOrder = normaliseWorkOrder(workOrderFor(job.propertyKey, i))
      const jobId = await ctx.db.insert('jobs', {
        businessId: base.businessId,
        assignedMembershipId: base.members[job.assignee],
        jobType: job.jobType,
        price: job.price,
        scheduledAt: job.scheduledAt,
        durationMinutes: job.durationMinutes,
        propertyId,
        status: initialJobStatus('manual'),
        createdAt,
        jobNumber,
        ...(workOrder !== undefined && { workOrder }),
      })
      const finished =
        (job.status === 'completed' || job.status === 'invoiced') &&
        !job.billedAhead
      await settle(ctx, jobId, {
        status: job.status,
        ...(finished
          ? {
              completedAt: doneAt(job.scheduledAt, job.durationMinutes, i, now),
            }
          : {}),
        ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
      })
      manifest.push({
        ...(job.key ? { key: job.key } : {}),
        id: jobId,
        propertyKey: job.propertyKey,
        assignee: job.assignee,
        status: job.status,
        scheduledAt: job.scheduledAt,
        durationMinutes: job.durationMinutes,
        jobType: job.jobType,
      })
    }

    // Three photos on the bird-proofing job, as jobs.addPhoto adds them one
    // at a time during the visit: `order` is how many were there already.
    const photoJob = manifest.find((m) => m.key === 'photoJob')
    const photos = base.images.photos
    if (!photoJob || photos.length < 3) {
      throw new ConvexError('demo: no photo job, or fewer than three photos')
    }
    const shots: Array<{ photo: number; caption?: string; mm: number }> = [
      { photo: 0, caption: 'Pigeon spikes along the north parapet', mm: 25 },
      { photo: 2, caption: 'Netting over the plant deck, before', mm: 70 },
      { photo: 1, mm: 108 },
    ]
    for (const [order, shot] of shots.entries()) {
      await ctx.db.insert('jobPhotos', {
        jobId: photoJob.id,
        storageId: photos[shot.photo].storageId,
        ...(shot.caption ? { caption: shot.caption } : {}),
        order,
        createdAt: photoJob.scheduledAt + shot.mm * MINUTE,
      })
    }

    return manifest
  },
})

// ─────────────────────────────────────────────────────────── the series

type PastPlan = { status: JobStatus; movedMinutes?: number }

type SeriesSpec = {
  key: string
  propertyKey: string
  assignee: Worker
  interval: Interval
  jobType: string
  price: number
  anchorDate: number
  /** When recurrences.create ran; absent for today, at the moment of
   * seeding. */
  createdAt?: number
  /** The first visit's length, as the booking form sent it. */
  durationMinutes: number
  /** A standing work order (recurrences.create), copied onto every visit. */
  workOrder?: string
  /** What became of each visit whose day has passed: `i` is its place among
   * them (0 the first), `count` how many there are, `day` its offset from
   * today. */
  past?: (i: number, count: number, day: number) => PastPlan
}

/**
 * The Recurring Jobs, each anchored relative to the seed's today. Shared by
 * both steps: the one-offs are planned around these visits.
 */
function seriesPlan(base: DemoBase, cal: Calendar): Array<SeriesSpec> {
  const when = (day: number, hh: number, mm = 0) => at(base, day, hh, mm)
  const weekOf = (day: number) => ((day % 7) + 7) % 7

  // Twelve-odd weeks back on a weekday that is not today's, so no visit is
  // due today and the last one was in the past six days.
  const weeklyDay = cal.nearestWorkday(-85, (d) => weekOf(d) !== 0)
  // Ten weeks back, on another weekday again.
  const stoppedDay = cal.nearestWorkday(
    -71,
    (d) => weekOf(d) !== 0 && weekOf(d) !== weekOf(weeklyDay),
  )
  // The 31st of the latest month before this one that has one.
  let clampDay = 0
  for (let back = 1; back <= 3; back++) {
    const total = cal.year * 12 + (cal.month - 1) - back
    const [y, m] = [Math.floor(total / 12), (total % 12) + 1]
    if (daysInMonth(y, m) === 31) {
      clampDay = cal.offsetOf(`${monthKeyOf(total)}-31`)
      break
    }
  }
  // Today's date in the latest earlier month that has it, so a monthly
  // series from there comes due today and not on a clamped day.
  const [, , todayDate] = keyParts(base.todayKey)
  let dueDay = 0
  for (let back = 1; back <= 12; back++) {
    const total = cal.year * 12 + (cal.month - 1) - back
    const [y, m] = [Math.floor(total / 12), (total % 12) + 1]
    if (daysInMonth(y, m) >= todayDate) {
      dueDay = cal.offsetOf(
        `${monthKeyOf(total)}-${String(todayDate).padStart(2, '0')}`,
      )
      break
    }
  }
  const quarterlyDay = cal.nearestWorkday(-146, (d) => d >= -147)

  const settled =
    (recentAfter = -21) =>
    (_i: number, _count: number, day: number): PastPlan => ({
      status: day < recentAfter ? 'invoiced' : 'completed',
    })

  return [
    {
      key: 'weeklySub',
      propertyKey: 'ppm2',
      assignee: 'sub',
      interval: { count: 1, unit: 'week' },
      jobType: 'General Pest Control',
      price: 14500,
      anchorDate: when(weeklyDay, 9),
      createdAt: when(weeklyDay - 3, 16, 40),
      durationMinutes: 60,
      past: (i, count, day) => {
        // Done yesterday or so; the two before that missed, and overdue.
        if (i === count - 1) return { status: 'completed' }
        if (i === count - 2 || i === count - 3) return { status: 'recurring' }
        if (i === 4) return { status: 'cancelled' }
        // Pushed back two hours on the day, then done and billed.
        if (i === 6) return { status: 'invoiced', movedMinutes: 120 }
        return settled()(i, count, day)
      },
    },
    {
      key: 'fortnightlyContractor',
      propertyKey: 'coastRockingham',
      assignee: 'contractor',
      interval: { count: 2, unit: 'week' },
      jobType: 'Rodents',
      price: 16500,
      anchorDate: when(1, 9),
      durationMinutes: 30,
      workOrder: 'SC#20931-01',
    },
    {
      key: 'monthlyClamp',
      propertyKey: 'jennyHome',
      assignee: 'owner',
      interval: { count: 1, unit: 'month' },
      jobType: 'General Pest Control',
      price: 19500,
      anchorDate: when(clampDay, 10),
      createdAt: when(clampDay - 6, 11, 15),
      durationMinutes: 60,
      past: () => ({ status: 'completed' }),
    },
    {
      // An annual service carried over from before the business used the
      // app: anchored on the client's original date, a leap day, so the
      // engine books 28 February (the 29th in a leap year).
      key: 'yearlyLeap',
      propertyKey: 'arthurHome',
      assignee: 'owner',
      interval: { count: 1, unit: 'year' },
      jobType: 'General Pest Control',
      price: 26000,
      anchorDate: when(cal.offsetOf('2024-02-29'), 10),
      createdAt: when(-179, 9, 30),
      durationMinutes: 60,
      past: () => ({ status: 'completed' }),
    },
    {
      // A termite warranty: one visit today, the next in fifteen years.
      key: 'fifteenYears',
      propertyKey: 'arthurHome',
      assignee: 'owner',
      interval: { count: 15, unit: 'year' },
      jobType: 'Termite Inspection',
      price: 38000,
      anchorDate: when(0, 15),
      durationMinutes: 60,
    },
    {
      key: 'everyTwoDays',
      propertyKey: 'harbourCafe',
      assignee: 'dana',
      interval: { count: 2, unit: 'day' },
      jobType: 'Rodent Bait Top-Up',
      price: 4500,
      anchorDate: when(0, 8),
      durationMinutes: 15,
    },
    {
      key: 'quarterlyCommercial',
      propertyKey: 'ridgeMalaga',
      assignee: 'contractor',
      interval: { count: 3, unit: 'month' },
      jobType: 'General Pest Control',
      price: 89000,
      anchorDate: when(quarterlyDay, 7, 30),
      createdAt: when(quarterlyDay - 2, 14, 0),
      durationMinutes: 90,
      // One standing PO for the whole contract, on every visit.
      workOrder: 'WO-448000 (standing)',
      // The strata manager's last visit is still waiting on its invoice.
      past: (i, count) => ({
        status: i === count - 1 ? 'completed' : 'invoiced',
      }),
    },
    {
      key: 'dueToday',
      propertyKey: 'katyaHome',
      assignee: 'owner',
      interval: { count: 1, unit: 'month' },
      jobType: 'Rodents',
      price: 12000,
      anchorDate: when(dueDay, 14),
      createdAt: when(dueDay - 2, 10, 20),
      durationMinutes: 45,
      past: () => ({ status: 'completed' }),
    },
    {
      key: 'stopped',
      propertyKey: 'coastScarborough',
      assignee: 'contractor',
      interval: { count: 1, unit: 'week' },
      jobType: 'Cockroaches',
      price: 12500,
      anchorDate: when(stoppedDay, 13),
      createdAt: when(stoppedDay - 1, 12, 30),
      durationMinutes: 45,
      // The last one was missed, and stays overdue after the stop.
      past: (i, count, day) =>
        i === count - 1 ? { status: 'recurring' } : settled()(i, count, day),
    },
  ]
}

/**
 * One Recurring Job, as recurrences.create leaves it and the nightly cron has
 * kept it since: the series row, the visit booked by hand at the anchor (when
 * it was not in the past), the first run of the engine, and what became of
 * every visit whose day has now passed. Finally `materialiseOne` with the
 * cron's 60 minutes, which is the cron caught up to today.
 *
 * A series booked in the past has its first run replayed at the moment it was
 * booked, through the engine's own `insertVisit` at `occurrencesFrom`'s
 * instants, so each visit is exactly the one the engine would have made; the
 * write time is then set back to when the engine made it.
 */
async function createSeries(
  ctx: MutationCtx,
  base: DemoBase,
  properties: Record<string, Id<'properties'>>,
  spec: SeriesSpec,
  now: number,
): Promise<{ recurrenceId: Id<'recurrences'>; past: Array<Doc<'jobs'>> }> {
  assertInterval(spec.interval)
  const propertyId = await resolvePropertyId(ctx, base.businessId, {
    propertyId: propertyOf(properties, spec.propertyKey),
  })
  const recurrenceId = await ctx.db.insert('recurrences', {
    businessId: base.businessId,
    propertyId,
    assignedMembershipId: base.members[spec.assignee],
    intervalCount: spec.interval.count,
    intervalUnit: spec.interval.unit,
    jobType: spec.jobType,
    price: spec.price,
    anchorDate: spec.anchorDate,
    active: true,
    ...(spec.workOrder !== undefined && {
      workOrder: normaliseWorkOrder(spec.workOrder),
    }),
  })
  const recurrence = await ctx.db.get(recurrenceId)
  if (!recurrence) throw new Error('demo: a series vanished mid-seed')

  const bookedOn = spec.createdAt ?? now
  // recurrences.create: the first visit is a person's booking unless it was
  // already more than a day gone (isBackfill).
  const madeThen = new Set<number>()
  if (spec.anchorDate >= bookedOn - DAY) {
    await insertVisit(
      ctx,
      recurrence,
      spec.anchorDate,
      spec.durationMinutes,
      'manual',
    )
    madeThen.add(spec.anchorDate)
  }

  if (spec.createdAt === undefined) {
    // Booked today: create's own call, and nothing since.
    await materialiseOne(ctx, recurrenceId, spec.durationMinutes)
    return { recurrenceId, past: [] }
  }

  // The engine's run inside create, as it ran on the day it was booked.
  if (bookedOn + HORIZON_MS < now - DAY) {
    throw new Error(
      `demo: ${spec.key} was booked too long ago to replay from one run`,
    )
  }
  let created = 0
  for (const t of occurrencesFrom(spec.anchorDate, spec.interval, {
    timezone: base.timezone,
    from: bookedOn - DAY,
    until: bookedOn + HORIZON_MS,
    limit: MAX_VISITS_PER_RUN + madeThen.size + 1,
  })) {
    if (madeThen.has(t)) continue
    if (created >= MAX_VISITS_PER_RUN) break
    await insertVisit(ctx, recurrence, t, spec.durationMinutes, 'recurrence')
    madeThen.add(t)
    created++
  }

  // What happened to the visits whose day has come and gone.
  const startOfToday = at(base, 0, 0)
  const visits = await ctx.db
    .query('jobs')
    .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
    .collect()
  const past = visits
    .filter((job) => occurrenceOf(job) < startOfToday)
    .sort((a, b) => occurrenceOf(a) - occurrenceOf(b))
  for (const [i, visit] of past.entries()) {
    const plan = spec.past?.(
      i,
      past.length,
      Math.floor((occurrenceOf(visit) - startOfToday) / DAY),
    ) ?? { status: 'completed' }
    const movedTo =
      plan.movedMinutes !== undefined
        ? visit.scheduledAt + plan.movedMinutes * MINUTE
        : undefined
    const endsAt = movedTo ?? visit.scheduledAt
    await settle(ctx, visit._id, {
      status: plan.status,
      ...(movedTo !== undefined ? { movedTo } : {}),
      ...(plan.status === 'completed' || plan.status === 'invoiced'
        ? { completedAt: doneAt(endsAt, visit.durationMinutes, i, now) }
        : {}),
    })
  }

  // The nightly cron, every night since: 60-minute visits out to the horizon.
  await materialiseOne(ctx, recurrenceId)

  // Dated when the engine wrote them: the first run on the day of booking,
  // the cron's on the night each came inside the horizon.
  const all = await ctx.db
    .query('jobs')
    .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
    .collect()
  for (const job of all) {
    const t = occurrenceOf(job)
    const createdAt = madeThen.has(t)
      ? bookedOn
      : Math.min(now, Math.max(bookedOn, t - HORIZON_MS))
    if (job.createdAt !== createdAt) await ctx.db.patch(job._id, { createdAt })
  }

  const settledPast = []
  for (const visit of past) {
    const fresh = await ctx.db.get(visit._id)
    if (fresh) settledPast.push(fresh)
  }
  return { recurrenceId, past: settledPast }
}

type Made = Awaited<ReturnType<typeof createSeries>>

function occurrenceOf(job: Doc<'jobs'>): number {
  return job.occurrenceAt ?? job.scheduledAt
}

async function visitsOf(ctx: MutationCtx, recurrenceId: Id<'recurrences'>) {
  const visits = await ctx.db
    .query('jobs')
    .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
    .collect()
  return visits.sort((a, b) => occurrenceOf(a) - occurrenceOf(b))
}

/**
 * The Recurring Jobs and every visit they made, and the three things done to
 * them since (a visit moved, one handed to the subcontractor, one series
 * stopped), plus last week's service converted into one.
 *
 * Runs after seedOneOff, so its visits have the later job numbers and
 * `_creationTime`s whenever they were projected: a series' finished visits
 * sit above the one-offs on the Job tab. Nothing can backdate either.
 */
export const seedSeries = internalMutation({
  args: {
    base: demoBaseV,
    properties: propertyMapV,
  },
  returns: v.array(manifestJobV),
  handler: async (ctx, { base, properties }) => {
    const now = Date.now()
    const specs = seriesPlan(base, calendar(base))

    const made = new Map<string, Made>()
    for (const spec of specs) {
      made.set(spec.key, await createSeries(ctx, base, properties, spec, now))
    }
    const series = (key: string): Made => {
      const found = made.get(key)
      if (!found) throw new Error(`demo: no series ${key}`)
      return found
    }

    // A visit next month moved two hours later (jobs.update), still a
    // projection: it keeps its occurrence, so the cron books nothing there.
    const weeklyAhead = (
      await visitsOf(ctx, series('weeklySub').recurrenceId)
    ).filter((job) => job.scheduledAt > now)
    const toMove = weeklyAhead.at(4)
    if (toMove) {
      await settle(ctx, toMove._id, {
        status: toMove.status,
        movedTo: toMove.scheduledAt + 2 * HOUR,
      })
    }

    // One of the owner's monthly visits handed to the subcontractor
    // (jobs.update): the sub sees that visit, but not the series.
    const clampAhead = (
      await visitsOf(ctx, series('monthlyClamp').recurrenceId)
    ).filter((job) => job.scheduledAt > now)
    const toReassign = clampAhead.at(1)
    if (!toReassign) throw new Error('demo: monthlyClamp has no second visit')
    await ctx.db.patch(toReassign._id, {
      assignedMembershipId: base.members.sub,
    })

    // Stopped from its next visit (recurrences.stopFromJob): that one kept as
    // a one-off, the series off, everything after it cancelled. The visit it
    // missed is in the past, so the sweep leaves it, overdue.
    const stoppedId = series('stopped').recurrenceId
    const kept = (await visitsOf(ctx, stoppedId)).find(
      (job) => job.scheduledAt > now,
    )
    if (!kept) throw new Error('demo: the stopped series has no next visit')
    await ctx.db.patch(kept._id, { recurrenceId: undefined })
    if (kept.status === 'recurring') await setJobStatus(ctx, kept, 'pending')
    await ctx.db.patch(stoppedId, { active: false })
    for (const sibling of await visitsOf(ctx, stoppedId)) {
      if (
        NOT_STARTED_STATUSES.has(sibling.status) &&
        sibling.scheduledAt > now
      ) {
        await setJobStatus(ctx, sibling, 'cancelled')
      }
    }

    // ── The manifest: every visit this step made, as it ended up ─────────
    const memberKeys = new Map(
      MEMBER_KEYS.map((key) => [base.members[key], key]),
    )
    const overdueWeek = series('weeklySub').past.at(-2)
    const dueTodayAt = at(base, 0, 14)
    const entry = (
      recurrenceKey: string,
      propertyKey: string,
      visit: Doc<'jobs'>,
    ): ManifestJob => {
      const assignee = memberKeys.get(visit.assignedMembershipId)
      if (!assignee) throw new Error('demo: a visit is on nobody in the demo')
      const key =
        visit._id === overdueWeek?._id
          ? NAMED_VISITS.overdueWeek
          : recurrenceKey === 'dueToday' && visit.occurrenceAt === dueTodayAt
            ? NAMED_VISITS.dueToday
            : undefined
      return {
        ...(key ? { key } : {}),
        id: visit._id,
        propertyKey,
        assignee,
        status: visit.status,
        scheduledAt: visit.scheduledAt,
        durationMinutes: visit.durationMinutes,
        jobType: visit.jobType,
        recurrenceKey,
      }
    }

    const manifest: Array<ManifestJob> = []
    for (const spec of specs) {
      for (const visit of await visitsOf(ctx, series(spec.key).recurrenceId)) {
        manifest.push(entry(spec.key, spec.propertyKey, visit))
      }
    }
    // Off the series now, but made by it.
    const keptNow = await ctx.db.get(kept._id)
    const stoppedSpec = specs.find((s) => s.key === 'stopped')
    if (keptNow && stoppedSpec) {
      manifest.push(entry('stopped', stoppedSpec.propertyKey, keptNow))
    }
    for (const key of Object.values(NAMED_VISITS)) {
      if (!manifest.some((m) => m.key === key)) {
        throw new Error(`demo: the series made no ${key}`)
      }
    }
    return manifest
  },
})

/**
 * Last week's general service, turned into a quarterly contract
 * (recurrences.convertJobToRecurring): the job keeps its status and becomes
 * the series' first visit. Its own step, after the one-offs, because it
 * converts one of them — while the series run BEFORE the one-offs, so that
 * their long-ago visits sit where the Job tab (newest first by creation)
 * would have them: under the work booked since.
 */
export const convertOne = internalMutation({
  args: { base: demoBaseV, oneOff: v.array(manifestJobV) },
  returns: v.array(manifestJobV),
  handler: async (ctx, { base, oneOff }) => {
    // Last week's general service, turned into a quarterly contract
    // (recurrences.convertJobToRecurring): the job keeps its status and
    // becomes the series' first visit.
    const weekAgo = at(base, -7, 0)
    const target = oneOff
      .filter(
        (job) =>
          job.key === undefined &&
          job.status === 'completed' &&
          job.jobType === 'General Pest Control' &&
          job.assignee !== 'former' &&
          job.scheduledAt >= at(base, -10, 0) &&
          job.scheduledAt < at(base, -4, 0),
      )
      .sort(
        (a, b) =>
          Math.abs(a.scheduledAt - weekAgo) - Math.abs(b.scheduledAt - weekAgo),
      )
      .at(0)
    const job = target ? await ctx.db.get(target.id) : null
    if (!target || !job || job.businessId !== base.businessId) {
      throw new ConvexError('demo: no completed service last week to convert')
    }
    const quarterly: Interval = { count: 3, unit: 'month' }
    assertInterval(quarterly)
    const convertedId = await ctx.db.insert('recurrences', {
      businessId: base.businessId,
      propertyId: job.propertyId,
      assignedMembershipId: job.assignedMembershipId,
      intervalCount: quarterly.count,
      intervalUnit: quarterly.unit,
      jobType: job.jobType,
      price: job.price,
      anchorDate: job.scheduledAt,
      active: true,
      // convertJobToRecurring: the job's work order becomes the series'.
      ...(job.workOrder !== undefined && { workOrder: job.workOrder }),
    })
    await ctx.db.patch(job._id, {
      recurrenceId: convertedId,
      occurrenceAt: job.scheduledAt,
    })
    await materialiseOne(ctx, convertedId, job.durationMinutes)

    const memberKeys = new Map(
      MEMBER_KEYS.map((key) => [base.members[key], key]),
    )
    const manifest: Array<ManifestJob> = []
    // The converted job itself is already in the one-offs' manifest.
    for (const visit of await visitsOf(ctx, convertedId)) {
      if (visit._id === job._id) continue
      const assignee = memberKeys.get(visit.assignedMembershipId)
      if (!assignee) throw new Error('demo: a visit is on nobody in the demo')
      manifest.push({
        id: visit._id,
        propertyKey: target.propertyKey,
        assignee,
        status: visit.status,
        scheduledAt: visit.scheduledAt,
        durationMinutes: visit.durationMinutes,
        jobType: visit.jobType,
        recurrenceKey: 'converted',
      })
    }
    return manifest
  },
})
