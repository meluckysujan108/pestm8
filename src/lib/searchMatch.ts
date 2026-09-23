/**
 * Lower-cases, strips accents and turns punctuation that separates words
 * ("Nguyen, Bayswater", "Smith—Morley", "(08) 9271") into spaces, so what
 * someone types and what is stored are compared on the letters alone.
 */
export function normaliseForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[,;()—–]/g, ' ')
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
