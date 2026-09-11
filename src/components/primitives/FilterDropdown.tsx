import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover } from 'radix-ui'

export type FilterDropdownOption = {
  value: string
  label: string
  /** Optional swatch, e.g. a staff member's colour — mirrors BusinessSwitcher's rows. */
  colour?: string
  /** Optional trailing count, e.g. "(3)" — mirrors MonthCalendarCard's team legend row. */
  count?: number
}

/**
 * A compact single-select filter chip — the same `radix-ui` Popover wiring
 * as `Combobox`/`BusinessSwitcher`, but without a search input: this is for
 * short option lists (status, staff) sitting as a pill next to another chip
 * in a header row, not a full-width form field.
 */
export function FilterDropdown({
  label,
  value,
  options,
  onChange,
  active,
}: {
  label: string
  value: string
  options: Array<FilterDropdownOption>
  onChange: (value: string) => void
  active: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        aria-label={label}
        className={[
          'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition active:scale-[.97]',
          active
            ? 'border-blue/30 bg-blue/12 text-blue'
            : 'border-hairline bg-surface-2 text-ink-2',
        ].join(' ')}
      >
        <span className="max-w-32 truncate">{current?.label ?? value}</span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={active ? 'text-blue' : 'text-muted'}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 max-h-72 w-56 overflow-y-auto rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-row-title text-ink transition hover:bg-surface-2"
            >
              {option.colour && (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: option.colour }}
                />
              )}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.count !== undefined && (
                <span className="shrink-0 text-caption tabular-nums text-muted">
                  {option.count}
                </span>
              )}
              {option.value === value && (
                <Check
                  size={16}
                  strokeWidth={2}
                  className="shrink-0 text-blue"
                />
              )}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
