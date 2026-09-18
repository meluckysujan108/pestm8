import { useState } from 'react'
import type { JobStatus } from '#/components/primitives/StatusPill'

export type StatusFilter = 'all' | JobStatus

export const STATUS_OPTIONS: Array<{ value: JobStatus; label: string }> = [
  { value: 'booked', label: 'Booked' },
  { value: 'inProgress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'invoiced', label: 'Invoiced' },
]

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
 * present in `jobs` are included, so someone with zero jobs today never
 * shows up as "(0)".
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
  }>,
): Array<StaffLoad> {
  const byId = new Map<string, StaffLoad>()
  for (const job of jobs) {
    const row = byId.get(job.assignedMembershipId)
    if (row) {
      row.count += 1
      continue
    }
    byId.set(job.assignedMembershipId, {
      membershipId: job.assignedMembershipId,
      name: job.assigneeName || 'Unassigned',
      colour: job.assigneeColour ?? '#8E8E93',
      count: 1,
    })
  }
  return [...byId.values()].sort((a, b) => b.count - a.count)
}

export function useScheduleFilters<
  T extends { status: JobStatus; assignedMembershipId: string },
>(jobs: Array<T>, defaultStaffId: string = 'all') {
  const [status, setStatus] = useState<StatusFilter>('all')
  // Defaults to the viewer's own jobs, not everyone's — "All staff" is a
  // deliberate switch, not the starting point.
  const [staffId, setStaffId] = useState<string>(defaultStaffId)

  /**
   * Follow the account being worked in.
   *
   * `useState` takes the default once, so without this a switch leaves the
   * filter pinned to whoever you were — and since the picker hides itself when
   * there is only one person left to choose, you land on "No matching jobs"
   * with the control that caused it no longer on screen. React's documented
   * way to adjust state when a prop changes, rather than an effect that would
   * render the empty list first and correct it afterwards.
   */
  const [lastDefault, setLastDefault] = useState(defaultStaffId)
  if (lastDefault !== defaultStaffId) {
    setLastDefault(defaultStaffId)
    setStaffId(defaultStaffId)
  }

  const filteredJobs = jobs.filter(
    (job) =>
      (status === 'all' || job.status === status) &&
      (staffId === 'all' || job.assignedMembershipId === staffId),
  )

  return { status, setStatus, staffId, setStaffId, filteredJobs }
}
