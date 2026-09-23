import { JobCard } from './JobCard'
import { JobTable } from './JobTable'
import { WeatherBanner } from './WeatherBanner'
import { ScheduleFilterBar } from './ScheduleFilterBar'
import { Segmented } from '#/components/primitives/Segmented'
import { EmptyState } from '#/components/primitives/EmptyState'
import { formatDayLabel } from '#/lib/format'
import { useScheduleFilters } from '#/lib/scheduleFilters'
import { useActing, useViewMode } from '#/lib/access'
import { useWeather, weatherKeyOf } from '#/lib/weather'
import { jobsAhead, travelHintsFor } from '#/lib/travel'
import type { JobRow } from './JobCard'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * How a day is read. A list rather than a pair of branches: the section is
 * meant to hold more views than it has today. "Job" is the cards; the compact
 * list view is gone.
 */
export type ScheduleView = 'job' | 'table'

const VIEW_OPTIONS: Array<{ value: ScheduleView; label: string }> = [
  { value: 'job', label: 'Job' },
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
  todayKey,
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
  todayKey: string
  jobs: Array<JobRow>
  members: Array<{ _id: string; name: string; colour: string }>
  // Owned by the route, not held locally: the choice lives in a search param
  // so it survives a refresh and is shareable (§5.1), and so the mobile and
  // desktop layouts cannot end up disagreeing about which view is active.
  view: ScheduleView
  onViewChange: (view: ScheduleView) => void
  onOpenJob: (jobId: string) => void
}) {
  const mode = useViewMode()
  const acting = useActing()
  // Desktop opens on everyone, as it always has; a change of view starts the
  // filters over (see useScheduleFilters).
  const { status, setStatus, staffId, setStaffId, filteredJobs } = useScheduleFilters(
    jobs,
    'all',
    `${mode ?? ''}:${acting.membershipId}`,
  )

  const weather = useWeather(
    businessId,
    state,
    todayKey,
    jobs.map((j) => ({
      dayKey: selectedKey,
      suburb: j.suburb,
      postcode: j.postcode ?? '',
    })),
  )
  // Travel hints read lat/lng out of the RAW entries, not the rendered cell —
  // the coordinates are geography, unrelated to whether a forecast resolved.
  // Measured over the work still ahead only — see `jobsAhead`.
  const travel = travelHintsFor(jobsAhead(filteredJobs), (job) =>
    weather.byKey[weatherKeyOf(job.suburb, job.postcode ?? '', selectedKey)],
  )

  const overdue = filteredJobs.filter((j) => j.status === 'recurring')
  const booked = filteredJobs.filter((j) => j.status !== 'recurring')

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sheet-title text-ink">
            {formatDayLabel(selectedKey)}
          </h2>
          {/* Counted apart, because they are not the same thing. An overdue
              projection is shown here but is work nobody has committed to —
              it is in no job total anywhere else either (the month grid, the
              team legend, the dashboard), and folding it in would make this
              line the one place that disagrees. */}
          <p className="text-caption tabular-nums text-muted">
            {booked.length} {booked.length === 1 ? 'job' : 'jobs'}
            {overdue.length > 0 && (
              <span className="text-amber-ink">
                {' · '}
                {overdue.length} overdue
              </span>
            )}
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
        hideStaff={mode === 'mine'}
      />

      {jobs.length > 0 && jobs[0].suburb && (
        <WeatherBanner
          cell={weather.cell(
            jobs[0].suburb,
            jobs[0].postcode ?? '',
            selectedKey,
          )}
        />
      )}

      {filteredJobs.length === 0 ? (
        <EmptyState
          title={
            jobs.length === 0
              ? mode === 'mine'
                ? 'Nothing booked for you'
                : 'Nothing booked'
              : 'No matching jobs'
          }
          body={
            jobs.length === 0
              ? 'This day is clear.'
              : 'No jobs match this filter.'
          }
        />
      ) : view !== 'table' ? (
        <div className="grid grid-cols-1 items-stretch gap-3 xl:grid-cols-2">
          {filteredJobs.map((job) => (
            <JobCard
              key={job._id}
              job={job}
              travel={travel[job._id]}
              weather={weather.cell(job.suburb, job.postcode ?? '', selectedKey)}
              timezone={timezone}
              onOpen={onOpenJob}
              hideTechnician={mode === 'mine'}
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
