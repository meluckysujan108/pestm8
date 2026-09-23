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
import { isOverdueProjection } from '#/lib/jobCardActions'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import { RecurringDueNote } from './RecurringDueNote'
import { SCHEDULE_VIEW_OPTIONS } from '#/lib/scheduleViews'
import type { ScheduleView } from '#/lib/scheduleViews'
import type { JobRow } from './JobCard'
import type { Id } from '../../../convex/_generated/dataModel'

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
  businessSlug,
  recurringDue = 0,
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
  businessSlug: string
  /** Projected visits on this day when it is still ahead (`listWeek`). */
  recurringDue?: number
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

  // Three numbers, never one: booked work, projected visits due today, and
  // projected visits whose day has passed. A projection is work nobody has
  // committed to, so it is in no job total anywhere (the month grid, the
  // team legend, the dashboard); and "overdue" means what the card's marker
  // and the nav badge mean by it, so a visit due later today is not one.
  const now = Date.now()
  const booked = filteredJobs.filter((j) => j.status !== 'recurring')
  const overdue = filteredJobs.filter((j) =>
    isOverdueProjection(j, timezone, now),
  )
  const due = filteredJobs.filter(
    (j) => j.status === 'recurring' && !isOverdueProjection(j, timezone, now),
  )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sheet-title text-ink">
            {formatDayLabel(selectedKey)}
          </h2>
          <p className="flex flex-wrap items-center gap-x-1.5 text-caption tabular-nums text-ink-2">
            <span>
              {booked.length} {booked.length === 1 ? 'job' : 'jobs'}
            </span>
            {due.length > 0 && <span>· {due.length} due</span>}
            {overdue.length > 0 && (
              <span
                className={`rounded-full px-2 text-[12px] font-semibold leading-5 ${OVERDUE_CHIP}`}
              >
                {overdue.length} overdue
              </span>
            )}
          </p>
        </div>
        <Segmented
          label="View"
          value={view}
          options={SCHEDULE_VIEW_OPTIONS}
          onChange={onViewChange}
        />
      </div>

      <RecurringDueNote count={recurringDue} businessSlug={businessSlug} />

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
              hideTechnician
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
