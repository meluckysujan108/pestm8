import { useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ListFilter } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { Segmented } from '#/components/primitives/Segmented'
import {
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { rq } from '#/lib/routeQueries'
import { useBusinessDay } from '#/lib/useBusinessDay'
import {
  DAY_SORT_OPTIONS,
  RECURRING_SORT_OPTIONS,
  STATUS_OPTIONS,
  computeStaffLoad,
  filterDayJobs,
  hasService,
  isOnJob,
  servicesOf,
} from '#/lib/scheduleFilters'
import { useWeekDays } from './WeekView'
import type { ReactNode } from 'react'
import type {
  RecurringSort,
  ScheduleFilters,
  StaffLoad,
} from '#/lib/scheduleFilters'
import type { JobRow } from './JobCard'
import type { Id } from '../../../convex/_generated/dataModel'

type Member = { _id: string; name: string; colour: string }

/**
 * The day's filters and sort behind one icon, at the end of the View
 * switch's row: Sort, Status, Service and Technician.
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
    <FiltersButton
      title="Filter and sort"
      on={on}
      disabled={disabled}
      onClear={filters.clear}
    >
      <SortSection
        value={sort}
        // By technician only where there is more than one.
        options={DAY_SORT_OPTIONS.filter(
          (option) => showStaff || option.value !== 'technician',
        )}
        onChange={filters.setSort}
      />
      <ChipsSection
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
        <ChipsSection
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
        <TechnicianSection
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
    </FiltersButton>
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
    <FiltersButton
      title="Filters"
      on={Number(filters.staffId !== 'all')}
      disabled={disabled}
      onClear={filters.clear}
    >
      <TechnicianSection
        value={filters.staffId}
        everyone={rows.filter((job) => job.status !== 'recurring').length}
        people={people}
        onChange={filters.setStaffId}
      />
    </FiltersButton>
  )
}

/**
 * The Recurring view's: how its services are sorted (By service only — By
 * date is in date order), and whose they are. Each person's count is of the
 * services they lead.
 */
export function RecurringFilterButton({
  business,
  members,
  filters,
  sort,
  onSortChange,
  byDate,
  hideStaff = false,
  disabled = false,
}: {
  business: { _id: Id<'businesses'>; timezone: string }
  members: Array<Member>
  filters: ScheduleFilters<JobRow>
  sort: RecurringSort
  onSortChange: (sort: RecurringSort) => void
  byDate: boolean
  hideStaff?: boolean
  disabled?: boolean
}) {
  const day = useBusinessDay(business.timezone)
  // Over the window the view beside it reads, fixed where it opened.
  const [readFrom] = useState(() => day.startOfToday)
  const { data } = useQuery(rq.recurringServices(business._id, readFrom))
  const services = data?.services ?? []
  const people = peopleOfServices(services, members, filters.staffId)
  const showStaff = !hideStaff && people.length >= 2
  if (!showStaff && byDate) return null
  return (
    <FiltersButton
      title={byDate ? 'Filters' : 'Filter and sort'}
      on={Number(showStaff && filters.staffId !== 'all')}
      disabled={disabled}
      onClear={filters.clear}
    >
      {!byDate && (
        <SortSection
          value={sort}
          options={RECURRING_SORT_OPTIONS}
          onChange={onSortChange}
        />
      )}
      {showStaff && (
        <TechnicianSection
          value={filters.staffId}
          everyone={services.length}
          people={people}
          onChange={filters.setStaffId}
        />
      )}
    </FiltersButton>
  )
}

/**
 * The icon and its sheet. Blue while anything is filtered, with how many
 * filters are on, as every active filter is blue; a sort is no filter, so it
 * is not counted. The sheet applies each choice as it is made, so what is
 * behind it is already the answer when Done closes it.
 */
function FiltersButton({
  title,
  on,
  disabled,
  onClear,
  children,
}: {
  /** "Filter and sort", or "Filters" where there is no sort. */
  title: string
  on: number
  disabled: boolean
  onClear: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-label={on > 0 ? `${title}, ${on} on` : title}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={`relative tap-target flex size-9 shrink-0 items-center justify-center rounded-full border outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.95] disabled:opacity-60 ${
          on > 0
            ? 'border-blue/30 bg-blue/12 text-blue'
            : 'border-hairline bg-surface text-ink-2'
        }`}
      >
        <ListFilter size={18} strokeWidth={1.7} aria-hidden />
        {on > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 min-w-4 rounded-full bg-blue px-1 text-center text-[11px] leading-4 font-bold text-on-tint tabular-nums"
          >
            {on}
          </span>
        )}
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        returnFocusRef={opener}
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              disabled={on === 0}
              onClick={onClear}
              className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
            >
              Clear filters
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={`${NEUTRAL_BUTTON_COMPACT} flex-1`}
            >
              Done
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-5">{children}</div>
      </Sheet>
    </>
  )
}

