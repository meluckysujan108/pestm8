import { useCallback, useId, useRef, useState } from 'react'
import type { Ref } from 'react'
import { Check, ChevronsUpDown, Plus, Search, X } from 'lucide-react'
import { filterByWords, pickOnEnter, startsFirst } from '#/lib/searchMatch'
import { NEUTRAL_BUTTON_COMPACT } from './buttons'
import { Sheet } from './Sheet'

export type ComboboxOption = {
  value: string
  label: string
  /** What the search matches against, when it should be more than the
   * label — a phone number or postcode nobody wants to read in the list. */
  searchText?: string
  /** A second, quieter line under the label in the list ("Added Tue 29
   * Sept"). Never on the closed field, and never matched or picked by. */
  detail?: string
  /** The heading this option is listed under while nothing is typed
   * ("Added recently"). Options come grouped, in the order given; once
   * something is typed the list is one list, best match first. */
  group?: string
}

/**
 * Past this many matches the list asks for more typing instead of rendering
 * every row: a phone sheet with a few thousand buttons in it is slow to open
 * and useless to scroll.
 */
const MAX_ROWS = 100

type Choice =
  | {
      multiple?: false
      value: string
      onChange: (value: string) => void
    }
  | {
      /** Several may be ticked; the sheet stays open until Done. */
      multiple: true
      value: ReadonlyArray<string>
      onChange: (value: Array<string>) => void
      /** The most that may be ticked. Once that many are, the rest of the
       * list is greyed and `fullLabel` says why, rather than a tap doing
       * nothing. */
      max?: number
      fullLabel?: string
    }

/**
 * A searchable choice from a long list — a property, a job's services —
 * picked in a sheet of its own.
 *
 * It used to open a popover anchored under the field. Inside a sheet that
 * failed on phones in two ways (reported from an Android phone, 29 Sept
 * 2026). The sheet locks scrolling to itself, and the popover, drawn outside
 * it, could not be scrolled at all: the job types below the first five, and
 * every client past the first few, could only be reached by typing. And the
 * search field took focus as it opened, so the keyboard rose over half the
 * list while the sheet under it jumped clear of the keyboard. A sheet of its
 * own is what iOS does for a pick (Calendar's Alert, Mail's accounts): it
 * scrolls like any sheet, sits above the keyboard when there is one, and
 * leaves the keyboard down until the search is tapped.
 *
 * The closed field matches this app's plain `<select>`, so it drops into the
 * same layout, and says what is chosen in full rather than cutting it off.
 *
 * `allowCustom` decides what happens when the typed query has no match: true
 * (job type) offers an "Add …" row that commits the typed text; false
 * (property — a job must reference a real property) shows `noMatchLabel`
 * with no way to submit unlisted text.
 *
 * Every word typed must match, in any order, so "nguyen bayswater" finds the
 * row whose label reads "J. Nguyen — 12 Wattle Street, Bayswater".
 */
