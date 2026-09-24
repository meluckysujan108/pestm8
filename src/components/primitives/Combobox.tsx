import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Ref } from 'react'
import { ChevronsUpDown, Search } from 'lucide-react'
import { Popover } from 'radix-ui'
import { filterByWords, pickOnEnter } from '#/lib/searchMatch'

export type ComboboxOption = {
  value: string
  label: string
  /** What the search matches against, when it should be more than the
   * label — a phone number or postcode nobody wants to read in the list. */
  searchText?: string
}

/**
 * Past this many matches the list asks for more typing instead of rendering
 * every row: a phone popover with a few thousand buttons in it is slow to
 * open and useless to scroll.
 */
const MAX_ROWS = 100

/**
 * A searchable dropdown, built on the same `radix-ui` `Popover` this app
 * already uses for `BusinessSwitcher.tsx`'s "anchored floating panel" —
 * no new dependency. The closed/trigger state matches this app's plain
 * `<select>` styling so it drops into the same layout; the open state
 * matches the search-input convention already used on `clients/index.tsx`.
 *
 * `allowCustom` decides what happens when the typed query has no match:
 * true (job type) offers an "Add ..." row that commits the typed text as
 * the value; false (property — a job must reference a real property) shows
 * `noMatchLabel` with no way to submit unlisted text.
 *
 * Every word typed must match, in any order, so "nguyen bayswater" finds the
 * row whose label reads "J. Nguyen — 12 Wattle Street, Bayswater".
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  emptyLabel,
  allowCustom = false,
  customLabel,
  noMatchLabel = 'No matches',
  ariaLabel,
  invalid = false,
  errorId,
  triggerRef,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<ComboboxOption>
  placeholder?: string
  /** Shown on the closed trigger while nothing is chosen. */
  emptyLabel?: string
  allowCustom?: boolean
  customLabel?: (query: string) => string
  noMatchLabel?: string
  ariaLabel?: string
  /** Marks the trigger invalid and ties it to the message that says why. */
  invalid?: boolean
  errorId?: string
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const valueId = useId()

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const currentLabel = options.find((o) => o.value === value)?.label ?? value

  const filtered = useMemo(
    () => filterByWords(options, query),
    [options, query],
  )
  const shown = filtered.slice(0, MAX_ROWS)

  const trimmedQuery = query.trim()
  const hasExactMatch = filtered.some(
    (o) => o.label.toLowerCase() === trimmedQuery.toLowerCase(),
  )
  const showCustomRow = allowCustom && trimmedQuery.length > 0 && !hasExactMatch

  function choose(next: string) {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        // The aria-label names the field, which hides the chosen value from a
        // screen reader; describing the trigger by its own text says it back.
        aria-describedby={
          [currentLabel || emptyLabel ? valueId : null, invalid ? errorId : null]
            .filter(Boolean)
            .join(' ') || undefined
        }
        aria-invalid={invalid || undefined}
        // Red while invalid even with focus on it: focus is moved here when
        // booking is refused, and a blue focus ring would hide the reason.
        className={`flex h-12 w-full items-center justify-between gap-2 rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none ${invalid ? 'ring-2 ring-red' : 'focus:ring-2 focus:ring-blue'}`}
      >
        {currentLabel ? (
          <span id={valueId} className="min-w-0 truncate text-left">
            {currentLabel}
          </span>
        ) : (
          <span id={valueId} className="min-w-0 truncate text-left text-muted">
            {emptyLabel}
          </span>
        )}
        <ChevronsUpDown size={16} strokeWidth={1.7} className="shrink-0 text-muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            inputRef.current?.focus()
          }}
          style={{ width: 'var(--radix-popover-trigger-width)' }}
          className="z-50 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
        >
          <label className="flex items-center gap-2 rounded-xl bg-surface-3 px-3">
            <Search size={17} strokeWidth={1.7} className="text-muted" />
            {placeholder && <span className="sr-only">{placeholder}</span>}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // The popover is portalled outside any form, so Enter would
              // otherwise do nothing at all. It takes a row only when it is
              // plain which one was meant (see pickOnEnter).
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const picked = pickOnEnter(filtered, query, allowCustom)
                if (picked !== null) choose(picked)
              }}
              // Surnames and suburbs are not dictionary words; a phone that
              // "corrects" one after the space empties the list.
              autoCorrect="off"
              spellCheck={false}
              placeholder={placeholder}
              className="h-11 flex-1 bg-transparent text-[16px] text-ink outline-none"
            />
          </label>

          <div className="mt-1 max-h-64 overflow-y-auto">
            {shown.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => choose(o.value)}
                className="flex w-full items-center rounded-xl px-2.5 py-2 text-left text-row-title text-ink transition hover:bg-surface-2"
              >
                {o.label}
              </button>
            ))}

            {filtered.length > shown.length && (
              <p className="px-2.5 py-2 text-caption text-muted">
                Showing {shown.length} of {filtered.length}. Keep typing to
                narrow it down.
              </p>
            )}

            {showCustomRow && (
              <button
                type="button"
                onClick={() => choose(trimmedQuery)}
                className="flex w-full items-center rounded-xl px-2.5 py-2 text-left text-row-title text-blue transition hover:bg-surface-2"
              >
                {customLabel?.(trimmedQuery) ?? `Add "${trimmedQuery}"`}
              </button>
            )}

            {filtered.length === 0 && !showCustomRow && (
              <p className="px-2.5 py-3 text-center text-caption text-muted">
                {noMatchLabel}
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
