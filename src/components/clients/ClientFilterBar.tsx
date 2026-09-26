import { FilterDropdown } from '#/components/primitives/FilterDropdown'
import { Segmented } from '#/components/primitives/Segmented'
import { tagsInUse } from '#/components/clients/ClientRecordBits'
import {
  KIND_OPTIONS,
  STATUS_FILTER_OPTIONS,
  computeSuburbLoad,
} from '#/lib/clientFilters'
import type { KindFilter, StatusFilter } from '#/lib/clientFilters'

/**
 * Kind, status, tag and suburb filters for the client list — the
 * client-context analogue of `ScheduleFilterBar`'s status/staff chips. Kind
 * is a segmented control (three answers); the rest are dropdowns. Status
 * shows once any client is a lead or inactive, and tags once any client has
 * one: a business that uses neither sees neither.
 */
export function ClientFilterBar({
  rows,
  kind,
  setKind,
  suburb,
  setSuburb,
  status,
  setStatus,
  tag,
  setTag,
  filtered,
  onClear,
}: {
  rows: Array<{
    client: { status?: string; tags?: Array<string> }
    properties: Array<{ suburb: string }>
  }>
  kind: KindFilter
  setKind: (value: KindFilter) => void
  suburb: string
  setSuburb: (value: string) => void
  status: StatusFilter
  setStatus: (value: StatusFilter) => void
  tag: string
  setTag: (value: string) => void
  filtered: boolean
  onClear: () => void
}) {
  const suburbLoad = computeSuburbLoad(rows)
  // A single-suburb business filtering by suburb has nothing to narrow —
  // same "hide a dropdown with fewer than 2 real choices" rule
  // `ScheduleFilterBar` applies to the staff filter.
  const showSuburbFilter = suburbLoad.length >= 2
  const tagLoad = tagsInUse(rows.map((r) => r.client))
  const showTagFilter = tagLoad.length > 0 || tag !== 'all'
  const showStatusFilter =
    status !== 'all' ||
    rows.some(
      (r) => r.client.status !== undefined && r.client.status !== 'active',
    )
  const statusCounts = new Map<string, number>()
  for (const row of rows) {
    const s = row.client.status ?? 'active'
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1)
  }

  const showRow =
    showSuburbFilter || showTagFilter || showStatusFilter || filtered

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
      {showRow && (
        <div className="flex flex-wrap items-center gap-2">
          {showStatusFilter && (
            <FilterDropdown
              label="Filter by status"
              value={status}
              onChange={(value) => setStatus(value as StatusFilter)}
              active={status !== 'all'}
              options={STATUS_FILTER_OPTIONS.map((o) => ({
                ...o,
                ...(o.value !== 'all' && {
                  count: statusCounts.get(o.value) ?? 0,
                }),
              }))}
            />
          )}
          {showTagFilter && (
            <FilterDropdown
              label="Filter by tag"
              value={tag}
              onChange={setTag}
              active={tag !== 'all'}
              options={[
                { value: 'all', label: 'Any tag' },
                ...tagLoad.map((t) => ({
                  value: t.tag,
                  label: t.tag,
                  count: t.count,
                })),
              ]}
            />
          )}
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
              onClick={onClear}
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
