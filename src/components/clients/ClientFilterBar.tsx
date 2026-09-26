import { FilterDropdown } from '#/components/primitives/FilterDropdown'
import { Segmented } from '#/components/primitives/Segmented'
import { KIND_OPTIONS, computeSuburbLoad } from '#/lib/clientFilters'
import type { KindFilter } from '#/lib/clientFilters'

/**
 * Kind + suburb filters for the client list — the client-context analogue
 * of `ScheduleFilterBar`'s status/staff chips. Status and staff don't apply
 * to a client (there is no "in progress" client), so this filters on what
 * actually varies across a client list: is it a business or a person, and
 * which suburb is their work in. Kind is a segmented control (three
 * answers); suburb stays a dropdown, since it can have dozens.
 */
export function ClientFilterBar({
  rows,
  kind,
  setKind,
  suburb,
  setSuburb,
}: {
  rows: Array<{ properties: Array<{ suburb: string }> }>
  kind: KindFilter
  setKind: (value: KindFilter) => void
  suburb: string
  setSuburb: (value: string) => void
}) {
  const suburbLoad = computeSuburbLoad(rows)
  // A single-suburb business filtering by suburb has nothing to narrow —
  // same "hide a dropdown with fewer than 2 real choices" rule
  // `ScheduleFilterBar` applies to the staff filter.
  const showSuburbFilter = suburbLoad.length >= 2

  const filtered = kind !== 'all' || suburb !== 'all'

  return (
    <div className="flex flex-col gap-2">
      {/* Three answers, so a segmented control rather than a dropdown
          (§2.3): every choice is on screen and one tap away. */}
      <Segmented
        label="Filter by type"
        value={kind}
        onChange={setKind}
        options={[{ value: 'all', label: 'All' }, ...KIND_OPTIONS]}
      />
      {(showSuburbFilter || filtered) && (
        <div className="flex flex-wrap items-center gap-2">
          {showSuburbFilter && (
            <FilterDropdown
              label="Filter by suburb"
              value={suburb}
              onChange={setSuburb}
              active={suburb !== 'all'}
              options={[
                { value: 'all', label: 'All suburbs' },
                ...suburbLoad.map((s) => ({
                  value: s.suburb,
                  label: s.suburb,
                  count: s.count,
                })),
              ]}
            />
          )}
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setKind('all')
                setSuburb('all')
              }}
              className="relative tap-target text-caption font-semibold text-blue"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  )
}
