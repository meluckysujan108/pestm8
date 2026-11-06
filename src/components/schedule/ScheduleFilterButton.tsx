import {
  FilterButton,
  FilterChips,
  FilterPeople,
  FilterSort,
} from '#/components/primitives/FilterSheet'
import {
  DAY_SORT_OPTIONS,
  STATUS_OPTIONS,
  computeStaffLoad,
  filterDayJobs,
  hasService,
  isOnJob,
  servicesOf,
} from '#/lib/scheduleFilters'
import { useWeekDays } from './WeekView'
import type { ScheduleFilters, StaffLoad } from '#/lib/scheduleFilters'
import type { JobRow } from './JobCard'
import type { Id } from '../../../convex/_generated/dataModel'

type Member = { _id: string; name: string; colour: string }

/**
 * The day's filters and sort behind one icon (`FilterButton`), at the end
 * of the View switch's row: Sort, Status, Service and Technician.
 *
 * They were two chips beside the switch, and a chip is as wide as the word
 * chosen in it: picking a status moved the next chip along, "Clear filters"
 * came and went beside them, and on a phone the three took a row of their
 * own that the Week and Recurring views didn't have, so the cards jumped
 * with every change of view. The icon is one size whatever is chosen.
 *
 * Each choice's count is among the jobs the other filters let through, so a
 * count says what picking it would show. Booked work only: a projected visit
 * is in no count (it is never one of these statuses).
 */
export function ScheduleFilterButton({
  jobs,
  members,
  filters,
  hideStaff = false,
  disabled = false,
}: {
  /** The whole day, before filtering: the counts beside each choice. */
  jobs: Array<JobRow>
  members: Array<Member>
  filters: ScheduleFilters<JobRow>
  /** "Just my jobs": every job on screen is the viewer's, so choosing whose
   * is no choice at all. Status still filters, and Clear still clears it. */
  hideStaff?: boolean
  /** Until the page hydrates, so a tap is never swallowed by inert markup. */
  disabled?: boolean
}) {
  const { status, staffId, service, sort } = filters
  const staffOptions = staffOptionsOf(jobs, members, staffId)
  // A subcontractor without canViewAllJobs only ever sees their own jobs, and
  // a single-tech day is the same case: one real choice is no choice, so the
  // section is left out rather than shown with nothing to pick. A day of one
  // service likewise, unless a service is chosen.
  const showStaff = !hideStaff && staffOptions.length >= 2
  const services = servicesOf(jobs, service)
  const showService = services.length >= 2 || service !== 'all'
  const on =
    Number(status !== 'all') +
    Number(showService && service !== 'all') +
    Number(showStaff && staffId !== 'all')

  const booked = (rows: Array<JobRow>) =>
    rows.filter((job) => job.status !== 'recurring')
  const forStatus = booked(filterDayJobs(jobs, 'all', staffId, service))
  const forService = booked(filterDayJobs(jobs, status, staffId))
  const forStaff = booked(filterDayJobs(jobs, status, 'all', service))
  const chosenService =
    service === 'all'
      ? 'all'
      : (services.find((s) => s.toLowerCase() === service.toLowerCase()) ??
        service)

  return (
    <FilterButton
      title="Filter and sort"
      on={on}
      disabled={disabled}
      onClear={filters.clear}
    >
      <FilterSort
        value={sort}
        // By technician only where there is more than one.
        options={DAY_SORT_OPTIONS.filter(
          (option) => showStaff || option.value !== 'technician',
        )}
        onChange={filters.setSort}
      />
      <FilterChips
        label="Status"
        value={status}
        options={[
          { value: 'all', label: 'All', count: forStatus.length },
          ...STATUS_OPTIONS.map((option) => ({
            ...option,
            count: forStatus.filter((job) => job.status === option.value)
              .length,
          })),
        ]}
        onChange={filters.setStatus}
      />
      {showService && (
        <FilterChips
          label="Service"
          value={chosenService}
          options={[
            { value: 'all', label: 'All', count: forService.length },
            ...services.map((name) => ({
              value: name,
              label: name,
              count: forService.filter((job) => hasService(job, name)).length,
            })),
          ]}
          onChange={filters.setService}
        />
      )}
      {showStaff && (
        <FilterPeople
          value={staffId}
          everyone={forStaff.length}
          people={staffOptions.map((person) => ({
            ...person,
            count: forStaff.filter((job) => isOnJob(job, person.membershipId))
              .length,
          }))}
          onChange={filters.setStaffId}
        />
      )}
    </FilterButton>
  )
}

/**
 * The Week View's filter: whose week. Only the person — a week's statuses
 * and services are the day's to filter. Left out where the week holds no one
 * to choose between.
 */
export function WeekFilterButton({
  businessId,
  weekStart,
  timezone,
  members,
  filters,
  hideStaff = false,
  disabled = false,
}: {
  businessId: Id<'businesses'>
  weekStart: string
  timezone: string
  members: Array<Member>
  filters: ScheduleFilters<JobRow>
  hideStaff?: boolean
  disabled?: boolean
}) {
  const days = useWeekDays(businessId, weekStart, timezone)
  // Someone whose only visits this week are due ones is still in it.
  const rows = days.flatMap((day) => [...day.committed, ...day.dueHere])
  const people = staffOptionsOf(rows, members, filters.staffId)
  if (hideStaff || people.length < 2) return null
  return (
    <FilterButton
      title="Filters"
      on={Number(filters.staffId !== 'all')}
      disabled={disabled}
      onClear={filters.clear}
    >
      <FilterPeople
        value={filters.staffId}
        everyone={rows.filter((job) => job.status !== 'recurring').length}
        people={people}
        onChange={filters.setStaffId}
      />
    </FilterButton>
  )
}

/**
 * Whose jobs the rows hold, with their counts. The default selection is the
 * viewer's own membership, which may have no job today even though someone
 * else does — so it is still offered (not a raw id where a name should be),
 * rather than only ever listing staff who already have a job.
 */
function staffOptionsOf(
  jobs: Array<JobRow>,
  members: Array<Member>,
  staffId: string,
): Array<StaffLoad> {
  const load = computeStaffLoad(jobs)
  if (staffId === 'all' || load.some((s) => s.membershipId === staffId)) {
    return load
  }
  const chosen = members.find((m) => m._id === staffId)
  return chosen
    ? [
        ...load,
        {
          membershipId: chosen._id,
          name: chosen.name,
          colour: chosen.colour,
          count: 0,
        },
      ]
    : load
}
