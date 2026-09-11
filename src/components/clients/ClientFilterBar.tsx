import { FilterDropdown } from '#/components/primitives/FilterDropdown'
import { KIND_OPTIONS, computeSuburbLoad } from '#/lib/clientFilters'
import type { ClientKind, KindFilter } from '#/lib/clientFilters'

/**
 * Kind + suburb filter chips for the client list — the client-context
 * analogue of `ScheduleFilterBar`'s status/staff chips. Status and staff
 * don't apply to a client (there is no "in progress" client), so this filters
 * on what actually varies across a client list: is it a business or a
 * person, and which suburb is their work in.
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterDropdown
        label="Filter by type"
        value={kind}
        onChange={(value) => setKind(value as ClientKind | 'all')}
        active={kind !== 'all'}
        options={[{ value: 'all', label: 'All types' }, ...KIND_OPTIONS]}
      />
      {showSuburbFilter && (
        <FilterDropdown
          label="Filter by suburb"
          value={suburb}
          onChange={setSuburb}
          active={suburb !== 'all'}
          options={[
            { value: 'all', label: 'All suburbs' },
            ...suburbLoad.map((s) => ({ value: s.suburb, label: s.suburb, count: s.count })),
          ]}
        />
      )}
      {(kind !== 'all' || suburb !== 'all') && (
        <button
          type="button"
          onClick={() => {
            setKind('all')
            setSuburb('all')
          }}
          className="text-caption font-semibold text-blue"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}
