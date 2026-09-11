import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsUpDown, Search } from 'lucide-react'
import { Popover } from 'radix-ui'

export type ComboboxOption = { value: string; label: string }

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
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  allowCustom = false,
  customLabel,
  noMatchLabel = 'No matches',
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<ComboboxOption>
  placeholder?: string
  allowCustom?: boolean
  customLabel?: (query: string) => string
  noMatchLabel?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const currentLabel = options.find((o) => o.value === value)?.label ?? value

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

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
        type="button"
        aria-label={ariaLabel}
        className="flex h-12 w-full items-center justify-between gap-2 rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
      >
        <span className="min-w-0 truncate text-left">{currentLabel}</span>
        <ChevronsUpDown
          size={16}
          strokeWidth={1.7}
          className="shrink-0 text-muted"
        />
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
              placeholder={placeholder}
              className="h-11 flex-1 bg-transparent text-[16px] text-ink outline-none"
            />
          </label>

          <div className="mt-1 max-h-64 overflow-y-auto">
            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => choose(o.value)}
                className="flex w-full items-center rounded-xl px-2.5 py-2 text-left text-row-title text-ink transition hover:bg-surface-2"
              >
                {o.label}
              </button>
            ))}

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
