import { useRef } from 'react'
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
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  kind = 'tabs',
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
  /** Until the page hydrates, so a tap is never swallowed by inert markup. */
  disabled?: boolean
  kind?: 'tabs' | 'choice'
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const choice = kind === 'choice'
  const selectedIndex = options.findIndex((option) => option.value === value)

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || options.length === 0) return
    const from = Math.max(selectedIndex, 0)
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
    onChange(options[to].value)
    buttons.current[to]?.focus()
  }

  return (
    <div
      role={choice ? 'radiogroup' : 'tablist'}
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex rounded-[9px] bg-fill-track p-0.5"
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
            // One stop on the Tab key: the selected segment, or the first
            // when nothing is.
            tabIndex={
              selected || (selectedIndex === -1 && index === 0) ? 0 : -1
            }
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`relative tap-target flex-1 rounded-[7px] px-3 py-1.5 text-[13px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue ${
              selected ? 'bg-surface text-ink shadow-elevation' : 'text-muted'
            } disabled:opacity-60`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
