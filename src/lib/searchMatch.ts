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

/** The words of a query, normalised: once per query, not once per row. */
export function queryWords(query: string): Array<string> {
  return normaliseForSearch(query).split(/\s+/).filter(Boolean)
}

/**
 * True when EVERY word of the query appears somewhere in the text, in any
 * order. "nguyen bayswater" finds "J. Nguyen — 12 Wattle Street, Bayswater",
 * which a single substring test over the whole query never could: the office
 * types the name the caller gives and the suburb they add, not the label's
 * exact wording.
 */
export function matchesAllWords(text: string, query: string): boolean {
  const words = queryWords(query)
  if (words.length === 0) return true
  const haystack = normaliseForSearch(text)
  return words.every((word) => haystack.includes(word))
}

/**
 * A row a picker searches. `searchKey` and `labelKey` are what the search
 * reads, normalised once when the options are built (`withSearchKeys`): a
 * list of ten thousand sites is not normalised again on every keystroke.
 * A row built without them (a job type, a teammate: short lists) is
 * normalised as it is searched.
 */
type Searchable = {
  value: string
  label: string
  searchText?: string
  searchKey?: string
  labelKey?: string
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

/** What the search finds a row by, normalised. */
export function searchKeyOf(row: Searchable): string {
  return row.searchKey ?? normaliseForSearch(row.searchText ?? row.label)
}

/** The row's label as `startsFirst` compares it. */
export function labelKeyOf(row: Searchable): string {
  return row.labelKey ?? collapse(normaliseForSearch(row.label))
}

/**
 * A row with its search keys worked out now, for an options builder to call
 * once per row per build. `searchText` is folded into `searchKey` and not
 * kept: it is only ever searched.
 */
export function withSearchKeys<T extends Searchable>(
  row: T,
): Omit<T, 'searchText'> & { searchKey: string; labelKey: string } {
  const { searchText, ...rest } = row
  return {
    ...rest,
    searchKey: normaliseForSearch(searchText ?? row.label),
    labelKey: collapse(normaliseForSearch(row.label)),
  }
}

/** The options a searchable picker shows for what has been typed. */
export function filterByWords<T extends Searchable>(
  options: ReadonlyArray<T>,
  query: string,
): Array<T> {
  const words = queryWords(query)
  if (words.length === 0) return [...options]
  return options.filter((o) => {
    const key = searchKeyOf(o)
    return words.every((word) => key.includes(word))
  })
}

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
    ;(labelKeyOf(row).startsWith(typed) ? starts : rest).push(row)
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

/**
 * The rows a query lists, in order: the rows a lookup put first (a phone
 * number's holders' sites, from the match index), in the order given and
 * whether or not their words match, then every other row whose words do,
 * labels starting with the text first. Nothing typed: every row, in the
 * order given.
 */
export function orderedMatches<T extends Searchable>(
  rows: ReadonlyArray<T>,
  query: string,
  first: ReadonlyArray<string> = [],
): Array<T> {
  const matched = filterByWords(rows, query)
  if (query.trim() === '') return matched
  const ordered = startsFirst(matched, query)
  if (first.length === 0) return ordered
  const byValue = new Map(rows.map((row) => [row.value, row]))
  const lead: Array<T> = []
  const put = new Set<string>()
  for (const value of first) {
    const row = byValue.get(value)
    if (row && !put.has(value)) {
      lead.push(row)
      put.add(value)
    }
  }
  return [...lead, ...ordered.filter((row) => !put.has(row.value))]
}

/**
 * The extra line of each row shown (`Combobox`'s `detailOf`: "Booked Thu 30
 * Oct"), decided as the row first shows and kept while the list is open, so
 * a push that changes what is booked never grows or shrinks a row under a
 * thumb. The same map back when every row shown is decided already, so a
 * render can set it unconditionally.
 */
export function decideDetails(
  decided: ReadonlyMap<string, string | undefined>,
  shown: ReadonlyArray<string>,
  detailOf: (value: string) => string | undefined,
): ReadonlyMap<string, string | undefined> {
  const missing = shown.filter((value) => !decided.has(value))
  if (missing.length === 0) return decided
  const next = new Map(decided)
  for (const value of missing) next.set(value, detailOf(value) || undefined)
  return next
}

/** A row's two quieter lines as one: the decided one first, "Booked Thu 30
 * Oct · Added Tue 29 Sept". */
export function joinDetails(
  decided: string | undefined,
  own: string | undefined,
): string | undefined {
  return [decided, own].filter(Boolean).join(' · ') || undefined
}
