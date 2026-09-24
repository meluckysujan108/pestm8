import {
  INTERVAL_UNITS,
  MAX_INTERVAL_COUNT,
  describeInterval,
} from '../../../convex/lib/recurrence'
import type { Interval, IntervalUnit } from '../../../convex/lib/recurrence'

/**
 * How often a Recurring Job repeats: a number and a unit, in that order,
 * reading left to right as "every 2 weeks".
 *
 * A dropdown of four named intervals used to stand here. It could not express
 * a fortnightly rodent program, a one-week follow-up or a 15-year termite
 * warranty inspection — all of which are things a pest business sells — so it
 * is a free number now. Every place that sets up a recurrence uses this one
 * control: the new-job sheet, the job edit form and "Make recurring".
 */
export const UNIT_LABELS: Record<IntervalUnit, { one: string; many: string }> =
  {
    day: { one: 'day', many: 'days' },
    week: { one: 'week', many: 'weeks' },
    month: { one: 'month', many: 'months' },
    year: { one: 'year', many: 'years' },
  }

const FIELD =
  'h-12 rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue'

/**
 * The count as the input holds it: a string, because an `<input type=number>`
 * is empty while someone is retyping it and coercing that to 0 mid-keystroke
 * fights the person typing.
 */
export type IntervalDraft = { count: string; unit: IntervalUnit }

export const DEFAULT_INTERVAL: IntervalDraft = { count: '3', unit: 'month' }

/**
 * The draft as an interval, or null while it does not describe one. The server
 * refuses the same values (`assertInterval`); this is what lets the form say
 * so before a round trip, and what disables its submit button.
 */
export function intervalFromDraft(draft: IntervalDraft): Interval | null {
  const count = Number(draft.count)
  if (!Number.isInteger(count) || count < 1 || count > MAX_INTERVAL_COUNT) {
    return null
  }
  return { count, unit: draft.unit }
}

export function RecurrenceFields({
  value,
  onChange,
  disabled = false,
  idPrefix = 'repeat',
}: {
  value: IntervalDraft
  onChange: (next: IntervalDraft) => void
  disabled?: boolean
  /** Distinct ids when two of these are ever on one screen. */
  idPrefix?: string
}) {
  const interval = intervalFromDraft(value)
  const count = Number(value.count)
  const plural = !Number.isFinite(count) || count !== 1

  return (
    <div>
      <div className="flex gap-2">
        <span className="flex h-12 shrink-0 items-center text-body text-muted">
          Every
        </span>
        <input
          id={`${idPrefix}-count`}
          type="number"
          min="1"
          max={MAX_INTERVAL_COUNT}
          step="1"
          inputMode="numeric"
          disabled={disabled}
          aria-label="Repeat every"
          aria-invalid={interval === null}
          value={value.count}
          onChange={(e) => onChange({ ...value, count: e.target.value })}
          className={`${FIELD} w-20 text-center tabular-nums`}
        />
        <select
          id={`${idPrefix}-unit`}
          disabled={disabled}
          aria-label="Repeat unit"
          value={value.unit}
          onChange={(e) =>
            onChange({ ...value, unit: e.target.value as IntervalUnit })
          }
          className={`${FIELD} min-w-0 flex-1`}
        >
          {INTERVAL_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {plural ? UNIT_LABELS[unit].many : UNIT_LABELS[unit].one}
            </option>
          ))}
        </select>
      </div>

      {/* Said back in the same words the rest of the app uses for a repeat, so
          what was typed and what will be stored are visibly the same thing. */}
      <p
        className={`mt-1.5 text-caption ${interval ? 'text-muted' : 'text-red'}`}
        role={interval ? undefined : 'alert'}
      >
        {interval
          ? `${describeInterval(interval)}, starting from this job's date.`
          : `Enter a whole number between 1 and ${MAX_INTERVAL_COUNT}.`}
      </p>
    </div>
  )
}
