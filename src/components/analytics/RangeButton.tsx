import { useId, useRef, useState } from 'react'
import { CalendarDays, Check, ChevronDown } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { Segmented } from '#/components/primitives/Segmented'
import { FormField } from '#/components/forms/FormField'
import { FieldMessage } from '#/components/forms/FieldMessage'
import {
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import {
  COMPARE_OPTIONS,
  RANGE_LABEL,
  RANGE_PRESETS,
} from '#/lib/analyticsView'
import { formatDateRange } from '#/lib/format'
import {
  MAX_RANGE_DAYS,
  isValidRange,
} from '../../../convex/lib/analyticsRange'
import type { Compare, DayRange } from '../../../convex/lib/analyticsRange'
import type { RangePreset, ResolvedRange } from '#/lib/analyticsView'

/**
 * Which days Analytics covers and what they are compared with, behind one
 * button that says the range it is on. The sheet applies each choice as it
 * is made, as a list's filters do (`FilterButton`), so the page behind it is
 * already the answer when Done closes it.
 *
 * The button is as wide as its words, but it is first in its row with the
 * filter icon pinned to the row's end, so a longer range moves nothing.
 */
export function RangeButton({
  range,
  compare,
  today,
  disabled = false,
  onRange,
  onCompare,
}: {
  range: ResolvedRange
  compare: Compare
  /** Today in the business's calendar: the last day that can be asked for
   * is whatever the person types, but the year is said against this. */
  today: string
  /** Until the page hydrates. */
  disabled?: boolean
  onRange: (choice: RangePreset | DayRange) => void
  onCompare: (compare: Compare) => void
}) {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const label =
    range.preset === 'custom'
      ? formatDateRange(range.from, range.to, today)
      : RANGE_LABEL[range.preset]

  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="relative tap-target inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 text-caption font-semibold text-ink outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.97] disabled:opacity-60"
      >
        <CalendarDays size={15} strokeWidth={2} aria-hidden />
        <span className="sr-only">Date range: </span>
        <span className="truncate">{label}</span>
        <ChevronDown size={14} strokeWidth={2.2} aria-hidden />
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Date range"
        returnFocusRef={opener}
        footer={
          <button
            type="button"
            onClick={() => setOpen(false)}
            className={`${NEUTRAL_BUTTON_COMPACT} w-full`}
          >
            Done
          </button>
        }
      >
        <div className="flex flex-col gap-5">
          <Presets chosen={range.preset} onChoose={onRange} />
          <OwnDates
            // A range chosen elsewhere in the sheet is what the fields show.
            key={`${range.from}:${range.to}`}
            range={range}
            onChoose={onRange}
          />
          <CompareWith compare={compare} onChange={onCompare} />
        </div>
      </Sheet>
    </>
  )
}

function Presets({
  chosen,
  onChoose,
}: {
  chosen: RangePreset | 'custom'
  onChoose: (preset: RangePreset) => void
}) {
  const id = useId()
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="section-label mb-1">
        Show
      </h3>
      <ul className="flex flex-col">
        {RANGE_PRESETS.map((preset) => (
          <li key={preset}>
            <button
              type="button"
              aria-pressed={preset === chosen}
              onClick={() => onChoose(preset)}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-1 text-left text-body text-ink outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate">
                {RANGE_LABEL[preset]}
              </span>
              <Check
                size={16}
                strokeWidth={2.2}
                aria-hidden
                className={`shrink-0 text-blue ${preset === chosen ? '' : 'invisible'}`}
              />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function OwnDates({
  range,
  onChoose,
}: {
  range: DayRange
  onChoose: (range: DayRange) => void
}) {
  const id = useId()
  const fromId = useId()
  const toId = useId()
  const [from, setFrom] = useState(range.from)
  const [to, setTo] = useState(range.to)
  const [refused, setRefused] = useState(false)
  const unchanged = from === range.from && to === range.to

  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="section-label mb-2">
        Your own dates
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <FormField id={fromId} label="From" size="md">
          {(control) => (
            <input
              {...control}
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => {
                setFrom(e.target.value)
                setRefused(false)
              }}
            />
          )}
        </FormField>
        <FormField id={toId} label="To" size="md">
          {(control) => (
            <input
              {...control}
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => {
                setTo(e.target.value)
                setRefused(false)
              }}
            />
          )}
        </FormField>
      </div>
      {refused && (
        <FieldMessage tone="error" className="mt-2">
          Pick a first day on or before the last, no more than {MAX_RANGE_DAYS}{' '}
          days apart.
        </FieldMessage>
      )}
      <button
        type="button"
        disabled={unchanged}
        onClick={() => {
          if (isValidRange({ from, to })) onChoose({ from, to })
          else setRefused(true)
        }}
        className={`${SECONDARY_BUTTON_COMPACT} mt-3 w-full`}
      >
        Show these dates
      </button>
    </section>
  )
}

function CompareWith({
  compare,
  onChange,
}: {
  compare: Compare
  onChange: (compare: Compare) => void
}) {
  const id = useId()
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="section-label mb-2">
        Compare with
      </h3>
      <Segmented
        kind="choice"
        labelledBy={id}
        value={compare}
        options={COMPARE_OPTIONS}
        onChange={onChange}
      />
    </section>
  )
}
