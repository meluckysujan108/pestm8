import { useRef, useState } from 'react'
import { Check, ListFilter } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import {
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import {
  STATUS_OPTIONS,
  computeStaffLoad,
  isOnJob,
} from '#/lib/scheduleFilters'
import type { ScheduleFilters, StaffLoad } from '#/lib/scheduleFilters'
import type { JobRow } from './JobCard'

/**
 * The day's filters behind one icon, at the end of the View switch's row.
 *
 * They were two chips beside the switch, and a chip is as wide as the word
 * chosen in it: picking a status moved the next chip along, "Clear filters"
 * came and went beside them, and on a phone the three took a row of their
 * own that the Week and Recurring views didn't have, so the cards jumped
 * with every change of view. The icon is one size whatever is chosen. It is
 * blue while anything is filtered, with how many filters are on, as every
 * active filter is blue.
 *
 * The sheet applies each choice as it is made, so the day behind it is
 * already the answer when Done closes it.
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
  members: Array<{ _id: string; name: string; colour: string }>
  filters: ScheduleFilters<JobRow>
  /** "Just my jobs": every job on screen is the viewer's, so choosing whose
   * is no choice at all. Status still filters, and Clear still clears it. */
  hideStaff?: boolean
  /** Until the page hydrates, so a tap is never swallowed by inert markup. */
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const { status, staffId } = filters
  const staffOptions = staffOptionsOf(jobs, members, staffId)
  // A subcontractor without canViewAllJobs only ever sees their own jobs, and
  // a single-tech day is the same case: one real choice is no choice, so the
  // section is left out rather than shown with nothing to pick.
  const showStaff = !hideStaff && staffOptions.length >= 2
  const on = Number(status !== 'all') + Number(showStaff && staffId !== 'all')

  // Each status's count among the jobs the person chosen is on, so a count
  // says what picking it would show. Booked work only: a projected visit is
  // in no count (it is never one of these statuses).
  const forStaff = jobs.filter(
    (job) => staffId === 'all' || isOnJob(job, staffId),
  )
  const countOf = (value: string) =>
    forStaff.filter((job) => job.status === value).length
  const booked = forStaff.filter((job) => job.status !== 'recurring').length

  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-label={on > 0 ? `Filters, ${on} on` : 'Filters'}
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
        title="Filters"
        returnFocusRef={opener}
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              disabled={on === 0}
              onClick={filters.clear}
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
        <section aria-labelledby="schedule-filter-status">
          <h3 id="schedule-filter-status" className="section-label mb-2">
            Status
          </h3>
          <div
            role="group"
            aria-labelledby="schedule-filter-status"
            className="flex flex-wrap gap-2"
          >
            {[
              { value: 'all', label: 'All', count: booked },
              ...STATUS_OPTIONS.map((option) => ({
                ...option,
                count: countOf(option.value),
              })),
            ]
              // A status nobody's job has today is no choice, unless it is
              // the one chosen.
              .filter((option) => option.count > 0 || option.value === status)
              .map((option) => {
                const chosen = option.value === status
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={chosen}
                    onClick={() =>
                      filters.setStatus(option.value as typeof status)
                    }
                    // Drawn 36px, tapped at 44 (`tap-target`), as the app's
                    // other filter chips.
                    className={`relative tap-target inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-caption font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.97] ${
                      chosen
                        ? 'border-blue/30 bg-blue/12 text-blue'
                        : 'border-hairline bg-surface text-ink-2'
                    }`}
                  >
                    {option.label}
                    <span
                      className={`tabular-nums ${chosen ? '' : 'text-muted'}`}
                    >
                      {option.count}
                    </span>
                  </button>
                )
              })}
          </div>
        </section>

        {showStaff && (
          <section aria-labelledby="schedule-filter-staff" className="mt-5">
            <h3 id="schedule-filter-staff" className="section-label mb-1">
              Technician
            </h3>
            <ul className="flex flex-col">
              {[
                {
                  membershipId: 'all',
                  name: 'Everyone',
                  colour: undefined,
                  count: jobs.filter((job) => job.status !== 'recurring')
                    .length,
                },
                ...staffOptions,
              ].map((person) => {
                const chosen = person.membershipId === staffId
                return (
                  <li key={person.membershipId}>
                    <button
                      type="button"
                      aria-pressed={chosen}
                      onClick={() => filters.setStaffId(person.membershipId)}
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
                      <span className="min-w-0 flex-1 truncate">
                        {person.name}
                      </span>
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
        )}
      </Sheet>
    </>
  )
}

/**
 * Whose jobs the day holds, with their counts. The default selection is the
 * viewer's own membership, which may have no job today even though someone
 * else does — so it is still offered (not a raw id where a name should be),
 * rather than only ever listing staff who already have a job.
 */
function staffOptionsOf(
  jobs: Array<JobRow>,
  members: Array<{ _id: string; name: string; colour: string }>,
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
