import { useEffect, useState } from 'react'
import { JOB_STATUS } from '#/lib/statusColours'
import type { JobStatus } from '#/components/primitives/StatusPill'
import type { JobListStatus } from '#/lib/routeQueries'
import { UNASSIGNED_COLOUR } from '../../convex/lib/colours'

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
] as const satisfies ReadonlyArray<JobStatus>

export type StatusFilter = 'all' | (typeof SCHEDULE_FILTER_STATUSES)[number]

export const STATUS_OPTIONS: Array<{
  value: (typeof SCHEDULE_FILTER_STATUSES)[number]
  label: string
}> = SCHEDULE_FILTER_STATUSES.map((value) => ({
  value,
  label: JOB_STATUS[value].label,
}))

/**
 * The Schedule's filters as its address holds them (`?status=`, `?staff=`),
 * each left out while it is at its default — every status, and whoever the
 * device opens on — so an address with neither is the day as it opens.
 */
export type ScheduleFilterSearch = {
  status?: Exclude<StatusFilter, 'all'>
  /** A membership's id, or `all` where the device opens on someone. */
  staff?: string
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

/** The day's jobs a status and a person let through. */
export function filterDayJobs<
  T extends {
    status: JobStatus
    assignedMembershipId: string
    alsoGoing?: ReadonlyArray<{ _id: string }>
  },
>(jobs: Array<T>, status: StatusFilter, staffId: string): Array<T> {
  return jobs.filter(
    (job) =>
      (status === 'all' || job.status === status) &&
      // Kevin's filter keeps the jobs he is also going on.
      (staffId === 'all' || isOnJob(job, staffId)),
  )
}

/**
 * The address's filters as they are written back: each left out at its
 * default, so the address never says what the day would show anyway.
 */
export function filterSearchOf(
  status: StatusFilter,
  staffId: string,
  defaultStaffId: string,
): ScheduleFilterSearch {
  return {
    status: status === 'all' ? undefined : status,
    staff: staffId === defaultStaffId ? undefined : staffId,
  }
}

/**
 * The Schedule's status and staff filters, held in its address (§5: views
 * and filters live in the URL), so a reload, Back and a link keep them.
 *
 * `defaultStaffId` is who the device opens on: the viewer's own jobs on the
 * phone, everyone on a desktop. An address without `staff` is that, so the
 * filter follows the account being worked in by itself — a switch that left
 * it pinned to whoever you were would land on "No matching jobs" with the
 * picker that caused it hidden, since it hides when there is only one person
 * left to choose.
 */
export function useScheduleFilters<
  T extends {
    status: JobStatus
    assignedMembershipId: string
    alsoGoing?: ReadonlyArray<{ _id: string }>
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
   * a different question; its filters begin from nothing.
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
    setSetAside({ status: search.status, staff: search.staff })
  }
  const outdated =
    setAside !== null &&
    setAside.status === search.status &&
    setAside.staff === search.staff
  if (setAside !== null && !outdated) setSetAside(null)
  const written = search.status !== undefined || search.staff !== undefined
  useEffect(() => {
    if (outdated && written) onSearchChange({})
  }, [outdated, written, onSearchChange])

  const shown = outdated ? {} : search
  const status: StatusFilter = shown.status ?? 'all'
  // Defaults to the viewer's own jobs on the phone, not everyone's —
  // "Everyone" is a deliberate switch there, not the starting point.
  const staffId = shown.staff ?? defaultStaffId
  const write = (nextStatus: StatusFilter, nextStaffId: string) =>
    onSearchChange(filterSearchOf(nextStatus, nextStaffId, defaultStaffId))

  return {
    status,
    staffId,
    setStatus: (next: StatusFilter) => write(next, staffId),
    setStaffId: (next: string) => write(status, next),
    clear: () => write('all', 'all'),
    filteredJobs: filterDayJobs(jobs, status, staffId),
  }
}

export type ScheduleFilters<T> = {
  status: StatusFilter
  staffId: string
  setStatus: (next: StatusFilter) => void
  setStaffId: (next: string) => void
  /** Everything, everyone: what Clear filters means wherever it is. */
  clear: () => void
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
