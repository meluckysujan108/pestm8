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
 *
 * With no `dayShown`, a list of every day's (the Job tab's, above its list:
 * `useOutboxList`): each card dated, its people named and its forecast
 * asked for, as that list's own cards are, and headed as a section of the
 * page (`h2`) rather than of a day (`h3`).
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
  /** The day the list shows (`JobCard`'s `dayShown`); none for a list of
   * every day. */
  dayShown?: string
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
  // Under the day's own h2 on the Schedule; the Job tab's has only the
  // page's h1 above it, so it is a section of the page.
  const Heading = dayShown === undefined ? 'h2' : 'h3'
  return (
    <section aria-labelledby={headingId} className={className}>
      {/* Its counts change in place as the bookings go. */}
      <Heading
        id={headingId}
        aria-live="polite"
        className="section-label mb-2 truncate"
      >
        {day.heading}
      </Heading>
      <div className={grid}>
        {day.slots.map((slot) => (
          <JobCard
            key={slot.key}
            job={slot.row}
            weather={
              dayShown === undefined ||
              dayKeyOf(slot.row.scheduledAt, timezone) === dayShown
                ? weatherOf(slot.row)
                : { status: 'outOfWindow' }
            }
            timezone={timezone}
            onOpen={onOpenJob}
            hideTechnician={dayShown !== undefined}
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
