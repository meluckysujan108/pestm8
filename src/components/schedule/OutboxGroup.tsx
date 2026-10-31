import { useId } from 'react'
import { JobCard } from './JobCard'
import type { JobRow } from './JobCard'
import type { OutboxDay } from '#/lib/outbox/useOutbox'
import type { WeatherCell } from '#/lib/weather'

/**
 * A day's bookings on this phone, not sent yet (lib/outbox/): their own
 * group under the day's cards, headed by what might be booked again by
 * mistake ("2 jobs not sent yet", "2 jobs not sent yet, 1 sending", "1 job
 * sending", then "Sent" once every slot has gone), each drawn by `JobCard`
 * as the card its job will be, its chip where the job number and status
 * are. A sibling of the day's grid, never cells in it, so it moves nothing
 * above it whenever it comes; and each booking keeps its slot until the
 * next redraw, the real job taking its place there once sent
 * (`useOutboxDay`, lib/outbox/latchSlots.ts). Nothing when there are none.
 */
export function OutboxGroup({
  day,
  timezone,
  dayShown,
  onOpenItem,
  onOpenJob,
  weatherOf,
  grid,
  className = '',
}: {
  day: OutboxDay
  timezone: string
  /** The day the list shows (`JobCard`'s `dayShown`). */
  dayShown: string
  /** Opens a booking not sent yet (`?outboxId=`). */
  onOpenItem: (localId: string) => void
  /** Opens a job a slot now draws, once sent. */
  onOpenJob: (jobId: string) => void
  weatherOf: (row: JobRow) => WeatherCell
  /** The day's own grid classes, so the group's cards are the day's. */
  grid: string
  className?: string
}) {
  const headingId = useId()
  if (day.slots.length === 0) return null
  return (
    <section aria-labelledby={headingId} className={className}>
      {/* Its counts change in place as the bookings go. */}
      <h3
        id={headingId}
        aria-live="polite"
        className="section-label mb-2 truncate"
      >
        {day.heading}
      </h3>
      <div className={grid}>
        {day.slots.map((slot) => (
          <JobCard
            key={slot.key}
            job={slot.row}
            weather={weatherOf(slot.row)}
            timezone={timezone}
            onOpen={onOpenJob}
            hideTechnician
            dayShown={dayShown}
            outbox={
              slot.chip === null
                ? undefined
                : {
                    chip: slot.chip,
                    lineLive: day.lineLive,
                    onOpen: () => onOpenItem(slot.localId),
                  }
            }
          />
        ))}
      </div>
    </section>
  )
}
