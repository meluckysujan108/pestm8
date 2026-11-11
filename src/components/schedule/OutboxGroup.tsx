import { useId } from 'react'
import { chipFor } from '#/lib/outbox/outboxRules'
import { dayKeyOf } from '../../../convex/lib/dates'
import { JobCard } from './JobCard'
import { OutboxChip } from './OutboxChip'
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
 * (`useOutboxDay`, lib/outbox/latchSlots.ts). Today's also lists the
 * bookings of other days that need a look, with their date and no forecast,
 * the page's being the day shown's, and after them any saved by a newer
 * PestM8, whose day can't be read: a card of their own that opens their
 * sheet, for its Discard (plan D13). Nothing when there are none.
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
  /** The forecast for a card of the day shown. */
  weatherOf: (row: JobRow) => WeatherCell
  /** The day's own grid classes, so the group's cards are the day's. */
  grid: string
  className?: string
}) {
  const headingId = useId()
  const foreign = day.foreign ?? []
  if (day.slots.length === 0 && foreign.length === 0) return null
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
            weather={
              dayKeyOf(slot.row.scheduledAt, timezone) === dayShown
                ? weatherOf(slot.row)
                : { status: 'outOfWindow' }
            }
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
        {foreign.map((item) => (
          <button
            key={`outbox:${item.localId}`}
            type="button"
            onClick={() => onOpenItem(item.localId)}
            className="relative flex w-full flex-col items-start gap-2 rounded-2xl border border-hairline bg-surface p-4 text-left shadow-elevation transition active:scale-[.99]"
          >
            <OutboxChip chip={chipFor(item)} lineLive={day.lineLive} />
            <span className="text-body font-semibold text-ink">
              A job saved by a newer PestM8
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
