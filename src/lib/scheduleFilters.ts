import { useEffect, useState } from 'react'
import { JOB_STATUS } from '#/lib/statusColours'
import { travelHintsFor } from '#/lib/travel'
import type { Coords } from '#/lib/travel'
import type { JobStatus } from '#/components/primitives/StatusPill'
import type { JobListStatus } from '#/lib/routeQueries'
import { UNASSIGNED_COLOUR } from '../../convex/lib/colours'
import { sinksOnDay } from '../../convex/lib/jobStatus'
import { splitJobTypes } from '../../convex/lib/jobTypes'

// Pending is here because every job booked by hand now starts there — without
// it "Booked" would quietly stop matching new work.
//
// No Cancelled: `jobs.listDay` never returns a cancelled job, so the filter
// could only ever empty the day. No Recurring either, though `listDay` does
// return projections once their day has come, and carries overdue ones onto
// today (convex/jobs.ts): they are work nobody has booked, marked as such on
// their cards and counted apart in the day's header, and read in full in the
// Recurring Job view.
export const SCHEDULE_FILTER_STATUSES = [
  'pending',
  'booked',
  'completed',
  'invoiced',
  'paid',
] as const satisfies ReadonlyArray<JobStatus>

export type StatusFilter = 'all' | (typeof SCHEDULE_FILTER_STATUSES)[number]

export const STATUS_OPTIONS: Array<{
  value: (typeof SCHEDULE_FILTER_STATUSES)[number]
  label: string
}> = SCHEDULE_FILTER_STATUSES.map((value) => ({
  value,
  label: JOB_STATUS[value].label,
}))

/** How the day's cards are ordered. */
export type DaySort = 'time' | 'suburb' | 'technician'

export const DAY_SORT_OPTIONS: Array<{ value: DaySort; label: string }> = [
  { value: 'time', label: 'Time' },
  { value: 'suburb', label: 'Suburb' },
  { value: 'technician', label: 'Technician' },
]

/** How the Recurring view's services are ordered, By service. */
export type RecurringSort = 'toBook' | 'next' | 'client'

export const RECURRING_SORT_OPTIONS: Array<{
  value: RecurringSort
  label: string
}> = [
  { value: 'toBook', label: 'To book first' },
  { value: 'next', label: 'Next visit' },
  { value: 'client', label: 'Client A–Z' },
]

/**
 * `?sort=` as the address holds it: the Job view's or the Recurring view's,
 * each at its default left out. One parameter, since no two views share a
 * sort; each reads its own and leaves the other's, so a day sorted by suburb
 * is still sorted so after a look at the week.
 */
export const SCHEDULE_SORTS = [
  'suburb',
  'technician',
  'next',
  'client',
] as const

export type SortParam = (typeof SCHEDULE_SORTS)[number]

export function daySortOf(sort: SortParam | undefined): DaySort {
  return sort === 'suburb' || sort === 'technician' ? sort : 'time'
}

export function recurringSortOf(sort: SortParam | undefined): RecurringSort {
  return sort === 'next' || sort === 'client' ? sort : 'toBook'
}

/** A sort as the address writes it: nothing at its view's default. */
export function sortParamOf(
  sort: DaySort | RecurringSort,
): SortParam | undefined {
  return sort === 'time' || sort === 'toBook' ? undefined : sort
}

/**
 * The Schedule's filters as its address holds them (`?status=`, `?staff=`,
 * `?service=`), each left out while it is at its default — every status,
 * whoever the device opens on, every service — so an address with none is
 * the day as it opens. With them, the sort (`?sort=`), which is no filter:
 * it hides nothing, so nothing clears it but picking another.
 */
export type ScheduleFilterSearch = {
  status?: Exclude<StatusFilter, 'all'>
  /** A membership's id, or `all` where the device opens on someone. */
  staff?: string
  /** A service, as a job type names it. */
  service?: string
  sort?: SortParam
}

/**
 * The Job tab's filter. That list holds every job somebody booked, whatever
 * its status, so unlike the schedule's it can offer Cancelled. It holds no
 * projected visits (`jobs.list` in convex/jobs.ts), so there is no Recurring:
 * those are the Recurring Job view's (src/lib/jobViews.ts).
 */
const JOB_LIST_STATUSES = [
  'pending',
  'booked',
  'completed',
  'invoiced',
  'paid',
  'cancelled',
] as const satisfies ReadonlyArray<JobListStatus>

