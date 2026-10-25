import { useRef, useState } from 'react'
import { FieldMessage } from '#/components/forms/FieldMessage'
import { fieldInputClass } from '#/components/forms/FormField'
import { formatDuration, formatTimeRange } from '#/lib/format'
import { endAfter, isDayKey, lengthBetween, minutesOfDay } from '#/lib/jobTimes'
import { zonedDateTimeToUtc } from '../../../convex/lib/dates'

/**
 * A job's start and end as its form holds them: two times of day on the
 * job's date (lib/jobTimes.ts). New Job and a job's edit form both ask for
 * them this way; the server is sent the length between them.
 *
 * The end follows the start, keeping the job as long as it was — a job moved
 * from 9 to 10 still takes its hour — until the end is set by hand. From then
 * on it stays where it was put: a time someone picked is never rewritten
 * without a tap (design system §4.2), and nudging the start must not lose
 * the end they chose.
 */
export function useJobTimes(opened: {
  start: string
  end: string
  /** The job's length as it opened, in minutes: what the end keeps to. */
  length: number
}) {
  const [held] = useState(opened)
  const [start, setStart] = useState(opened.start)
  const [end, setEnd] = useState(opened.end)
  const [endSet, setEndSet] = useState(false)
  // A start or an end that can't be booked is said once the time field
  // changed last has been left, or Book or Save has refused it: not while a
  // wheel still turns or an hour is half typed (design system §4.2).
  const [revealed, setRevealed] = useState(false)
  const startRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLInputElement>(null)
  const changed = start !== held.start || end !== held.end

  /**
   * Minutes from the start to the end on `dayKey`: the length to save.
   * While both times are as the form opened, the length it opened with, so a
   * job that already ran past midnight still does after an edit of
   * something else. Null when the end is not after the start.
   */
  function lengthOn(dayKey: string, timezone: string): number | null {
    return changed ? lengthBetween(dayKey, start, end, timezone) : held.length
  }

  return {
    start,
    end,
    /** Either time is not what the form opened with. */
    changed,
    revealed,
    startRef,
    endRef,
    lengthOn,
    changeStart(next: string) {
      setStart(next)
      setRevealed(false)
      if (endSet) return
      const moved = endAfter(next, held.length)
      if (moved !== null) setEnd(moved)
    },
    changeEnd(next: string) {
      setEnd(next)
      setEndSet(true)
      setRevealed(false)
    },
    reveal() {
      setRevealed(true)
    },
    /** At a press of Book or Save that `lengthOn` refused: says why under
     * the times, and moves to the one that would put it right. */
    refuse() {
      setRevealed(true)
      if (minutesOfDay(start) === null) startRef.current?.focus()
      else endRef.current?.focus()
    },
  }
}

export type JobTimes = ReturnType<typeof useJobTimes>

/**
 * Start and End side by side, picked the same way, with the job said back
 * under them as its card will show it: "9:00am – 1:30pm · 4 hr 30 min".
 * The length was the one thing typed before; now it is the one thing worked
 * out, so it is said where it can be checked.
 */
export function JobTimeFields({
  times,
  dayKey,
  timezone,
  idPrefix,
  className,
}: {
  times: JobTimes
  /** The job's date, from its own field or the Schedule's day. */
  dayKey: string
  timezone: string
  /** Distinct ids when two of these are ever on one screen. */
  idPrefix: string
  className?: string
}) {
  const length = times.lengthOn(dayKey, timezone)
  const from = minutesOfDay(times.start)
  const refused = length === null && times.revealed
  const messageId = `${idPrefix}-times`
  const describedBy = refused || length !== null ? messageId : undefined
  // The one to put right: the start while there is none, else the end.
  const startInvalid = refused && from === null
  const endInvalid = refused && from !== null

  return (
    <div className={className}>
      {/* A cell never grows past its half of the row: iOS gives date and
          time inputs a width of their own (see styles.css). */}
      <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Start</span>
          <input
            ref={times.startRef}
            type="time"
            required
            value={times.start}
            onChange={(e) => times.changeStart(e.target.value)}
            onBlur={times.reveal}
            aria-describedby={describedBy}
            aria-invalid={startInvalid || undefined}
            className={fieldInputClass('lg', startInvalid)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="section-label">End</span>
          <input
            ref={times.endRef}
            type="time"
            required
            value={times.end}
            onChange={(e) => times.changeEnd(e.target.value)}
            onBlur={times.reveal}
            aria-describedby={describedBy}
            aria-invalid={endInvalid || undefined}
            className={fieldInputClass('lg', endInvalid)}
          />
        </label>
      </div>
      {refused ? (
        <FieldMessage id={messageId} tone="error">
          {from === null
            ? 'Choose a start time.'
            : 'Choose an end time after the start.'}
        </FieldMessage>
      ) : length !== null ? (
        // Outside both labels, so it is not read as part of either's name;
        // read with each through aria-describedby, and again as it changes.
        <p
          id={messageId}
          aria-live="polite"
          className="mt-1.5 text-caption text-grey-ink"
        >
          {from !== null && isDayKey(dayKey)
            ? formatTimeRange(
                zonedDateTimeToUtc(
                  dayKey,
                  Math.floor(from / 60),
                  from % 60,
                  timezone,
                ),
                length,
                timezone,
              )
            : formatDuration(length)}
        </p>
      ) : null}
    </div>
  )
}
