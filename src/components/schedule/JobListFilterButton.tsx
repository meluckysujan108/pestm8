import {
  FilterButton,
  FilterChips,
  FilterPeople,
  FilterSort,
} from '#/components/primitives/FilterSheet'
import { JOB_LIST_SORT_OPTIONS } from '#/lib/jobViews'
import { JOB_LIST_STATUS_OPTIONS } from '#/lib/scheduleFilters'
import type { JobListSort } from '#/lib/jobViews'
import type { JobListStatus } from '#/lib/routeQueries'

type Member = { _id: string; name: string; colour: string }

/** A change to the Job tab's filters, in its address's terms: `undefined`
 * is each one's default. */
export type JobListFilterChange = {
  status?: JobListStatus
  staff?: string
  sort?: 'visit'
}

/**
 * The Job tab's order, status and person behind one icon (`FilterButton`),
 * at the end of the Job section's switch row.
 *
 * No counts beside the choices: the list is read a page at a time, so what
 * is loaded is no count of what a choice would show (the caption under the
 * row says how many the list holds).
 */
export function JobListFilterButton({
  status,
  staffId,
  sort,
  members,
  showStaff,
  onChange,
  disabled = false,
}: {
  status: JobListStatus | undefined
  /** A membership id, or 'all'. */
  staffId: string
  sort: JobListSort
  members: ReadonlyArray<Member>
  /** Whose is a choice only on the whole business's list, of two or more
   * people: a narrower one is one person's or one team's already. */
  showStaff: boolean
  onChange: (next: JobListFilterChange) => void
  disabled?: boolean
}) {
  const on =
    Number(status !== undefined) + Number(showStaff && staffId !== 'all')
  return (
    <FilterButton
      title="Filter and sort"
      on={on}
      disabled={disabled}
      onClear={() => onChange({ status: undefined, staff: undefined })}
    >
      <FilterSort
        value={sort}
        options={JOB_LIST_SORT_OPTIONS}
        onChange={(next) =>
          onChange({ sort: next === 'booked' ? undefined : next })
        }
      />
      <FilterChips
        label="Status"
        value={status ?? 'all'}
        options={[{ value: 'all', label: 'All' }, ...JOB_LIST_STATUS_OPTIONS]}
        onChange={(next) =>
          onChange({ status: next === 'all' ? undefined : next })
        }
      />
      {showStaff && (
        <FilterPeople
          value={staffId}
          people={members.map((member) => ({
            membershipId: member._id,
            name: member.name,
            colour: member.colour,
          }))}
          onChange={(id) => onChange({ staff: id === 'all' ? undefined : id })}
        />
      )}
    </FilterButton>
  )
}
