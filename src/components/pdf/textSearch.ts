/**
 * Finding words in a PDF's text, and where on the page they are.
 *
 * pdf.js hands back a page's text as "items" — runs of characters with a
 * position — split wherever the PDF's author's software felt like it: a font
 * change, a kerning adjustment, the end of a line, sometimes mid-word. A
 * technician searching a safety data sheet for "first aid" should find it
 * whether it was typed that way, printed as "First  Aid" with two spaces,
 * broken across a line, or split into "Fir" + "st aid" by the PDF writer.
 *
 * So a page's items are joined into one string and folded for matching —
 * lower case, runs of whitespace as one space, accents dropped (so "cafe"
 * finds "Café"), curly quotes and dashes as their plain forms (so "don't"
 * finds "don’t", and "section 4 - first aid" finds the em dash), ligatures
 * spelled out — while remembering, for every folded character, which item and
 * which character in it it came from. A match is found in the folded string
 * and mapped back through that, which is what lets it span items and still be
 * highlighted in the right place.
 *
 * Pure and DOM-free: no pdf.js here, only the shapes it returns.
 */

/** The parts of a pdf.js `TextItem` that matching needs. */
export type TextItemLike = { str: string; hasEOL?: boolean }

/** Characters `from` to `to` (exclusive) of item `item`'s `str`. */
export type ItemRange = { item: number; from: number; to: number }

export type TextMatch = { ranges: ItemRange[] }

export type PageTextIndex = {
  /** The page's text, folded. */
  text: string
  /** For each UTF-16 unit of `text`: the item it came from, or -1 for a
      space standing in for a line break between items. */
  item: Int32Array
  /** …and the offset in that item's `str` of the character it came from. */
  offset: Int32Array
  /** …and that character's length in `str` (2 for a surrogate pair). */
  length: Uint8Array
  /** Whether the page has any text at all. A scan has none. */
  hasText: boolean
}

const SINGLE_QUOTES = new Set(['‘', '’', '‚', '‛', '′', '`', '´'])
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟', '″'])
const DASHES = new Set(['‐', '‑', '‒', '–', '—', '―', '−'])
// Soft hyphen, zero-width space/joiners, word joiner, byte-order mark.
const INVISIBLE = new Set([
  '\u00ad',
  '\u200b',
  '\u200c',
  '\u200d',
  '\u2060',
  '\ufeff',
])
const MARKS = /\p{M}/gu
const SPACE = /\s/

const foldCache = new Map<string, string>()

/** One character, folded. Can come out empty (a soft hyphen) or longer ("ﬁ"). */
function foldChar(ch: string): string {
  const cached = foldCache.get(ch)
  if (cached !== undefined) return cached
  let folded: string
  if (SPACE.test(ch)) folded = ' '
  else if (INVISIBLE.has(ch)) folded = ''
  else if (SINGLE_QUOTES.has(ch)) folded = "'"
  else if (DOUBLE_QUOTES.has(ch)) folded = '"'
  else if (DASHES.has(ch)) folded = '-'
  else {
    // NFKD splits "é" into "e" + a combining accent and "ﬁ" into "fi";
    // lower-casing before dropping the marks turns "İ" into a plain "i".
    folded = ch.normalize('NFKD').toLowerCase().replace(MARKS, '')
    if (SPACE.test(folded)) folded = ' '
  }
  if (foldCache.size < 4096) foldCache.set(ch, folded)
  return folded
}

/** Folds a search as typed: the same rules, trimmed, spaces collapsed. */
export function foldQuery(query: string): string {
  let out = ''
  for (const ch of query) {
    const folded = foldChar(ch)
    if (folded === ' ' && (out === '' || out.endsWith(' '))) continue
    out += folded
  }
  return out.trimEnd()
}

export function indexPageText(items: TextItemLike[]): PageTextIndex {
  const units: string[] = []
  const item: number[] = []
  const offset: number[] = []
  const length: number[] = []
  let hasText = false
  let lastWasSpace = true

  const emit = (unit: string, i: number, at: number, len: number) => {
    const space = unit === ' '
    if (space && lastWasSpace) return
    units.push(unit)
    item.push(i)
    offset.push(at)
    length.push(len)
    lastWasSpace = space
  }

  items.forEach(({ str, hasEOL }, i) => {
    let at = 0
    while (at < str.length) {
      const code = str.codePointAt(at) ?? 0
      const len = code > 0xffff ? 2 : 1
      const folded = foldChar(str.slice(at, at + len))
      // By UTF-16 unit, not code point: `text` is searched with indexOf, so
      // the maps must have one entry per unit or everything after an emoji
      // is off by one.
      for (const unit of folded.split('')) {
        if (unit !== ' ') hasText = true
        emit(unit, i, at, len)
      }
      at += len
    }
    // The end of a line is a word break even when the PDF put no space there.
    if (hasEOL) emit(' ', -1, 0, 0)
  })

  return {
    text: units.join(''),
    item: Int32Array.from(item),
    offset: Int32Array.from(offset),
    length: Uint8Array.from(length),
    hasText,
  }
}

/**
 * Every place `query` occurs on the page, in reading order, not overlapping,
 * each as the item ranges it covers.
 */
export function findInPage(
  index: PageTextIndex,
  items: TextItemLike[],
  query: string,
): TextMatch[] {
  const needle = foldQuery(query)
  if (!needle) return []
  const matches: TextMatch[] = []
  let from = 0
  for (;;) {
    const start = index.text.indexOf(needle, from)
    if (start < 0) break
    const end = start + needle.length
    const ranges = rangesFor(index, items, start, end)
    if (ranges.length > 0) matches.push({ ranges })
    from = end
  }
  return matches
}

