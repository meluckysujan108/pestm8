import { FilterDropdown } from '#/components/primitives/FilterDropdown'
import { STATUS_OPTIONS, computeStaffLoad } from '#/lib/scheduleFilters'
import type { StatusFilter } from '#/lib/scheduleFilters'
import type { JobRow } from './JobCard'

/**
 * Status + staff filter chips, shared byte-for-byte between the desktop day
 * panel and the mobile day list — both filter the same `jobs` array the same
 * way, so the bar and its filtering logic (useScheduleFilters) live once.
 */
export function ScheduleFilterBar({
  jobs,
  members,
  status,
  setStatus,
  staffId,
  setStaffId,
  hideStaff = false,
}: {
  jobs: Array<JobRow>
  members: Array<{ _id: string; name: string; colour: string }>
  status: StatusFilter
  setStatus: (value: StatusFilter) => void
  staffId: string
  setStaffId: (value: string) => void
  /** "Just my jobs": every job on screen is the viewer's, so choosing whose
   * is no choice at all. Status still filters, and Clear still clears it. */
  hideStaff?: boolean
}) {
  const staffLoad = computeStaffLoad(jobs)
  // The default selection is the viewer's own membership, which may have
  // zero jobs today even though someone else does — make sure it's still a
  // real option (not a raw id string in the trigger) rather than only ever
  // listing staff who already have a job.
  const selectedInLoad = staffLoad.some((s) => s.membershipId === staffId)
  const selectedMember = !selectedInLoad ? members.find((m) => m._id === staffId) : undefined
  const staffOptions = selectedMember
    ? [...staffLoad, { membershipId: selectedMember._id, name: selectedMember.name, colour: selectedMember.colour, count: 0 }]
    : staffLoad
  // A subcontractor without canViewAllJobs only ever sees their own jobs, and
  // a single-tech day is the same case — a dropdown with one real choice is
  // just clutter, so it's hidden rather than shown disabled.
  const showStaffFilter = !hideStaff && staffOptions.length >= 2

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterDropdown
        label="Filter by status"
        value={status}
        onChange={(value) => setStatus(value as StatusFilter)}
        active={status !== 'all'}
        options={[{ value: 'all', label: 'All statuses' }, ...STATUS_OPTIONS]}
      />
      {showStaffFilter && (
        <FilterDropdown
          label="Filter by staff"
          value={staffId}
          onChange={setStaffId}
          active={staffId !== 'all'}
          options={[
            { value: 'all', label: 'All staff' },
            ...staffOptions.map((s) => ({
              value: s.membershipId,
              label: s.name,
              colour: s.colour,
              count: s.count,
            })),
          ]}
        />
      )}
      {(status !== 'all' || (!hideStaff && staffId !== 'all')) && (
        <button
          type="button"
          onClick={() => {
            setStatus('all')
            setStaffId('all')
          }}
          className="relative tap-target text-caption font-semibold text-blue"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}
