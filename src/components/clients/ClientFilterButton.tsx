import {
  FilterButton,
  FilterChips,
  FilterSort,
} from '#/components/primitives/FilterSheet'
import { KIND_OPTIONS, clientFilterCounts } from '#/lib/clientFilters'
import type { PointerEventHandler } from 'react'
import type {
  ClientFilterValues,
  ClientKind,
  KindFilter,
  StatusFilter,
} from '#/lib/clientFilters'
import type { ClientFacets } from '../../../convex/lib/clientFacets'

export type ClientSort = 'newest' | 'az'

const SORT_OPTIONS: Array<{ value: ClientSort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'az', label: 'A–Z' },
]

const STATUS_OPTIONS: Array<{
  value: Exclude<StatusFilter, 'all'>
  label: string
}> = [
  { value: 'active', label: 'Active' },
  { value: 'lead', label: 'Lead' },
  { value: 'inactive', label: 'Inactive' },
]

/** Past this many tags or suburbs, the rest wait behind "Show all". */
const LONG_LIST = 12

/**
 * The client list's sort and its four filters — type, status, tag and suburb
 * — behind one icon beside the search box (`FilterButton`), as the
 * Schedule's are. They were three rows over the cards: the sort, the type,
 * and dropdowns that came with the data, with "Clear filters" coming and
 * going beside them, so the cards moved with every choice.
 *
 * A section shows once it has something to choose between: status once any
 * client is a lead or inactive, tags once any client has one, suburbs with
 * two or more. One already chosen stays, so it can be seen and changed
 * whatever a search leaves.
 *
 * Each count is among the clients the other filters let through
 * (`clientFilterCounts`), worked out over every client the search finds —
 * which the page reads while the sheet is open. Until they are here, the
 * whole book's counts from the server (`clients.overview`), and only while
 * nothing is filtered: with a filter on, those would be the wrong counts, so
 * none are shown until the right ones come.
 */
export function ClientFilterButton({
  facets,
  total,
  rows,
  values,
  setKind,
  setStatus,
  setTag,
  setSuburb,
  filtersOn,
  onClear,
  sort,
  onSortChange,
  onIntent,
  onOpenChange,
  disabled = false,
}: {
  /** The whole book's choices and counts, from the server. */
  facets: ClientFacets
  /** How many clients the whole book holds, when the server has said. */
  total?: number
  /** Every client the search finds, once the page has them all. */
  rows?: Parameters<typeof clientFilterCounts>[0]
  values: ClientFilterValues
  setKind: (value: KindFilter) => void
  setStatus: (value: StatusFilter) => void
  setTag: (value: string) => void
  setSuburb: (value: string) => void
  filtersOn: number
  onClear: () => void
  sort: ClientSort
  onSortChange: (sort: ClientSort) => void
  /** A press on the icon: the sheet will want every client to count. */
  onIntent?: PointerEventHandler<HTMLButtonElement>
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
}) {
  const { kind, status, tag, suburb } = values
  const counted = rows ? clientFilterCounts(rows, values) : undefined
  // The server's counts are the whole book's: right only with nothing set.
  const plain = filtersOn === 0 ? facets : undefined
  const all = counted ? undefined : plain ? total : undefined

  const tags = counted?.tags.each ?? facets.tags
  const suburbs = counted?.suburbs.each ?? facets.suburbs
  const statuses = counted?.statuses ?? plain?.statuses

  const kindCount = (value: ClientKind) => counted?.kinds[value]
  // One type in the whole list is no choice: Commercial at 0 is hidden, and
  // All would be the only chip.
  const showKind =
    kind !== 'all' ||
    counted === undefined ||
    (counted.kinds.person > 0 && counted.kinds.business > 0)
  const showStatus =
    status !== 'all' ||
    (statuses !== undefined && (statuses.lead > 0 || statuses.inactive > 0)) ||
    (statuses === undefined &&
      (facets.statuses.lead > 0 || facets.statuses.inactive > 0))
  const showTag = tags.length > 0 || tag !== 'all'
  const showSuburb = suburbs.length >= 2 || suburb !== 'all'

  return (
    <FilterButton
      title="Filter and sort"
      on={filtersOn}
      disabled={disabled}
      onClear={onClear}
      onPointerDown={onIntent}
      onOpenChange={onOpenChange}
    >
      <FilterSort value={sort} options={SORT_OPTIONS} onChange={onSortChange} />
      {showKind && (
        <FilterChips
          label="Type"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'All', count: counted?.kinds.all ?? all },
            ...KIND_OPTIONS.map((option) => ({
              ...option,
              count: kindCount(option.value),
            })),
          ]}
        />
      )}
      {showStatus && (
        <FilterChips
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            {
              value: 'all',
              label: 'All',
              count: counted?.statuses.all ?? all,
            },
            ...STATUS_OPTIONS.map((option) => ({
              ...option,
              count: statuses?.[option.value],
            })),
          ]}
        />
      )}
      {showTag && (
        <FilterChips
          label="Tag"
          value={chosenOf(
            tag,
            tags.map((t) => t.tag),
          )}
          onChange={setTag}
          collapseAfter={LONG_LIST}
          options={[
            { value: 'all', label: 'All', count: counted?.tags.all ?? all },
            ...tags.map((t) => ({
              value: t.tag,
              label: t.tag,
              count: counted || plain ? t.count : undefined,
            })),
            ...missing(
              tag,
              tags.map((t) => t.tag),
            ),
          ]}
        />
      )}
      {showSuburb && (
        <FilterChips
          label="Suburb"
          value={suburb}
          onChange={setSuburb}
          collapseAfter={LONG_LIST}
          options={[
            {
              value: 'all',
              label: 'All',
              count: counted?.suburbs.all ?? all,
            },
            ...suburbs.map((s) => ({
              value: s.suburb,
              label: s.suburb,
              count: counted || plain ? s.count : undefined,
            })),
            ...missing(
              suburb,
              suburbs.map((s) => s.suburb),
            ),
          ]}
        />
      )}
    </FilterButton>
  )
}

/** A tag is matched whatever its case: the chip spelt as the list has it. */
function chosenOf(value: string, offered: ReadonlyArray<string>): string {
  if (value === 'all') return value
  return offered.find((o) => o.toLowerCase() === value.toLowerCase()) ?? value
}

/** The one chosen, at 0, when nothing the search found has it: still shown,
 * so it can be seen and cleared. */
function missing(
  value: string,
  offered: ReadonlyArray<string>,
): Array<{ value: string; label: string; count: number }> {
  if (value === 'all') return []
  return offered.some((o) => o.toLowerCase() === value.toLowerCase())
    ? []
    : [{ value, label: value, count: 0 }]
}
