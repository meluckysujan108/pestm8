import { useId, useRef, useState } from 'react'
import { Check, ListFilter } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { Segmented } from '#/components/primitives/Segmented'
import {
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import type { PointerEventHandler, ReactNode } from 'react'

/**
 * A list's filters and sort behind one icon, and the sheet it opens — the
 * Schedule's first, then every list that filters (§5, Filters and views).
 *
 * Chips in a header row are as wide as the word chosen in them: picking one
 * moved the next along, "Clear filters" came and went beside them, and a row
 * of them came and went with the data, so the cards under them jumped. The
 * icon is one size whatever is chosen. Blue while anything is filtered, with
 * how many filters are on, as every active filter is blue; a sort is no
 * filter, so it is not counted. The sheet applies each choice as it is made,
 * so what is behind it is already the answer when Done closes it.
 */
export function FilterButton({
  title,
  on,
  disabled = false,
  onClear,
  onOpenChange,
  onPointerDown,
  children,
}: {
  /** "Filter and sort", or "Filters" where there is no sort. */
  title: string
  /** How many filters are on: the badge, and whether Clear filters can. */
  on: number
  /** Until the page hydrates, so a tap is never swallowed by inert markup. */
  disabled?: boolean
  /** Every filter back to its default. The sort stays: it hides nothing. */
  onClear: () => void
  /** The sheet opened or closed: a list that counts what its filters would
   * show can start reading what it counts. */
  onOpenChange?: (open: boolean) => void
  /** The finger is down on the icon: whatever the sheet will need is worth
   * asking for now. */
  onPointerDown?: PointerEventHandler<HTMLButtonElement>
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const show = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-label={on > 0 ? `${title}, ${on} on` : title}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onClick={() => show(true)}
        className={`relative tap-target flex size-9 shrink-0 items-center justify-center rounded-full border outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.95] disabled:opacity-60 ${
          on > 0
            ? 'border-blue/30 bg-blue/12 text-blue'
            : 'border-hairline bg-surface text-ink-2'
        }`}
      >
        <ListFilter size={18} strokeWidth={1.7} aria-hidden />
        {on > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 min-w-4 rounded-full bg-blue px-1 text-center text-[11px] leading-4 font-bold text-on-tint tabular-nums"
          >
            {on}
          </span>
        )}
      </button>

      <Sheet
        open={open}
        onClose={() => show(false)}
        title={title}
        returnFocusRef={opener}
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              disabled={on === 0}
              onClick={onClear}
              className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
            >
              Clear filters
            </button>
            <button
              type="button"
              onClick={() => show(false)}
              className={`${NEUTRAL_BUTTON_COMPACT} flex-1`}
            >
              Done
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-5">{children}</div>
      </Sheet>
    </>
  )
}

/** Two to four orders, all visible: a `Segmented` (§5, Filters and views). */
export function FilterSort<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  const id = useId()
  // A sort the address asks for that this list doesn't offer (by
  // technician, with one person) reads as the first, which is what it
  // amounts to.
  const shown = options.some((option) => option.value === value)
    ? value
    : options[0].value
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="section-label mb-2">
        Sort by
      </h3>
      <Segmented
        kind="choice"
        labelledBy={id}
        value={shown}
        options={options}
        onChange={onChange}
      />
    </section>
  )
}

/**
 * A filter's choices as chips with counts: a `role="group"` of `aria-pressed`
 * buttons. A choice at 0 is no choice, unless it is the one chosen; a choice
 * whose count isn't known yet shows none and stays. A long list (suburbs)
 * shows its first `collapseAfter`, most first, and the chosen one, with
 * "Show all" for the rest.
 */
export function FilterChips<T extends string>({
  label,
  value,
  options,
  onChange,
  collapseAfter,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string; count?: number }>
  onChange: (value: T) => void
  collapseAfter?: number
}) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const offered = options.filter(
    (option) =>
      option.count === undefined || option.count > 0 || option.value === value,
  )
  const collapsed =
    !expanded && collapseAfter !== undefined && offered.length > collapseAfter
  const shown = collapsed
    ? offered.filter(
        (option, index) => index < collapseAfter || option.value === value,
      )
    : offered
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="section-label mb-2">
        {label}
      </h3>
      <div role="group" aria-labelledby={id} className="flex flex-wrap gap-2">
        {shown.map((option) => {
          const chosen = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={chosen}
              onClick={() => onChange(option.value)}
              // Drawn 36px, tapped at 44 (`tap-target`), as the app's other
              // filter chips.
              className={`relative tap-target inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border px-3 text-caption font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.97] ${
                chosen
                  ? 'border-blue/30 bg-blue/12 text-blue'
                  : 'border-hairline bg-surface text-ink-2'
              }`}
            >
              <span className="truncate">{option.label}</span>
              {option.count !== undefined && (
                <span className={`tabular-nums ${chosen ? '' : 'text-muted'}`}>
                  {option.count}
                </span>
              )}
            </button>
          )
        })}
        {collapsed && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="relative tap-target inline-flex min-h-9 items-center px-1 text-caption font-semibold text-blue"
          >
            Show all {offered.filter((option) => option.value !== 'all').length}
          </button>
        )}
      </div>
    </section>
  )
}

/** One person a list can be narrowed to: their colour, and how many —
 * where the list knows (a paged list holds only what it has loaded). */
export type FilterPerson = {
  membershipId: string
  name: string
  colour?: string
  count?: number
}

/** Whose: Everyone, then each person with their colour and, where the
 * list can count them, how many. */
export function FilterPeople({
  label = 'Technician',
  value,
  everyone,
  people,
  onChange,
}: {
  label?: string
  value: string
  everyone?: number
  people: ReadonlyArray<FilterPerson>
  onChange: (membershipId: string) => void
}) {
  const id = useId()
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="section-label mb-1">
        {label}
      </h3>
      <ul className="flex flex-col">
        {[
          {
            membershipId: 'all',
            name: 'Everyone',
            colour: undefined,
            count: everyone,
          },
          ...people,
        ].map((person) => {
          const chosen = person.membershipId === value
          return (
            <li key={person.membershipId}>
              <button
                type="button"
                aria-pressed={chosen}
                onClick={() => onChange(person.membershipId)}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-1 text-left text-body text-ink outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:bg-surface-2"
              >
                <span
                  aria-hidden
                  className={`size-2.5 shrink-0 rounded-full ${person.colour ? '' : 'border border-hairline'}`}
                  style={
                    person.colour
                      ? { backgroundColor: person.colour }
                      : undefined
                  }
                />
                <span className="min-w-0 flex-1 truncate">{person.name}</span>
                {person.count !== undefined && (
                  <span className="shrink-0 text-caption text-muted tabular-nums">
                    {person.count}
                  </span>
                )}
                <Check
                  size={16}
                  strokeWidth={2.2}
                  aria-hidden
                  className={`shrink-0 text-blue ${chosen ? '' : 'invisible'}`}
                />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