export function Combobox({
  options,
  title,
  description,
  placeholder,
  emptyLabel,
  allowCustom = false,
  customLabel,
  noMatchLabel = 'No matches',
  ariaLabel,
  invalid = false,
  errorId,
  triggerRef,
  ...choice
}: Choice & {
  options: ReadonlyArray<ComboboxOption>
  /** Heads the sheet. The field's own name (`ariaLabel`) when left out. */
  title?: string
  /** A line under the title, saying how to choose ("Tick every service…"). */
  description?: string
  /** The search field's example text, and its name for a screen reader. */
  placeholder?: string
  /** Shown on the closed field while nothing is chosen. */
  emptyLabel?: string
  allowCustom?: boolean
  customLabel?: (query: string) => string
  noMatchLabel?: string
  ariaLabel?: string
  /** Marks the field invalid and ties it to the message that says why. */
  invalid?: boolean
  errorId?: string
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /**
   * Values the list does not offer — a job type typed in once — that have
   * been chosen since the sheet opened. Kept as rows until it closes, so
   * unticking one does not pull it out from under the finger.
   */
  const [extras, setExtras] = useState<Array<string>>([])
  const ownTrigger = useRef<HTMLButtonElement>(null)
  // The field is also the caller's, to move focus to when booking is refused.
  const setTrigger = useCallback(
    (node: HTMLButtonElement | null) => {
      ownTrigger.current = node
      if (typeof triggerRef === 'function') triggerRef(node)
      else if (triggerRef) triggerRef.current = node
    },
    [triggerRef],
  )
  const searchRef = useRef<HTMLInputElement>(null)
  const valueId = useId()

  const chosen: ReadonlyArray<string> = choice.multiple
    ? choice.value
    : choice.value
      ? [choice.value]
      : []
  const offered = (value: string) => options.some((o) => o.value === value)
  const labelOf = (value: string) =>
    options.find((o) => o.value === value)?.label ?? value
  const currentLabel = chosen.map(labelOf).join(', ')
  // As many ticked as may be: only an unticking is taken now.
  const full =
    choice.multiple && choice.max !== undefined && chosen.length >= choice.max

  // What is chosen now comes from the caller, which may have tidied what was
  // typed (a job type with a comma in it is two); what was chosen and then
  // unticked comes from `extras`. In the order each was first seen. Only a
  // list that takes typed values has any: a property not in the list (still
  // loading, or out of the viewer's reach) would be a row naming its id.
  const unlisted = allowCustom
    ? [
        ...extras,
        ...chosen.filter((value) => !offered(value) && !extras.includes(value)),
      ]
    : []
  const rows: Array<ComboboxOption> = [
    ...options,
    ...unlisted.map((value) => ({ value, label: value })),
  ]
  const filtered = filterByWords(rows, query)
  // Typed: one list, names starting with the text first (searchMatch.ts).
  // Not typed: the caller's order, under its headings.
  const searching = query.trim() !== ''
  const ordered = searching ? startsFirst(filtered, query) : filtered
  const shown = ordered.slice(0, MAX_ROWS)
  const sections: Array<{ group?: string; rows: Array<ComboboxOption> }> = []
  for (const row of shown) {
    const group = searching ? undefined : row.group
    const last = sections.at(-1)
    if (last && last.group === group) last.rows.push(row)
    else sections.push({ group, rows: [row] })
  }

  const trimmedQuery = query.trim()
  const hasExactMatch = rows.some(
    (o) => o.label.toLowerCase() === trimmedQuery.toLowerCase(),
  )
  const showCustomRow = allowCustom && trimmedQuery.length > 0 && !hasExactMatch

  function openSheet() {
    setQuery('')
    setExtras(chosen.filter((value) => !offered(value)))
    setOpen(true)
  }

  function search(next: string) {
    setQuery(next)
    // Back to the top of the list, where the matches are. The search sits
    // stuck to the top of the sheet's scrolling body, so its parent is it.
    searchRef.current
      ?.closest('[data-combobox-search]')
      ?.parentElement?.scrollTo({
        top: 0,
      })
  }

  /** A row tapped: the one choice, or one more (or fewer) of several. */
  function pick(value: string) {
    if (!choice.multiple) {
      choice.onChange(value)
      setOpen(false)
      return
    }
    if (!choice.value.includes(value)) {
      if (!full) choice.onChange([...choice.value, value])
      return
    }
    // Unticked, a value the list does not offer stays in it as a row, where
    // it was: `unlisted` already holds it, in the order on screen.
    if (!offered(value)) {
      setExtras((current) => (current.includes(value) ? current : unlisted))
    }
    choice.onChange(choice.value.filter((v) => v !== value))
  }

  /** Typed text taken as a choice: never unticks, only adds. */
  function take(value: string) {
    if (!choice.multiple) {
      pick(value)
      return
    }
    if (!choice.value.includes(value) && !full) {
      choice.onChange([...choice.value, value])
    }
    search('')
  }

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The aria-label names the field, which hides the chosen value from
        // a screen reader; describing the field by its own text says it back.
        aria-describedby={
          [
            currentLabel || emptyLabel ? valueId : null,
            invalid ? errorId : null,
          ]
            .filter(Boolean)
            .join(' ') || undefined
        }
        aria-invalid={invalid || undefined}
        onClick={openSheet}
        // Red while invalid even with focus on it: focus is moved here when
        // booking is refused, and a blue focus ring would hide the reason.
        className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-xl bg-surface-3 px-3.5 py-2.5 text-[16px] text-ink outline-none ${invalid ? 'ring-2 ring-red' : 'focus-visible:ring-2 focus-visible:ring-blue'}`}
      >
        {/* Whole, over two lines if it needs them: "30 Paterson Ro…" was
            not enough to tell which Paterson Road. */}
        {currentLabel ? (
          <span id={valueId} className="min-w-0 break-words text-left">
            {currentLabel}
          </span>
        ) : (
          <span id={valueId} className="min-w-0 text-left text-muted">
            {emptyLabel}
          </span>
        )}
        <ChevronsUpDown
          size={16}
          strokeWidth={2.2}
          className="shrink-0 text-muted"
        />
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={title ?? ariaLabel ?? ''}
        description={description}
        returnFocusRef={ownTrigger}
        initialFocusRef={searchRef}
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
        <div
          data-combobox-search
          className="sticky top-0 z-20 -mx-4 flex items-center gap-1 bg-canvas px-4 pb-2"
        >
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl bg-surface-3 px-3">
            <Search size={16} strokeWidth={2} className="shrink-0 text-muted" />
            {placeholder && <span className="sr-only">{placeholder}</span>}
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => search(e.target.value)}
              // The sheet is portalled outside any form, so Enter would
              // otherwise do nothing at all. It takes a row only when it is
              // plain which one was meant (see pickOnEnter).
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const picked = pickOnEnter(filtered, query, allowCustom)
                if (picked !== null) take(picked)
                // The phone's key says Done: with several rows still left,
                // put the keyboard away so they can be seen and tapped.
                else if (!window.matchMedia('(pointer: fine)').matches) {
                  e.currentTarget.blur()
                }
              }}
              // Surnames and suburbs are not dictionary words; a phone that
              // "corrects" one after the space empties the list.
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
              placeholder={placeholder}
              className="h-11 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none"
            />
          </label>
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                search('')
                searchRef.current?.focus()
              }}
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              <X size={16} strokeWidth={2.2} />
            </button>
          )}
        </div>

        {/* Always in the page, so a screen reader hears it when it fills. */}
        {choice.multiple && choice.max !== undefined && (
          <p
            role="status"
            className={`px-1 text-caption text-ink-2 ${full ? 'pb-2' : ''}`}
          >
            {full
              ? (choice.fullLabel ?? `That’s ${choice.max}, the most.`)
              : ''}
          </p>
        )}

        {sections.map((section, index) => (
          <section
            key={section.group ?? `rows-${index}`}
            className={index > 0 ? 'mt-4' : undefined}
          >
            {section.group && (
              <h3 className="section-label mb-1.5">{section.group}</h3>
            )}
            <ul className="flex flex-col gap-1.5">
              {section.rows.map((o) => {
                const on = chosen.includes(o.value)
                // Full: a row not ticked can't be, and looks it. Still
                // focusable and read out, so the reason can be found.
                const blocked = full && !on
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      // Ticked or not, for a checklist; for one choice, which
                      // one it is now.
                      role={choice.multiple ? 'checkbox' : undefined}
                      aria-checked={choice.multiple ? on : undefined}
                      aria-current={!choice.multiple && on ? 'true' : undefined}
                      aria-disabled={blocked || undefined}
                      onClick={() => pick(o.value)}
                      className={`flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                        blocked ? 'opacity-45' : 'active:scale-[.99]'
                      } ${
                        on
                          ? 'border-blue bg-blue/8'
                          : 'border-hairline bg-surface'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-body text-ink">
                          {o.label}
                        </span>
                        {o.detail && (
                          <span className="block text-caption text-muted">
                            {o.detail}
                          </span>
                        )}
                      </span>
                      {on && (
                        <Check
                          size={17}
                          strokeWidth={2.2}
                          className="shrink-0 text-blue"
                        />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}

        {filtered.length > shown.length && (
          <p className="px-1 py-2 text-caption text-muted">
            Showing {shown.length} of {filtered.length}. Keep typing to narrow
            it down.
          </p>
        )}

        {showCustomRow && (
          <button
            type="button"
            onClick={() => take(trimmedQuery)}
            className={`flex min-h-12 w-full items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-2.5 text-left text-body font-semibold text-blue transition active:scale-[.99] ${shown.length > 0 ? 'mt-1.5' : ''}`}
          >
            <Plus size={17} strokeWidth={2.2} className="shrink-0" />
            {customLabel?.(trimmedQuery) ?? `Add “${trimmedQuery}”`}
          </button>
        )}

        {filtered.length === 0 && !showCustomRow && (
          <p className="px-1 py-3 text-center text-caption text-grey-ink">
            {noMatchLabel}
          </p>
        )}
      </Sheet>
    </>
  )
}
