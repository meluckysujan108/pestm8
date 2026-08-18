import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { z } from 'zod'
import { api } from '../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { WeekStrip } from '#/components/schedule/WeekStrip'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { WeatherBanner } from '#/components/schedule/WeatherBanner'
import { NewJobSheet } from '#/components/schedule/NewJobSheet'
import { EmptyState } from '#/components/primitives/EmptyState'
import {
  addDaysToKey,
  formatDayLabel,
  formatMonthLabel,
  startOfWeekKey,
  todayKey as todayKeyIn,
} from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'

const searchSchema = z.object({
  // Lives in the URL, not useState: the day a tech is looking at survives a
  // refresh and is shareable (§5.1).
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})

export const Route = createFileRoute('/$businessSlug/schedule')({
  validateSearch: searchSchema,
  component: SchedulePage,
})

function SchedulePage() {
  const { business } = Route.useRouteContext()
  const { date } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [openJobId, setOpenJobId] = useState<string | null>(null)
  const [newJobOpen, setNewJobOpen] = useState(false)
  // A button that opens a sheet does nothing before hydration, and does it
  // silently. Disabling until ready is honest and gives tests a real signal.
  const hydrated = useHydrated()

  const today = todayKeyIn(business.timezone)
  const selectedKey = date ?? today
  const weekStart = startOfWeekKey(selectedKey)

  const { data: week } = useSuspenseQuery(
    convexQuery(api.jobs.listWeek, {
      businessId: business._id,
      startKey: weekStart,
    }),
  )
  const { data: jobs } = useSuspenseQuery(
    convexQuery(api.jobs.listDay, {
      businessId: business._id,
      dayKey: selectedKey,
    }),
  )

  const setDay = (dayKey: string) =>
    navigate({ search: { date: dayKey }, replace: true })

  return (
    <>
      <PageHeader
        kicker={formatMonthLabel(selectedKey)}
        title="Schedule"
        action={
          <button
            type="button"
            aria-label="New job"
            disabled={!hydrated}
            onClick={() => setNewJobOpen(true)}
            className="flex size-9 items-center justify-center rounded-full bg-red text-white shadow-red transition active:scale-[.95] disabled:opacity-50"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
        }
      />

      <div className="chrome-blur sticky top-[76px] z-20 border-b border-hairline">
        <div className="flex items-center justify-between px-3 pt-2">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => setDay(addDaysToKey(selectedKey, -7))}
            className="flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
          >
            <ChevronLeft size={20} strokeWidth={1.7} />
          </button>
          <button
            type="button"
            onClick={() => setDay(today)}
            className="text-body font-semibold text-blue"
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Next week"
            onClick={() => setDay(addDaysToKey(selectedKey, 7))}
            className="flex size-8 items-center justify-center rounded-full text-blue transition active:scale-[.95]"
          >
            <ChevronRight size={20} strokeWidth={1.7} />
          </button>
        </div>
        <WeekStrip
          startKey={weekStart}
          selectedKey={selectedKey}
          todayKey={today}
          load={week}
          onSelect={setDay}
        />
      </div>

      {/* Keyed to the first job's suburb and labelled with it: a day spanning
          several suburbs has no single forecast, so claiming one would be a
          quiet lie. */}
      {jobs.length > 0 && jobs[0].suburb && (
        <div className="pt-4">
          <WeatherBanner
            businessId={business._id}
            suburb={jobs[0].suburb}
            postcode={jobs[0].postcode ?? ''}
            state={business.state}
            dayKey={selectedKey}
          />
        </div>
      )}

      <section className="px-4 pt-4 pb-6">
        <h2 className="section-label mb-3">{formatDayLabel(selectedKey)}</h2>

        {jobs.length === 0 ? (
          <EmptyState
            title="Nothing booked"
            body="This day is clear. Tap + to book a job."
          />
        ) : (
          // Two columns from md: the same cards, re-flowed. A desktop screen
          // showing one 460px column of jobs wastes the extra width that makes
          // a week readable at a glance.
          <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-start lg:grid-cols-3">
            {jobs.map((job) => (
              <JobCard
                key={job._id}
                job={job}
                timezone={business.timezone}
                onOpen={setOpenJobId}
              />
            ))}
          </div>
        )}
      </section>

      <JobDetailSheet
        businessId={business._id}
        timezone={business.timezone}
        jobId={openJobId}
        onClose={() => setOpenJobId(null)}
      />

      <NewJobSheet
        businessId={business._id}
        dayKey={selectedKey}
        open={newJobOpen}
        onClose={() => setNewJobOpen(false)}
      />
    </>
  )
}
