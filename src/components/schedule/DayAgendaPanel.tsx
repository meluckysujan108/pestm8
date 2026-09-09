import { useState } from 'react'
import { JobCard } from './JobCard'
import { WeatherBanner } from './WeatherBanner'
import { Segmented } from '#/components/primitives/Segmented'
import { EmptyState } from '#/components/primitives/EmptyState'
import { formatDayLabel } from '#/lib/format'
import type { JobRow } from './JobCard'
import type { Id } from '../../../convex/_generated/dataModel'

type StatusFilter = 'all' | 'booked' | 'inProgress' | 'completed' | 'invoiced'

const FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'booked', label: 'Booked' },
  { value: 'inProgress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'invoiced', label: 'Invoiced' },
]

/**
 * Desktop-only (§2.4) right pane beside MonthCalendarCard. A segmented
 * control filters by status — never a dropdown, for binary/ternary filters
 * (§2.3) — and the same JobCard rows the mobile list already uses.
 */
export function DayAgendaPanel({
  businessId,
  state,
  timezone,
  selectedKey,
  jobs,
  onOpenJob,
}: {
  businessId: Id<'businesses'>
  state: string
  timezone: string
  selectedKey: string
  jobs: Array<JobRow>
  onOpenJob: (jobId: string) => void
}) {
  const [filter, setFilter] = useState<StatusFilter>('all')
  const filtered =
    filter === 'all' ? jobs : jobs.filter((job) => job.status === filter)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sheet-title text-ink">
            {formatDayLabel(selectedKey)}
          </h2>
          <p className="text-caption tabular-nums text-muted">
            {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
          </p>
        </div>
        <Segmented
          label="Filter by status"
          value={filter}
          options={FILTER_OPTIONS}
          onChange={setFilter}
        />
      </div>

      {jobs.length > 0 && jobs[0].suburb && (
        <WeatherBanner
          businessId={businessId}
          suburb={jobs[0].suburb}
          postcode={jobs[0].postcode ?? ''}
          state={state}
          dayKey={selectedKey}
        />
      )}

      {filtered.length === 0 ? (
        <EmptyState
          title={jobs.length === 0 ? 'Nothing booked' : 'No matching jobs'}
          body={
            jobs.length === 0
              ? 'This day is clear.'
              : 'No jobs match this filter.'
          }
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {filtered.map((job) => (
            <JobCard
              key={job._id}
              job={job}
              timezone={timezone}
              onOpen={onOpenJob}
            />
          ))}
        </div>
      )}
    </div>
  )
}
