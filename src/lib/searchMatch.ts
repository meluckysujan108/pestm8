/**
 * Lower-cases, strips accents and turns punctuation that separates words
 * ("Nguyen, Bayswater", "Smith—Morley", "(08) 9271", "+61 412", "0412-345",
 * "3/12") into spaces, so what someone types and what is stored are compared
 * on the letters and digits alone.
 */
export function normaliseForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[,;()—–+\-./]/g, ' ')
}

/**
 * True when EVERY word of the query appears somewhere in the text, in any
 * order. "nguyen bayswater" finds "J. Nguyen — 12 Wattle Street, Bayswater",
 * which a single substring test over the whole query never could: the office
 * types the name the caller gives and the suburb they add, not the label's
 * exact wording.
 */
export function matchesAllWords(text: string, query: string): boolean {
  const words = normaliseForSearch(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = normaliseForSearch(text)
  return words.every((word) => haystack.includes(word))
}

type Searchable = { value: string; label: string; searchText?: string }

/** The options a searchable picker shows for what has been typed. */
export function filterByWords<T extends Searchable>(
  options: ReadonlyArray<T>,
  query: string,
): Array<T> {
  return options.filter((o) => matchesAllWords(o.searchText ?? o.label, query))
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * The matches with the ones whose label STARTS with what was typed first,
 * each group keeping the order it came in. Typing "ha" puts Harbourside
 * Strata above "Josh Ha…" and "12 Harvey St": the name someone is typing
 * is usually the name they want.
 */
export function startsFirst<T extends Searchable>(
  rows: ReadonlyArray<T>,
  query: string,
): Array<T> {
  const typed = collapse(normaliseForSearch(query))
  if (!typed) return [...rows]
  const starts: Array<T> = []
  const rest: Array<T> = []
  for (const row of rows) {
    const label = collapse(normaliseForSearch(row.label))
    ;(label.startsWith(typed) ? starts : rest).push(row)
  }
  return [...starts, ...rest]
}

/**
 * What Enter in a picker's search box chooses, or null to choose nothing.
 *
 * Only ever something the person can see is the one they meant: the row
 * whose label is exactly what they typed, the only row left, or — where
 * free text is allowed and nothing matches — the text itself. Several rows,
 * or a partial match sitting beside an "Add …" row, is a guess, and Enter
 * does not guess. Nor does it pick anything before a word is typed, which
 * would put back the default this picker exists to remove.
 */
export function pickOnEnter(
  filtered: ReadonlyArray<Searchable>,
  query: string,
  allowCustom: boolean,
): string | null {
  const typed = query.trim()
  if (!typed) return null
  const exact = filtered.find(
    (o) => o.label.toLowerCase() === typed.toLowerCase(),
  )
  if (exact) return exact.value
  if (allowCustom) return filtered.length === 0 ? typed : null
  return filtered.length === 1 ? filtered[0].value : null
}