export const JOB_LIST_STATUS_OPTIONS: Array<{
  value: JobListStatus
  label: string
}> = JOB_LIST_STATUSES.map((value) => ({
  value,
  label: JOB_STATUS[value].label,
}))

/**
 * The Job tab's `?status=`, as one of those or none.
 *
 * The route's search validation and its loader both read the address
 * through this. The status is now an argument to the server, so the two have
 * to agree to the byte: a loader that warmed `?status=recurring` as asked
 * would warm a query the server refuses, under a key the page — which reads
 * no status at all — never asks for.
 */
export function parseJobListStatus(raw: unknown): JobListStatus | undefined {
  return JOB_LIST_STATUSES.find((status) => status === raw)
}

export type StaffLoad = {
  membershipId: string
  name: string
  colour: string
  count: number
}

/**
 * "Who's on today, and how many jobs each of them has" — mirrors
 * `monthTeamLoad`'s accumulation/sort shape (convex/jobs.ts), but pure and
 * client-side since a single day's jobs are already fully loaded. Only staff
 * present in `jobs` are included, so someone with nothing on today never
 * shows up as "(0)".
 *
 * The count is of booked jobs only. The day's list also holds projected
 * visits once their day has come, and those are in no job count anywhere
 * (brief §2, and `jobsInRange` in convex/jobs.ts) — this is the team legend's
 * number for one day, so it keeps the same rule. Someone whose only visit
 * today is a projection is still listed, at 0, so the filter can still find
 * it.
 *
 * The name comes off the job rather than from a join against the roster: the
 * job carries its assignee's name already (`jobs.decorate`), and a join would
 * put anyone missing from the roster — someone removed since — into a bucket
 * labelled "Unassigned", which is wrong, since every job has an assignee.
 */
export function computeStaffLoad(
  jobs: Array<{
    assignedMembershipId: string
    assigneeName?: string
    assigneeColour?: string
    /** Everyone going beside the lead: a shared job is in each one's count. */
    alsoGoing?: ReadonlyArray<{ _id: string; name: string; colour: string }>
    status?: JobStatus
  }>,
): Array<StaffLoad> {
  const byId = new Map<string, StaffLoad>()
  const add = (
    membershipId: string,
    name: string | undefined,
    colour: string | undefined,
    counts: number,
  ) => {
    const row = byId.get(membershipId)
    if (row) {
      row.count += counts
      return
    }
    byId.set(membershipId, {
      membershipId,
      name: name || 'Unassigned',
      colour: colour ?? UNASSIGNED_COLOUR,
      count: counts,
    })
  }
  for (const job of jobs) {
    const counts = job.status !== 'recurring' ? 1 : 0
    add(job.assignedMembershipId, job.assigneeName, job.assigneeColour, counts)
    for (const person of job.alsoGoing ?? []) {
      add(person._id, person.name, person.colour, counts)
    }
  }
  return [...byId.values()].sort((a, b) => b.count - a.count)
}

/** Whether this person is on the job: its lead, or also going. */
export function isOnJob(
  job: {
    assignedMembershipId: string
    alsoGoing?: ReadonlyArray<{ _id: string }>
  },
  membershipId: string,
): boolean {
  return (
    job.assignedMembershipId === membershipId ||
    (job.alsoGoing ?? []).some((person) => person._id === membershipId)
  )
}

/**
 * Whether the job is for this service: one of those its label joins
 * ("General Pest Control, Termites" is for both), whatever the case.
 */
export function hasService(job: { jobType: string }, service: string): boolean {
  const wanted = service.toLowerCase()
  return splitJobTypes(job.jobType).some((s) => s.toLowerCase() === wanted)
}

/**
 * The services the day's jobs are for, A–Z, each named once as it was first
 * spelt — and the one chosen, should no job today be for it, so the choice
 * that emptied the day is still there to take back.
 */