/** Folded positions [start, end) back to the item ranges they came from. */
function rangesFor(
  index: PageTextIndex,
  items: TextItemLike[],
  start: number,
  end: number,
): ItemRange[] {
  // Skip line-break spaces at either end; they belong to no item.
  let first = start
  while (first < end && index.item[first] < 0) first++
  let last = end - 1
  while (last >= first && index.item[last] < 0) last--
  if (last < first) return []

  const fromItem = index.item[first]
  const fromOffset = index.offset[first]
  const toItem = index.item[last]
  const toOffset = index.offset[last] + index.length[last]

  if (fromItem === toItem) {
    return [{ item: fromItem, from: fromOffset, to: toOffset }]
  }
  const ranges: ItemRange[] = [
    { item: fromItem, from: fromOffset, to: items[fromItem].str.length },
  ]
  for (let i = fromItem + 1; i < toItem; i++) {
    const length = items[i].str.length
    if (length > 0) ranges.push({ item: i, from: 0, to: length })
  }
  ranges.push({ item: toItem, from: 0, to: toOffset })
  return ranges
}

/** A rectangle on a page, as fractions of the page's width and height. */
export type PageRect = { x: number; y: number; w: number; h: number }

/** The parts of a pdf.js `TextItem` that placing a highlight needs. */
export type TextGeometry = {
  str: string
  /** Text space to PDF user space, as pdf.js reports it. */
  transform: number[]
  /** Advance width in user space. */
  width: number
  /** Advance height in user space (the width, for vertical text). */
  height: number
}

/** A page's viewport at scale 1: user space to CSS pixels, y down. */
export type ViewportLike = {
  transform: number[]
  width: number
  height: number
}

/**
 * How far along `str` its first `n` characters reach, as a fraction of the
 * whole, by measured width — or null when there is nothing usable to measure
 * with, so the caller counts characters instead. A measurer that throws (no
 * canvas) or answers nonsense is treated the same as none.
 */
function shareOf(
  str: string,
  measure: ((text: string) => number) | undefined,
): ((n: number) => number) | null {
  if (!measure) return null
  try {
    const total = measure(str)
    if (!(total > 0) || !Number.isFinite(total)) return null
    return (n) => {
      try {
        const part = measure(str.slice(0, n))
        return Number.isFinite(part)
          ? Math.min(1, Math.max(0, part / total))
          : n / Math.max(1, str.length)
      } catch {
        return n / Math.max(1, str.length)
      }
    }
  } catch {
    return null
  }
}

function multiply(m: number[], n: number[]): number[] {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/**
 * Where characters `from`–`to` of a text item are drawn, as a fraction of the
 * page — for a highlight laid over the rendered canvas.
 *
 * The same geometry pdf.js's own text layer uses: the item's transform
 * through the viewport gives its baseline origin, direction and font size;
 * the box runs from the ascent above the baseline to the descent below it.
 * pdf.js knows only the whole item's width, not each glyph's, so part of an
 * item is placed by its share of the item's MEASURED width when the caller
 * can measure text in the item's font (`measure`) — which is also how pdf.js's
 * own text layer fits a run — and by its share of the characters otherwise.
 * Counting characters drifts on a run that mixes narrow and wide glyphs
 * ("Page 1 — First aid measures" put the highlight half a letter right);
 * measuring puts it over the word.
 */
export function rangeRect(
  item: TextGeometry,
  from: number,
  to: number,
  viewport: ViewportLike,
  options: {
    ascent?: number
    vertical?: boolean
    /** Width of `text` in the item's font, in any unit. */
    measure?: (text: string) => number
  } = {},
): PageRect {
  const tx = multiply(viewport.transform, item.transform)
  let angle = Math.atan2(tx[1], tx[0])
  if (options.vertical) angle += Math.PI / 2
  const fontHeight = Math.hypot(tx[2], tx[3])
  const ascentRatio =
    options.ascent && options.ascent > 0 && options.ascent < 1.5
      ? options.ascent
      : 0.8
  const ascent = fontHeight * ascentRatio

  // Viewport scale 1 is CSS pixels per point, so the advance scales by it too.
  const scale = Math.hypot(viewport.transform[0], viewport.transform[1]) || 1
  const advance = (options.vertical ? item.height : item.width) * scale
  const length = Math.max(1, item.str.length)
  const start = Math.max(0, from)
  const end = Math.min(length, to)
  const share = shareOf(item.str, options.measure)
  const x0 = advance * (share?.(start) ?? start / length)
  const x1 = advance * (share?.(end) ?? end / length)

  // The box's top-left sits `ascent` above the baseline origin, in the
  // direction perpendicular to the text.
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  const originX = tx[4] + ascent * sin
  const originY = tx[5] - ascent * cos
  const corners = [
    [x0, 0],
    [x1, 0],
    [x0, fontHeight],
    [x1, fontHeight],
  ].map(([u, v]) => [originX + u * cos - v * sin, originY + u * sin + v * cos])

  const xs = corners.map(([x]) => x)
  const ys = corners.map(([, y]) => y)
  const left = Math.max(0, Math.min(...xs))
  const top = Math.max(0, Math.min(...ys))
  const right = Math.min(viewport.width, Math.max(...xs))
  const bottom = Math.min(viewport.height, Math.max(...ys))
  return {
    x: left / viewport.width,
    y: top / viewport.height,
    w: Math.max(0, right - left) / viewport.width,
    h: Math.max(0, bottom - top) / viewport.height,
  }
}
