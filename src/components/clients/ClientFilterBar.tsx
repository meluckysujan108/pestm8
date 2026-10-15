import { FilterDropdown } from '#/components/primitives/FilterDropdown'
import { Segmented } from '#/components/primitives/Segmented'
import { useHydrated } from '#/lib/useHydrated'
import { KIND_OPTIONS, STATUS_FILTER_OPTIONS } from '#/lib/clientFilters'
import type { PointerEvent } from 'react'
import type { KindFilter, StatusFilter } from '#/lib/clientFilters'
import type { ClientFacets } from '../../../convex/lib/clientFacets'

/**
 * Whether a press on a segmented control is on a segment that is not chosen
 * yet — so the choice is about to change, and whatever it will need is worth
 * asking for now, while the finger is still down.
 */
export function choosingAnotherSegment(event: PointerEvent): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  const segment = target.closest('[role="tab"], [role="radio"]')
  return (
    segment !== null &&
    (segment.getAttribute('aria-selected') ??
      segment.getAttribute('aria-checked')) === 'false'
  )
}

/**
 * Kind, status, tag and suburb filters for the client list — the
 * client-context analogue of `ScheduleFilterBar`'s status/staff chips. Kind
 * is a segmented control (three answers); the rest are dropdowns. Status
 * shows once any client is a lead or inactive, and tags once any client has
 * one: a business that uses neither sees neither.
 *
 * Its choices and counts come as `facets` (convex/lib/clientFacets.ts), not
 * as rows: the page's first screen holds only its newest clients, so there
 * the server counts the whole book (`clients.overview`); once a search or a
 * filter has the page reading every client, the page counts what the search
 * found, as it always did.
 */
export function ClientFilterBar({
  facets,
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
  onIntent,
}: {
  facets: ClientFacets
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
  /** A filter is about to be chosen: a press on a type not chosen yet, or on
   * a dropdown. A filter has the page read every client, so the page starts
   * asking for them before the choice is made. */
  onIntent?: () => void
}) {
  // A tap on the type before the page has hydrated would be lost.
  const hydrated = useHydrated()
  const suburbLoad = facets.suburbs
  // A single-suburb business filtering by suburb has nothing to narrow —
  // same "hide a dropdown with fewer than 2 real choices" rule
  // `ScheduleFilterBar` applies to the staff filter. One already chosen
  // stays, so it can be seen and changed whatever a search leaves.
  const showSuburbFilter = suburbLoad.length >= 2 || suburb !== 'all'
  const tagLoad = facets.tags
  const showTagFilter = tagLoad.length > 0 || tag !== 'all'
  const showStatusFilter =
    status !== 'all' || facets.statuses.lead > 0 || facets.statuses.inactive > 0

  const showRow =
    showSuburbFilter || showTagFilter || showStatusFilter || filtered

  return (
    <div className="flex flex-col gap-2">
      {/* Three answers, so a segmented control rather than a dropdown
          (§2.3): every choice is on screen and one tap away. */}
      <div
        onPointerDown={(event) => {
          if (choosingAnotherSegment(event)) onIntent?.()
        }}
      >
        <Segmented
          label="Filter by type"
          value={kind}
          onChange={setKind}
          disabled={!hydrated}
          options={[{ value: 'all', label: 'All' }, ...KIND_OPTIONS]}
        />
      </div>
      {showRow && (
        <div
          className="flex flex-wrap items-center gap-2"
          onPointerDown={onIntent}
        >
          {showStatusFilter && (
            <FilterDropdown
              label="Filter by status"
              value={status}
              onChange={(value) => setStatus(value as StatusFilter)}
              active={status !== 'all'}
              options={STATUS_FILTER_OPTIONS.map((o) => ({
                ...o,
                ...(o.value !== 'all' && {
                  count: facets.statuses[o.value],
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
