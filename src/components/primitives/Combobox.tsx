import {
  useCallback,
  useDeferredValue,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode, Ref } from 'react'
import { Check, ChevronsUpDown, Plus, Search, X } from 'lucide-react'
import {
  decideDetails,
  joinDetails,
  orderedMatches,
  pickOnEnter,
} from '#/lib/searchMatch'
import { usePickerList } from '#/lib/usePickerList'
import { NEUTRAL_BUTTON_COMPACT } from './buttons'
import { Sheet } from './Sheet'

export type ComboboxOption = {
  value: string
  label: string
  /** What the search matches against, when it should be more than the
   * label — a phone number or postcode nobody wants to read in the list. */
  searchText?: string
  /** `searchText` (or the label) and the label as the search compares
   * them, worked out once when the options are built (`withSearchKeys` in
   * lib/searchMatch.ts), so a long list is not normalised on every key. */
  searchKey?: string
  labelKey?: string
  /** A second, quieter line under the label in the list ("Added Tue 29
   * Sept"). Never on the closed field, and never matched or picked by. */
  detail?: string
  /** The heading this option is listed under while nothing is typed
   * ("Added recently"). Options come grouped, in the order given; once
   * something is typed the list is one list, best match first. */
  group?: string
}

/** A row that does something other than choose: "New client, phone
 * “0412 345 678”", "New site for Jane Nguyen". The sheet closes, then
 * `onSelect` runs, and focus goes where it puts it rather than back to the
 * field. */
export type ComboboxAction = {
  label: string
  onSelect: () => void
  /** A line under it, its own element, so it can decide its words once as
   * it shows: "Newer clients show when you have signal." */
  hint?: ReactNode
}

/** What the caller knows about a query beyond the words in each row: a
 * phone number's or an email's holders, from the match index. */
export type ComboboxLookup = {
  /** Option values to list first, in this order, whether or not their
   * words match. */
  first: ReadonlyArray<string>
  /** A row to end the list with. */
  end?: ComboboxAction | null
}

/** Opens the list from outside, with a query typed: "Show them" in a match
 * row. The keyboard stays down, as for any open: the search takes focus
 * only on a computer, or when tapped. */
export type ComboboxHandle = {
  openWith: (query: string) => void
}

/**
 * Past this many matches the list asks for more typing instead of rendering
 * every row: a phone sheet with a few thousand buttons in it is slow to open
 * and useless to scroll.
 */
const MAX_ROWS = 100

