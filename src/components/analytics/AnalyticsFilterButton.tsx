import {
  FilterButton,
  FilterChips,
  FilterPeople,
} from '#/components/primitives/FilterSheet'

export type AnalyticsService = { name: string; count: number }

export type AnalyticsPerson = {
  membershipId: string
  name: string
  colour: string
  count: number
}

/**
 * Analytics narrowed to one service or one person, behind the same icon as
 * every list's filters (`FilterButton`). Each choice's number is the jobs in
 * the range it would show, among those the other filter lets through, as on
 * the Schedule. A section with nothing to choose between is left out.
 */
export function AnalyticsFilterButton({
  service,
  staffId,
  services,
  people,
  disabled = false,
  onChange,
}: {
  /** The service chosen, as the address says it, or none. */
  service: string | undefined
  /** A membership id, or 'all'. */
  staffId: string
  services: ReadonlyArray<AnalyticsService>
  /** Empty for anyone whose figures are their own jobs already. */
  people: ReadonlyArray<AnalyticsPerson>
  disabled?: boolean
  onChange: (next: { service?: string; staff?: string }) => void
}) {
  const showPeople = people.length > 1 || staffId !== 'all'
  // The address may name a service in another case than the jobs do.
  const chosen = services.find(
    (offered) => offered.name.toLowerCase() === service?.trim().toLowerCase(),
  )
  const serviceValue = service === undefined ? 'all' : (chosen?.name ?? service)
  const offered =
    chosen || service === undefined
      ? services
      : [...services, { name: service, count: 0 }]
  const on = Number(service !== undefined) + Number(staffId !== 'all')

  return (
    <FilterButton
      title="Filters"
      on={on}
      disabled={disabled}
      onClear={() => onChange({ service: undefined, staff: undefined })}
    >
      {(offered.length > 1 || service !== undefined) && (
        <FilterChips
          label="Service"
          value={serviceValue}
          options={[
            { value: 'all', label: 'All' },
            ...offered.map((s) => ({
              value: s.name,
              label: s.name,
              count: s.count,
            })),
          ]}
          onChange={(next) =>
            onChange({ service: next === 'all' ? undefined : next })
          }
          collapseAfter={8}
        />
      )}
      {showPeople && (
        <FilterPeople
          value={staffId}
          people={people}
          onChange={(next) =>
            onChange({ staff: next === 'all' ? undefined : next })
          }
        />
      )}
      {offered.length <= 1 && service === undefined && !showPeople && (
        <p className="text-body text-muted">
          Nothing to narrow by in these dates.
        </p>
      )}
    </FilterButton>
  )
}
