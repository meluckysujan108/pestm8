import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

/**
 * Segmented control. Never a dropdown for binary/ternary filters (§2.3).
 *
 * Two kinds, because it does two jobs that assistive tech names differently:
 * - `tabs` (the default) switches what the screen below shows — the
 *   Schedule's Day/Week/Month, the Job tab's Job/Recurring Job, a report's
 *   PDF/Email/Logs. A tablist.
 * - `choice` is an answer in a form — Person or Business, Contractor or
 *   Subcontractor, One-off or Recurring Job. A radio group: it has no panels,
 *   and "tab 1 of 2" was announcing a form field as navigation.
 *
 * Either way it is one stop on the Tab key, on the selected segment, and the
 * arrow keys (Home/End too) move the selection, as both patterns expect.
 *
 * With nothing chosen yet (a `value` none of the options has — Match your
 * clients' "Same client" / "Different client", which saves the moment it is
 * chosen) the arrows only move between the segments, and Space, Enter or a
 * tap chooses: an arrow pressed to look, or to scroll, must not answer the
 * question. The unchosen segments are drawn in `ink-2` then, not `muted`:
 * each is an answer to read, in sun, not the quiet other half of a switch.
 *
 * Under a caption on a form, the caption names it: give the caption an id and
 * pass it as `labelledBy`. Never wrap it in a `<label>` (or a `Field` that is
 * one): a label names only its first control, so the first segment took the
 * caption as its name ("Client Client", not "Existing client"), and a tap on
 * the caption chose it.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  labelledBy,
  disabled = false,
  kind = 'tabs',
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  /** Until the page hydrates, so a tap is never swallowed by inert markup. */
  disabled?: boolean
  kind?: 'tabs' | 'choice'
} & (
  | {
      /** The group's name, where nothing on screen says it. */
      label: string
      labelledBy?: undefined
    }
  | {
      /** The id of the visible caption that names the group. */
      labelledBy: string
      label?: undefined
    }
)) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const choice = kind === 'choice'
  const selectedIndex = options.findIndex((option) => option.value === value)
  const unanswered = selectedIndex === -1
  // Where the arrows have moved to while nothing is chosen: the Tab stop.
  const [cursor, setCursor] = useState(0)

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || options.length === 0) return
    const from = unanswered
      ? Math.min(cursor, options.length - 1)
      : selectedIndex
    const last = options.length - 1
    const to = {
      ArrowRight: from === last ? 0 : from + 1,
      ArrowDown: from === last ? 0 : from + 1,
      ArrowLeft: from === 0 ? last : from - 1,
      ArrowUp: from === 0 ? last : from - 1,
      Home: 0,
      End: last,
    }[event.key]
    if (to === undefined) return
    event.preventDefault()
    if (unanswered) setCursor(to)
    else onChange(options[to].value)
    buttons.current[to]?.focus()
  }

  return (
    <div
      role={choice ? 'radiogroup' : 'tablist'}
      aria-label={label}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      className="flex rounded-segmented bg-fill-track p-0.5"
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            role={choice ? 'radio' : 'tab'}
            aria-checked={choice ? selected : undefined}
            aria-selected={choice ? undefined : selected}
            // One stop on the Tab key: the selected segment, or — when
            // nothing is — the one the arrows last moved to (the first).
            tabIndex={
              selected ||
              (unanswered && index === Math.min(cursor, options.length - 1))
                ? 0
                : -1
            }
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`relative tap-target flex-1 rounded-segment px-3 py-1.5 text-caption font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue ${
              selected
                ? 'bg-surface text-ink shadow-elevation'
                : unanswered
                  ? 'text-ink-2'
                  : 'text-muted'
            } disabled:opacity-60`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
