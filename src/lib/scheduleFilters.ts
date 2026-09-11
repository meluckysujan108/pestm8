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
 */
export function computeStaffLoad(
  jobs: Array<{ assignedMembershipId: string }>,
  members: Array<{ _id: string; name: string; colour: string }>,
): Array<StaffLoad> {
  const counts = new Map<string, number>()
  for (const job of jobs) {
    counts.set(
      job.assignedMembershipId,
      (counts.get(job.assignedMembershipId) ?? 0) + 1,
    )
  }
  const byId = new Map(members.map((m) => [m._id, m]))
  return [...counts.entries()]
    .map(([membershipId, count]) => {
      const member = byId.get(membershipId)
      return {
        membershipId,
        name: member?.name || 'Unassigned',
        colour: member?.colour ?? '#8E8E93',
        count,
      }
    })
    .sort((a, b) => b.count - a.count)
}

export function useScheduleFilters<
  T extends { status: JobStatus; assignedMembershipId: string },
>(jobs: Array<T>, defaultStaffId: string = 'all') {
  const [status, setStatus] = useState<StatusFilter>('all')
  // Defaults to the viewer's own jobs, not everyone's — "All staff" is a
  // deliberate switch, not the starting point.
  const [staffId, setStaffId] = useState<string>(defaultStaffId)

  const filteredJobs = jobs.filter(
    (job) =>
      (status === 'all' || job.status === status) &&
      (staffId === 'all' || job.assignedMembershipId === staffId),
  )

  return { status, setStatus, staffId, setStaffId, filteredJobs }
}
