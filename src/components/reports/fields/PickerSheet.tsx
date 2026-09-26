import { useState } from 'react'
import { Check, Search } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import type { Option } from '#/lib/reportTemplates'
import {
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { FIELD_COMPACT } from '#/components/forms/FormField'
import { NoMatches } from '#/components/primitives/EmptyState'

/**
 * Choosing from a long list, on a phone, with gloves on.
 *
 * The Service Report's product list is thirteen entries of the form
 * "Stardust Pro (20 g/kg Permethrin 40:60, 5 g/kg Triflumuron)"; its methods
 * are ten. Rendered as a stack of checkbox rows, one treatment row alone came
 * to 42 of them and the technician scrolled past everything to reach the one
 * they use every day. So a long list opens here instead: search, 48px rows,
 * and what is already chosen kept at the top where it can be undone.
 *
 * Short lists are NOT routed here. Five weather words are quicker to tap in
 * place than behind a sheet, and a sheet over four options is ceremony.
 */

function OptionRow({
  option,
  on,
  locked,
  multiple,
  onPick,
}: {
  option: Option
  on: boolean
  /** Kept ticked by the form — the standard's own wording, not an answer. */
  locked: boolean
  multiple: boolean
  onPick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        role={multiple ? 'checkbox' : 'radio'}
        aria-checked={on}
        disabled={locked}
        onClick={onPick}
        className={`flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-60 ${
          on ? 'border-red bg-red/8' : 'border-hairline bg-surface'
        }`}
      >
        <span className="flex-1 text-body text-ink">{option.label}</span>
        {on && (
          <Check size={17} strokeWidth={2.2} className="shrink-0 text-red" />
        )}
      </button>
    </li>
  )
}

export function PickerSheet({
  open,
  onClose,
  title,
  options,
  selected,
  multiple,
  onToggle,
  onClear,
  disabledValues = [],
  usual = [],
  addLabel,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  title: string
  options: Array<Option>
  selected: Array<string>
  /** A checklist stays open as items are ticked; one choice closes on picking. */
  multiple: boolean
  onToggle: (value: string) => void
  /** Offered only where the answer can genuinely be none. */
  onClear?: () => void
  /** Items the form keeps ticked — the standard's own wording, not an answer. */
  disabledValues?: Array<string>
  /**
   * The handful this business reaches for, from its own option list. Shown
   * under a heading above the rest, because a picker that opens on the one
   * you want is a picker you barely notice.
   */
  usual?: Array<string>
  /** Wording for adding an item the form never anticipated. */
  addLabel?: string
  onAdd?: (value: string) => void
}) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')

  const needle = query.trim().toLowerCase()
  const matches = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options

  // What is already chosen, first: on a list this long, finding the thing you
  // ticked by mistake is otherwise its own scroll. Then the handful this
  // business reaches for, which is the difference between scrolling thirteen
  // products and tapping the one used on nine jobs in ten.
  const chosen = matches.filter((option) => selected.includes(option.value))
  const unchosen = matches.filter((option) => !selected.includes(option.value))
  const preferred = unchosen.filter((option) => usual.includes(option.value))
  const rest = unchosen.filter((option) => !usual.includes(option.value))

  function add() {
    const trimmed = draft.trim()
    if (!trimmed || !onAdd) return
    onAdd(trimmed)
    setDraft('')
    setQuery('')
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={multiple ? 'Tap to tick. Tap again to untick.' : undefined}
      footer={
        <div className="flex gap-2">
          {onClear && selected.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className={`${SECONDARY_BUTTON_COMPACT} px-4`}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={`${NEUTRAL_BUTTON_COMPACT} flex-1`}
          >
            Done
          </button>
        </div>
      }
    >
      <label className="flex h-11 items-center gap-2 rounded-xl bg-surface-2 px-3">
        <Search size={16} strokeWidth={2} className="shrink-0 text-muted" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          aria-label={`Search ${title}`}
          // 16px: anything smaller and iOS zooms the page on focus.
          className="w-full bg-transparent text-[16px] text-ink outline-none"
        />
      </label>

      {/* A heading only when there is something under it AND something below
          it to distinguish from — on a list where everything is usual, the
          word is noise. */}
      {preferred.length > 0 && rest.length > 0 && (
        <h3 className="section-label mt-3">Usually</h3>
      )}

      <ul className="mt-2 flex flex-col gap-1.5">
        {[...chosen, ...preferred].map((option) => (
          <OptionRow
            key={option.value}
            option={option}
            on={selected.includes(option.value)}
            locked={disabledValues.includes(option.value)}
            multiple={multiple}
            onPick={() => {
              onToggle(option.value)
              if (!multiple) onClose()
            }}
          />
        ))}
      </ul>

      {preferred.length > 0 && rest.length > 0 && (
        <h3 className="section-label mt-4">Everything else</h3>
      )}

      <ul className="mt-2 flex flex-col gap-1.5">
        {rest.map((option) => (
          <OptionRow
            key={option.value}
            option={option}
            on={selected.includes(option.value)}
            locked={disabledValues.includes(option.value)}
            multiple={multiple}
            onPick={() => {
              onToggle(option.value)
              if (!multiple) onClose()
            }}
          />
        ))}

        {matches.length === 0 && (
          <li>
            <NoMatches
              term={query}
              hint={onAdd ? 'Add it below.' : undefined}
              clearLabel="Clear search"
              onClear={() => setQuery('')}
            />
          </li>
        )}
      </ul>

      {onAdd && (
        <div className="mt-3 flex gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              }
            }}
            placeholder={addLabel ?? 'Add another…'}
            aria-label={`${title} — add another item`}
            className={`${FIELD_COMPACT} flex-1`}
          />
          <button
            type="button"
            onClick={add}
            className={`${SECONDARY_BUTTON_COMPACT} px-4`}
          >
            Add
          </button>
        </div>
      )}
    </Sheet>
  )
}

/**
 * The trigger a long list shows in the form: what is chosen, or the invitation
 * to choose. Reads as the answer, not as a control that hides one.
 */
export function PickerTrigger({
  label,
  values,
  placeholder,
  onOpen,
}: {
  label: string
  values: Array<string>
  placeholder: string
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      // Says the answer, not just the control: a screen reader reading the form
      // back should hear "Product & Active Ingredient — Fipforce HP", the same
      // thing the sighted technician sees.
      aria-label={
        values.length === 0
          ? `${label} — choose`
          : `${label} — ${values.join(', ')}`
      }
      className="flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-hairline bg-surface px-3 py-2.5 text-left transition active:scale-[.995]"
    >
      {values.length === 0 ? (
        <span className="text-body text-muted">{placeholder}</span>
      ) : (
        <span className="flex min-w-0 flex-col gap-0.5">
          {values.map((value) => (
            <span key={value} className="truncate text-body text-ink">
              {value}
            </span>
          ))}
        </span>
      )}
      <span className="shrink-0 text-caption font-semibold text-red">
        {values.length === 0 ? 'Choose' : 'Change'}
      </span>
    </button>
  )
}