/** Two to four orders, all visible: a `Segmented` (§5, Filters and views). */
function SortSection<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  const id = useId()
  // A sort the address asks for that this day doesn't offer (by technician,
  // with one person) reads as the first, which is what it amounts to.
  const shown = options.some((option) => option.value === value)
    ? value
    : options[0].value
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="section-label mb-2">
        Sort by
      </h3>
      <Segmented
        kind="choice"
        labelledBy={id}
        value={shown}
        options={options}
        onChange={onChange}
      />
    </section>
  )
}

/**
 * A filter's choices as chips with counts: a `role="group"` of `aria-pressed`
 * buttons. A choice nobody's job has is no choice, unless it is the one
 * chosen.
 */
function ChipsSection<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string; count: number }>
  onChange: (value: T) => void
}) {
  const id = useId()
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="section-label mb-2">
        {label}
      </h3>
      <div role="group" aria-labelledby={id} className="flex flex-wrap gap-2">
        {options
          .filter((option) => option.count > 0 || option.value === value)
          .map((option) => {
            const chosen = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={chosen}
                onClick={() => onChange(option.value)}
                // Drawn 36px, tapped at 44 (`tap-target`), as the app's
                // other filter chips.
                className={`relative tap-target inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border px-3 text-caption font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.97] ${
                  chosen
                    ? 'border-blue/30 bg-blue/12 text-blue'
                    : 'border-hairline bg-surface text-ink-2'
                }`}
              >
                <span className="truncate">{option.label}</span>
                <span className={`tabular-nums ${chosen ? '' : 'text-muted'}`}>
                  {option.count}
                </span>
              </button>
            )
          })}
      </div>
    </section>
  )
}

/** Whose: Everyone, then each person with their colour and count. */
function TechnicianSection({
  value,
  everyone,
  people,
  onChange,
}: {
  value: string
  everyone: number
  people: Array<StaffLoad>
  onChange: (membershipId: string) => void
}) {
  const id = useId()
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="section-label mb-1">
        Technician
      </h3>
      <ul className="flex flex-col">
        {[
          {
            membershipId: 'all',
            name: 'Everyone',
            colour: undefined,
            count: everyone,
          },
          ...people,
        ].map((person) => {
          const chosen = person.membershipId === value
          return (
            <li key={person.membershipId}>
              <button
                type="button"
                aria-pressed={chosen}
                onClick={() => onChange(person.membershipId)}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-1 text-left text-body text-ink outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:bg-surface-2"
              >
                <span
                  aria-hidden
                  className={`size-2.5 shrink-0 rounded-full ${person.colour ? '' : 'border border-hairline'}`}
                  style={
                    person.colour
                      ? { backgroundColor: person.colour }
                      : undefined
                  }
                />
                <span className="min-w-0 flex-1 truncate">{person.name}</span>
                <span className="shrink-0 text-caption text-muted tabular-nums">
                  {person.count}
                </span>
                <Check
                  size={16}
                  strokeWidth={2.2}
                  aria-hidden
                  className={`shrink-0 text-blue ${chosen ? '' : 'invisible'}`}
                />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
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

/**
 * Who leads the services, with how many each, most first; and the person
 * chosen, at 0 if they lead none. Named from the roster: someone no longer
 * on it is left out of the list, their services still under Everyone.
 */
function peopleOfServices(
  services: ReadonlyArray<{ assignedMembershipId: string }>,
  members: Array<Member>,
  staffId: string,
): Array<StaffLoad> {
  const counts = new Map<string, number>()
  for (const service of services) {
    const id = service.assignedMembershipId
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  if (staffId !== 'all' && !counts.has(staffId)) counts.set(staffId, 0)
  return [...counts]
    .flatMap(([membershipId, count]) => {
      const member = members.find((m) => m._id === membershipId)
      return member
        ? [{ membershipId, name: member.name, colour: member.colour, count }]
        : []
    })
    .sort((a, b) => b.count - a.count)
}