const NO_DETAILS: ReadonlyMap<string, string | undefined> = new Map()

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
 * (property — a job must reference a real property) shows `noMatchLabel`,
 * and under it `noMatchAction`'s row where the caller offers one: the way in
 * to a new client, with what was typed in the field it fills.
 *
 * Every word typed must match, in any order, so "nguyen bayswater" finds the
 * row whose label reads "J. Nguyen — 12 Wattle Street, Bayswater". A caller
 * that knows more about a query (`lookup`: a phone number's holders, from
 * the match index) puts rows first that the words alone would miss, and may
 * end the list with a row of its own.
 *
 * The list follows the query a moment behind (`useDeferredValue`), so typing
 * into a book of ten thousand sites never waits on the list; and it is only
 * filtered while the sheet is open, then kept as it was while the sheet
 * slides away (`usePickerList`).
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
  noMatchAction,
  lookup,
  detailOf,
  handleRef,
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
  /** The row under `noMatchLabel` when a typed query matches nothing, or
   * null for none. */
  noMatchAction?: (query: string) => ComboboxAction | null
  /** Rows a query brings first, and a row to end with (`ComboboxLookup`). */
  lookup?: (query: string) => ComboboxLookup | null
  /** A line about a row worked out as it first shows, rather than baked
   * into the options ("Booked Thu 30 Oct"), and kept while the sheet is
   * open (`decideDetails`): a push that changes it never grows a row under
   * a thumb. It goes before the option's own `detail`, joined with " · ". */
  detailOf?: (value: string) => string | undefined
  /** `openWith`, for opening the list with a query typed. */
  handleRef?: Ref<ComboboxHandle>
  ariaLabel?: string
  /** Marks the field invalid and ties it to the message that says why. */
  invalid?: boolean
  errorId?: string
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** Counts the times the sheet has opened. */
  const [opening, setOpening] = useState(0)
  // What the list shows follows the query a moment behind: the field takes
  // each key at once, and the list catches up between them. A query held
  // over from an earlier opening is never shown, not even for a frame: the
  // list opens on what this opening was given.
  const typed = useMemo(() => ({ query, opening }), [query, opening])
  const behind = useDeferredValue(typed)
  const listQuery = behind.opening === opening ? behind.query : query
  /**
   * Values the list does not offer — a job type typed in once — that have
   * been chosen since the sheet opened. Kept as rows until it closes, so
   * unticking one does not pull it out from under the finger.
   */
  const [extras, setExtras] = useState<Array<string>>([])
  /** Each shown row's `detailOf` line, as it was when the row first showed
   * since the sheet opened. */
  const [details, setDetails] = useState(NO_DETAILS)
  const ownTrigger = useRef<HTMLButtonElement>(null)
  /** Where focus goes when the sheet shuts: the field, unless an action row
   * has put it somewhere of its own. */
  const returnTo = useRef<HTMLButtonElement>(null)
  // The field is also the caller's, to move focus to when booking is refused.
  const setTrigger = useCallback(
    (node: HTMLButtonElement | null) => {
      ownTrigger.current = node
      returnTo.current = node
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
  const unlistedKey = unlisted.join('\n')
  const rows = useMemo<ReadonlyArray<ComboboxOption>>(
    () =>
      unlistedKey === ''
        ? options
        : [
            ...options,
            ...unlistedKey
              .split('\n')
              .map((value) => ({ value, label: value })),
          ],
    [options, unlistedKey],
  )
  // Typed: one list, the lookup's rows first, then names starting with the
  // text (searchMatch.ts). Not typed: the caller's order, under its
  // headings. Closed: what it last showed, kept while the sheet slides away
  // (`usePickerList`).
  const list = usePickerList({
    open,
    rows,
    query: listQuery,
    lookup,
    allowCustom,
  })
  const { found, ordered } = list
  const searching = list.query.trim() !== ''
  const shown = ordered.slice(0, MAX_ROWS)
  const sections: Array<{ group?: string; rows: Array<ComboboxOption> }> = []
  for (const row of shown) {
    const group = searching ? undefined : row.group
    const last = sections.at(-1)
    if (last && last.group === group) last.rows.push(row)
    else sections.push({ group, rows: [row] })
  }

  // Each row's line from `detailOf`, decided as it first shows and kept.
  const decided =
    open && detailOf
      ? decideDetails(
          details,
          shown.map((row) => row.value),
          detailOf,
        )
      : details
  if (decided !== details) setDetails(decided)

  const trimmedQuery = list.query.trim()
  const showCustomRow =
    allowCustom && trimmedQuery.length > 0 && !list.hasExactMatch
  const endRow = found?.end ?? null
  const nothing = ordered.length === 0 && !showCustomRow && endRow === null
  const shownQuery = list.query
  const action = useMemo(
    () => (nothing && searching ? (noMatchAction?.(shownQuery) ?? null) : null),
    [nothing, searching, noMatchAction, shownQuery],
  )

  /** Opens the sheet with `initial` in the search, its rows' lines decided
   * afresh. */
  function openSheet(initial = '') {
    setQuery(initial)
    setOpening((n) => n + 1)
    setExtras(chosen.filter((value) => !offered(value)))
    setDetails(NO_DETAILS)
    returnTo.current = ownTrigger.current
    setOpen(true)
  }

  useImperativeHandle(handleRef, () => ({ openWith: openSheet }))

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

  /** An action row tapped: the sheet shuts, and the action puts focus
   * where it is going (the field it filled), not back on this field. */
  function act(chosenAction: ComboboxAction) {
    returnTo.current = null
    setOpen(false)
    chosenAction.onSelect()
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
        onClick={() => openSheet()}
        // Red while invalid even with focus on it: focus is moved here when
        // booking is refused, and a blue focus ring would hide the reason.
        className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-xl border border-field-edge bg-surface-3 px-3.5 py-2.5 text-[16px] text-ink outline-none ${invalid ? 'ring-2 ring-red' : 'focus-visible:ring-2 focus-visible:ring-blue'}`}
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
        returnFocusRef={returnTo}
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
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-field-edge bg-surface-3 px-3">
            <Search size={16} strokeWidth={2} className="shrink-0 text-muted" />
            {placeholder && <span className="sr-only">{placeholder}</span>}
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => search(e.target.value)}
              // The sheet is portalled outside any form, so Enter would
              // otherwise do nothing at all. It takes a row only when it is
              // plain which one was meant (see pickOnEnter), for what is
              // typed now, not for a list a key behind.
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const now = orderedMatches(
                  rows,
                  query,
                  query.trim() === '' ? undefined : lookup?.(query)?.first,
                )
                const picked = pickOnEnter(now, query, allowCustom)
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
                const detail = joinDetails(decided.get(o.value), o.detail)
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
                        {detail && (
                          <span className="block text-caption text-muted">
                            {detail}
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

        {ordered.length > shown.length && (
          <p className="px-1 py-2 text-caption text-muted">
            Showing {shown.length} of {ordered.length}. Keep typing to narrow it
            down.
          </p>
        )}

        {endRow && (
          <ActionRow
            action={endRow}
            onSelect={act}
            className={shown.length > 0 ? 'mt-1.5' : undefined}
          />
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

        {nothing && (
          <p
            className={`px-1 text-center text-caption text-grey-ink ${action ? 'pt-3 pb-2' : 'py-3'}`}
          >
            {noMatchLabel}
          </p>
        )}
        {action && <ActionRow action={action} onSelect={act} />}
      </Sheet>
    </>
  )
}

/** A row that does something rather than choose (`ComboboxAction`), drawn as
 * the "Add …" row is, with its hint under it. */
function ActionRow({
  action,
  onSelect,
  className,
}: {
  action: ComboboxAction
  onSelect: (action: ComboboxAction) => void
  className?: string
}) {
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => onSelect(action)}
        className="flex min-h-12 w-full items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-2.5 text-left text-body font-semibold text-blue transition active:scale-[.99]"
      >
        <Plus size={17} strokeWidth={2.2} className="shrink-0" />
        <span className="min-w-0 break-words">{action.label}</span>
      </button>
      {action.hint}
    </div>
  )
}
