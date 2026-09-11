import { JobCard } from './JobCard'
import { JobTable } from './JobTable'
import { WeatherBanner } from './WeatherBanner'
import { ScheduleFilterBar } from './ScheduleFilterBar'
import { Segmented } from '#/components/primitives/Segmented'
import { EmptyState } from '#/components/primitives/EmptyState'
import { formatDayLabel } from '#/lib/format'
import { useScheduleFilters } from '#/lib/scheduleFilters'
import { useDayWeather, weatherKeyOf } from '#/lib/useDayWeather'
import { travelHintsFor } from '#/lib/travel'
import type { JobRow } from './JobCard'
import type { Id } from '../../../convex/_generated/dataModel'

type View = 'list' | 'board' | 'table'

const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'board', label: 'Board' },
  { value: 'table', label: 'Table' },
]

/**
 * Desktop-only (§2.4) right pane beside MonthCalendarCard. Status and staff
 * filter dropdowns (ScheduleFilterBar) narrow the same jobs the mobile list
 * uses — via the same useScheduleFilters hook, so both layouts filter
 * identically. A Cards/Table view switcher is desktop-only — a data table
 * doesn't fit a field technician's phone screen, so mobile always shows Cards.
 */
export function DayAgendaPanel({
  businessId,
  state,
  timezone,
  selectedKey,
  jobs,
  members,
  view,
  onViewChange,
  onOpenJob,
}: {
  businessId: Id<'businesses'>
  state: string
  timezone: string
  selectedKey: string
  jobs: Array<JobRow>
  members: Array<{ _id: string; name: string; colour: string }>
  // Owned by the route, not held locally: the choice lives in a search param
  // so it survives a refresh and is shareable (§5.1), and so the mobile and
  // desktop layouts cannot end up disagreeing about which view is active.
  view: View
  onViewChange: (view: View) => void
  onOpenJob: (jobId: string) => void
}) {
  const { status, setStatus, staffId, setStaffId, filteredJobs } = useScheduleFilters(jobs)

  const weather = useDayWeather(
    businessId,
    state,
    jobs
      .filter((j) => j.suburb)
      .map((j) => ({ dayKey: selectedKey, suburb: j.suburb, postcode: j.postcode ?? '' })),
  )
  const travel = travelHintsFor(
    filteredJobs,
    (job) => weather[weatherKeyOf(job.suburb, job.postcode ?? '', selectedKey)],
  )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sheet-title text-ink">
            {formatDayLabel(selectedKey)}
          </h2>
          <p className="text-caption tabular-nums text-muted">
            {filteredJobs.length} {filteredJobs.length === 1 ? 'job' : 'jobs'}
          </p>
        </div>
        <Segmented label="View" value={view} options={VIEW_OPTIONS} onChange={onViewChange} />
      </div>

      <ScheduleFilterBar
        jobs={jobs}
        members={members}
        status={status}
        setStatus={setStatus}
        staffId={staffId}
        setStaffId={setStaffId}
      />

      {jobs.length > 0 && jobs[0].suburb && (
        <WeatherBanner
          businessId={businessId}
          suburb={jobs[0].suburb}
          postcode={jobs[0].postcode ?? ''}
          state={state}
          dayKey={selectedKey}
        />
      )}

      {filteredJobs.length === 0 ? (
        <EmptyState
          title={jobs.length === 0 ? 'Nothing booked' : 'No matching jobs'}
          body={
            jobs.length === 0
              ? 'This day is clear.'
              : 'No jobs match this filter.'
          }
        />
      ) : view !== 'table' ? (
        <div
          className={
            view === 'board'
              ? 'grid grid-cols-1 items-stretch gap-3 xl:grid-cols-2'
              : 'flex flex-col gap-2.5'
          }
        >
          {filteredJobs.map((job) => (
            <JobCard
              key={job._id}
              job={job}
              variant={view}
              travel={travel[job._id]}
              weather={weather[weatherKeyOf(job.suburb, job.postcode ?? '', selectedKey)]}
              timezone={timezone}
              onOpen={onOpenJob}
            />
          ))}
        </div>
      ) : (
        <JobTable
          jobs={filteredJobs}
          weather={weather}
          selectedKey={selectedKey}
          timezone={timezone}
          onOpenJob={onOpenJob}
        />
      )}
    </div>
  )
}