export function servicesOf(
  jobs: ReadonlyArray<{ jobType: string }>,
  chosen: string,
): Array<string> {
  const byKey = new Map<string, string>()
  for (const job of jobs) {
    for (const service of splitJobTypes(job.jobType)) {
      const key = service.toLowerCase()
      if (!byKey.has(key)) byKey.set(key, service)
    }
  }
  if (chosen !== 'all' && !byKey.has(chosen.toLowerCase())) {
    byKey.set(chosen.toLowerCase(), chosen)
  }
  return [...byKey.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
}

type DayJob = {
  status: JobStatus
  jobType: string
  assignedMembershipId: string
  alsoGoing?: ReadonlyArray<{ _id: string }>
}

/** The day's jobs a status, a person and a service let through. */
export function filterDayJobs<T extends DayJob>(
  jobs: Array<T>,
  status: StatusFilter,
  staffId: string,
  service = 'all',
): Array<T> {
  return jobs.filter(
    (job) =>
      (status === 'all' || job.status === status) &&
      // Kevin's filter keeps the jobs he is also going on.
      (staffId === 'all' || isOnJob(job, staffId)) &&
      (service === 'all' || hasService(job, service)),
  )
}

/**
 * The day's jobs in the order a sort lays them out. By time, as the server
 * sent them (`orderForDay`: by start, finished work last). By suburb or by
 * technician — the lead's name, and so the colour down the cards — finished
 * work still goes last, so what is ahead leads the day as it always has, and
 * each suburb's or person's own jobs run in time order.
 */
export function sortDayJobs<
  T extends {
    status: JobStatus
    scheduledAt: number
    completedAt?: number
    suburb: string
    assigneeName?: string
    assignedMembershipId: string
  },
>(jobs: Array<T>, sort: DaySort): Array<T> {
  if (sort === 'time') return jobs
  const keyOf = (job: T) =>
    (sort === 'suburb' ? job.suburb : job.assigneeName)?.trim() ?? ''
  return [...jobs].sort(
    (a, b) =>
      Number(sinksOnDay(a)) - Number(sinksOnDay(b)) ||
      // A job with no suburb (or a lead without a name) after the rest.
      Number(keyOf(a) === '') - Number(keyOf(b) === '') ||
      keyOf(a).localeCompare(keyOf(b), undefined, { sensitivity: 'base' }) ||
      // Two people of one name are still two runs of cards.
      (sort === 'technician'
        ? a.assignedMembershipId.localeCompare(b.assignedMembershipId)
        : 0) ||
      a.scheduledAt - b.scheduledAt,
  )
}

/**
 * The hop above each card, for the cards in the order a sort lays them out
 * (`travelHintsFor`). By time, the day's route. By technician, each person's
 * own, begun again at each: the hop from one person's last job to the next
 * person's first is a trip nobody makes. By suburb, none — the card above is
 * the next suburb along the alphabet, not where anyone has just been.
 */
export function dayTravelHints<
  T extends { _id: string; suburb: string; assignedMembershipId: string },
>(
  jobs: Array<T>,
  sort: DaySort,
  coordsFor: (job: T) => Coords | undefined,
): Record<string, string | null> {
  if (sort === 'suburb') return {}
  if (sort === 'time') return travelHintsFor(jobs, coordsFor)
  const byLead = new Map<string, Array<T>>()
  for (const job of jobs) {
    byLead.set(job.assignedMembershipId, [
      ...(byLead.get(job.assignedMembershipId) ?? []),
      job,
    ])
  }
  return Object.assign(
    {},
    ...[...byLead.values()].map((run) => travelHintsFor(run, coordsFor)),
  ) as Record<string, string | null>
}

/**
 * The address's filters as they are written back: each left out at its
 * default, so the address never says what the day would show anyway.
 */
export function filterSearchOf(
  status: StatusFilter,
  staffId: string,
  defaultStaffId: string,
  service = 'all',
): ScheduleFilterSearch {
  return {
    status: status === 'all' ? undefined : status,
    staff: staffId === defaultStaffId ? undefined : staffId,
    service: service === 'all' ? undefined : service,
  }
}

/**
 * The Schedule's filters and the day's sort, held in its address (§5: views
 * and filters live in the URL), so a reload, Back and a link keep them.
 *
 * `defaultStaffId` is who the device opens on: the viewer's own jobs on the
 * phone, everyone on a desktop. An address without `staff` is that, so the
 * filter follows the account being worked in by itself — a switch that left
 * it pinned to whoever you were would land on "No matching jobs" with the
 * picker that caused it hidden, since it hides when there is only one person
 * left to choose.
 *
 * The person is the Week's and the Recurring view's filter too, so Kevin's
 * day, Kevin's week and Kevin's services are one choice. Status and service
 * are the day's alone.
 */
export function useScheduleFilters<
  T extends DayJob & {
    scheduledAt: number
    suburb: string
    assigneeName?: string
  },
>({
  jobs,
  search,
  onSearchChange,
  defaultStaffId = 'all',
  resetKey = '',
}: {
  jobs: Array<T>
  search: ScheduleFilterSearch
  /** Writes the filters back into the address, in place. */
  onSearchChange: (next: ScheduleFilterSearch) => void
  defaultStaffId?: string
  resetKey?: string
}): ScheduleFilters<T> {
  /**
   * And start over when the view changes. Filtered to Kevin in God view, then
   * switched to "Just my jobs", the list would hold only the owner's jobs and
   * the filter would still want Kevin's — "No matching jobs", with the staff
   * picker hidden in that view and so no way to see why. A different view is
   * a different question; its filters begin from nothing. The sort stays:
   * it hides nothing.
   *
   * The view is the server's, so nothing navigates when it changes: what the
   * address held then is set aside at once (React's way to adjust state as a
   * prop changes, so the empty list is never drawn first), and taken out of
   * the address straight after. A filter picked meanwhile counts as picked.
   */
  const [lastKey, setLastKey] = useState(resetKey)
  const [setAside, setSetAside] = useState<ScheduleFilterSearch | null>(null)
  if (lastKey !== resetKey) {
    setLastKey(resetKey)
    setSetAside({
      status: search.status,
      staff: search.staff,
      service: search.service,
    })
  }
  const outdated =
    setAside !== null &&
    setAside.status === search.status &&
    setAside.staff === search.staff &&
    setAside.service === search.service
  if (setAside !== null && !outdated) setSetAside(null)
  const written =
    search.status !== undefined ||
    search.staff !== undefined ||
    search.service !== undefined
  const sortParam = search.sort
  useEffect(() => {
    if (outdated && written) onSearchChange({ sort: sortParam })
  }, [outdated, written, sortParam, onSearchChange])

  const shown = outdated ? {} : search
  const status: StatusFilter = shown.status ?? 'all'
  // Defaults to the viewer's own jobs on the phone, not everyone's —
  // "Everyone" is a deliberate switch there, not the starting point.
  const staffId = shown.staff ?? defaultStaffId
  const service = shown.service ?? 'all'
  const sort = daySortOf(sortParam)
  const write = (
    next: Partial<{
      status: StatusFilter
      staffId: string
      service: string
      sort: SortParam | undefined
    }>,
  ) =>
    onSearchChange({
      ...filterSearchOf(
        next.status ?? status,
        next.staffId ?? staffId,
        defaultStaffId,
        next.service ?? service,
      ),
      sort: 'sort' in next ? next.sort : sortParam,
    })

  return {
    status,
    staffId,
    service,
    sort,
    setStatus: (next: StatusFilter) => write({ status: next }),
    setStaffId: (next: string) => write({ staffId: next }),
    setService: (next: string) => write({ service: next }),
    setSort: (next: DaySort) => write({ sort: sortParamOf(next) }),
    clear: () => write({ status: 'all', staffId: 'all', service: 'all' }),
    filteredJobs: sortDayJobs(
      filterDayJobs(jobs, status, staffId, service),
      sort,
    ),
  }
}

export type ScheduleFilters<T> = {
  status: StatusFilter
  /** A membership's id, or 'all'. */
  staffId: string
  /** A service, or 'all'. */
  service: string
  sort: DaySort
  setStatus: (next: StatusFilter) => void
  setStaffId: (next: string) => void
  setService: (next: string) => void
  setSort: (next: DaySort) => void
  /** Everything, everyone: what Clear filters means wherever it is. The
   * sort is no filter, and stays. */
  clear: () => void
  /** The day's jobs the filters let through, in the sort's order. */
  filteredJobs: Array<T>
}

/**
 * The dots under a day. One per person, so the owner sees whose day is loaded
 * — except in "Just my jobs", where every job is his and the colours would
 * only repeat one another; there a single neutral dot says there is work.
 */
export function dayDots(
  colours: Array<string>,
  monochrome: boolean,
): Array<string> {
  if (!monochrome) return colours
  return colours.length > 0 ? ['var(--color-muted)'] : []
}
