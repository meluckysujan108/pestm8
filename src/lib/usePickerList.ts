import { useMemo, useState } from 'react'
import { orderedMatches } from '#/lib/searchMatch'
import type {
  ComboboxLookup,
  ComboboxOption,
} from '#/components/primitives/Combobox'

/** What a picker's list shows (`Combobox`), worked out for one query. */
export type PickerList = {
  /** The query it was worked out for: the one the list shows. */
  query: string
  /** What the caller's lookup knew about it (a number's holders). */
  found: ComboboxLookup | null
  /** Every row the query lists, in order (`orderedMatches`). */
  ordered: ReadonlyArray<ComboboxOption>
  /** Whether a row's label is exactly the query, for a list that takes
   * typed values: then there is no "Add …" row. */
  hasExactMatch: boolean
}

const NOTHING_SHOWN: PickerList = {
  query: '',
  found: null,
  ordered: [],
  hasExactMatch: false,
}

/**
 * A picker's list for the query it shows. Worked out only while the sheet is
 * open, so a closed picker over ten thousand sites costs nothing as pushes
 * come in; once it closes, the list it last showed is kept.
 *
 * Kept, not emptied, because a picker's sheet stays in the page for the half
 * second it slides away (`Sheet`). Worked out afresh there, the list was
 * empty: a sheet closed by a pick collapsed to its search and Done as it
 * left, and one taking typed values showed an "Add …" row, still tappable,
 * that it never had while open. Opened again, it is worked out afresh.
 */
export function usePickerList({
  open,
  rows,
  query,
  lookup,
  allowCustom,
}: {
  open: boolean
  rows: ReadonlyArray<ComboboxOption>
  /** What the list follows: the query a moment behind the field. */
  query: string
  lookup?: (query: string) => ComboboxLookup | null
  allowCustom: boolean
}): PickerList {
  const live = useMemo((): PickerList | null => {
    if (!open) return null
    const typed = query.trim()
    const found = typed === '' ? null : (lookup?.(query) ?? null)
    return {
      query,
      found,
      ordered: orderedMatches(rows, query, found?.first),
      hasExactMatch:
        allowCustom &&
        typed !== '' &&
        rows.some((o) => o.label.toLowerCase() === typed.toLowerCase()),
    }
  }, [open, rows, query, lookup, allowCustom])
  const [kept, setKept] = useState<PickerList>(NOTHING_SHOWN)
  if (live !== null && live !== kept) setKept(live)
  return live ?? kept
}
