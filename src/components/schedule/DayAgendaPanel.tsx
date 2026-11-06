import { JobCard } from './JobCard'
import { WeatherBanner } from './WeatherBanner'
import { ScheduleFilterButton } from './ScheduleFilterButton'
import { DaySummary } from './DaySummary'
import { Segmented } from '#/components/primitives/Segmented'
import {
  EmptyState,
  EmptyStateButton,
  NoMatches,
} from '#/components/primitives/EmptyState'
import { formatDayLabel } from '#/lib/format'
import { useActing, useViewMode } from '#/lib/access'
import { useWeather, weatherKeyOf } from '#/lib/weather'
import { jobsAhead } from '#/lib/travel'
import { dayTravelHints } from '#/lib/scheduleFilters'
import { RecurringDueNote } from './RecurringDueNote'
import { WeatherCredit } from './WeatherCredit'
import { OutboxGroup } from './OutboxGroup'
import { useOutboxDay, useOutboxPlaces } from '#/lib/outbox/useOutbox'
import { SCHEDULE_VIEW_OPTIONS } from '#/lib/scheduleViews'
import type { ScheduleView } from '#/lib/scheduleViews'
import type { JobRow } from './JobCard'
import type { ScheduleFilters } from '#/lib/scheduleFilters'
import type { Id } from '../../../convex/_generated/dataModel'

/** The agenda's cards: one column, two from xl. */
const AGENDA_GRID = 'grid grid-cols-1 items-stretch gap-3 xl:grid-cols-2'

/**
 * Desktop-only (§2.4) right pane beside MonthCalendarCard. Its filters are
 * the route's (`useScheduleFilters`, in the address), behind the same icon
 * the phone has, so both layouts filter identically and a change of layout
 * keeps them. Its View switch is the same one the phone shows, flush right
 * where the week's and the Recurring view's are, with the icon before it;
 * the Table view was retired from both, since the card carries all its row
 * did.
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
  filters,
  onOpenJob,
  onOpenItem,
  onNewJob,
  businessSlug,
  recurringDue = 0,
  recurringKept = false,
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
  /** The route's, so the phone's and the desktop's are the same filters. */
  filters: ScheduleFilters<JobRow>
  onOpenJob: (jobId: string) => void
  /** Opens a booking on this phone, not sent yet (`?outboxId=`). */
  onOpenItem: (localId: string) => void
  /** New Job, offered on an empty day. */
  onNewJob?: () => void
  businessSlug: string
  /** Projected visits on this day when it is still ahead (`listWeek`). */
  recurringDue?: number
  /** The day has arrived, but its list is a copy the phone kept from before
   * it had: `recurringDue` are its visits, which the list doesn't have. */
  recurringKept?: boolean
}) {
  const mode = useViewMode()
  const acting = useActing()
  const { status, staffId, service, sort, filteredJobs } = filters

  // The day's bookings on this phone, not sent yet, as the phone's list has
  // them: a group under the cards, each keeping its slot until the day is
  // drawn afresh. Drawn on the panel's first draw: it mounts after an effect
  // and never hydrates. The header's counts stay the server's.
  const outboxDay = useOutboxDay({
    businessId,
    dayShown: selectedKey,
    timezone,
    rows: jobs,
    drawsCards: filteredJobs.length > 0,
    redrawKey: `${selectedKey}|${status}|${staffId}|${service}|${sort}|${mode ?? ''}|${acting.membershipId}`,
    allStatuses: status === 'all',
    staffId,
    service,
    mineOnly: mode === 'mine' ? acting.membershipId : null,
  })
  const outboxPlaces = useOutboxPlaces(businessId, selectedKey, timezone)
  const listedJobs = filteredJobs.filter(
    (job) => !outboxDay.hidden.has(job._id),
  )
  const weather = useWeather(
    businessId,
    state,
    todayKey,
    [...jobs, ...outboxPlaces].map((j) => ({
      dayKey: selectedKey,
      suburb: j.suburb,
      postcode: j.postcode ?? '',
      state: j.propertyState,
    })),
  )
  // Travel hints read lat/lng out of the RAW entries, not the rendered cell —
  // the coordinates are geography, unrelated to whether a forecast resolved.
  // Measured over the work still ahead only — see `jobsAhead` — along the
  // route the sort lays out, if it lays one out (`dayTravelHints`).
  const travel = dayTravelHints(
    jobsAhead(listedJobs),
    sort,
    (job) =>
      weather.byKey[weatherKeyOf(job.suburb, job.postcode ?? '', selectedKey)],
  )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        {/* Where the week's and the Recurring view's headings are, the
            same height (`data-view-heading`, which the Schedule's tests
            measure). */}
        <div data-view-heading className="min-w-0">
          <h2 className="truncate text-sheet-title text-ink">
            {formatDayLabel(selectedKey)}
          </h2>
          <DaySummary
            jobs={jobs}
            shown={filteredJobs}
            timezone={timezone}
            todayKey={todayKey}
          />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <ScheduleFilterButton
            jobs={jobs}
            members={members}
            filters={filters}
            hideStaff={mode === 'mine'}
          />
          <Segmented
            label="View"
            value={view}
            options={SCHEDULE_VIEW_OPTIONS}
            onChange={onViewChange}
          />
        </div>
      </div>

      <RecurringDueNote
        count={recurringDue}
        businessSlug={businessSlug}
        kept={recurringKept}
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

      {jobs.length === 0 && outboxDay.slots.length === 0 ? (
        <EmptyState
          title={mode === 'mine' ? 'Nothing booked for you' : 'Nothing booked'}
          body="This day is clear."
          action={
            onNewJob && (
              <EmptyStateButton onClick={onNewJob}>Book a job</EmptyStateButton>
            )
          }
        />
      ) : filteredJobs.length === 0 && outboxDay.slots.length === 0 ? (
        <NoMatches
          hint="No jobs on this day match these filters."
          clearLabel="Clear filters"
          onClear={filters.clear}
        />
      ) : (
        <div>
          {listedJobs.length > 0 && (
            <div className={AGENDA_GRID}>
              {listedJobs.map((job) => (
                <JobCard
                  key={job._id}
                  job={job}
                  travel={travel[job._id]}
                  weather={weather.cell(
                    job.suburb,
                    job.postcode ?? '',
                    selectedKey,
                  )}
                  timezone={timezone}
                  onOpen={onOpenJob}
                  hideTechnician
                  dayShown={selectedKey}
                />
              ))}
              {outboxDay.slots.length === 0 &&
                Object.keys(weather.byKey).length > 0 && (
                  <WeatherCredit className="xl:col-span-2" />
                )}
            </div>
          )}
          {/* After the grid, never in it (the phone's list has why). */}
          <OutboxGroup
            day={outboxDay}
            timezone={timezone}
            dayShown={selectedKey}
            onOpenItem={onOpenItem}
            onOpenJob={onOpenJob}
            weatherOf={(row) =>
              weather.cell(row.suburb, row.postcode ?? '', selectedKey)
            }
            grid={AGENDA_GRID}
            className={listedJobs.length > 0 ? 'mt-6' : ''}
          />
          {(outboxDay.slots.length > 0 || listedJobs.length === 0) &&
            Object.keys(weather.byKey).length > 0 && (
              <WeatherCredit className="mt-3" />
            )}
        </div>
      )}
    </div>
  )
}
