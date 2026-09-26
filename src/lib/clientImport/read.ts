import Papa from 'papaparse'
import { MAX_IMPORT_ROWS } from '../../../convex/lib/clientImport'
import { isKnownHeading } from './columns'
import type { ImportSheet } from './types'

/**
 * Reading a client list off the person's own computer: a CSV (or the tab- or
 * semicolon-separated text Excel also saves) or an Excel workbook, into
 * plain rows of text. Nothing here knows what a column means — that is
 * columns.ts — and nothing leaves the browser.
 *
 * Most of what goes wrong with these files is Excel's doing, not the old
 * app's: it saves CSVs in Windows-1252 unless asked not to, "Unicode Text"
 * in UTF-16, turns a mobile into 412345678 and an ABN into 5.18248E+10, and
 * a European-set laptop separates with semicolons. This file undoes what can
 * be undone; build.ts flags what cannot.
 */

/** A file the page can't read, with the sentence that says why. */
export class ImportFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportFileError'
  }
}

/** Big enough for 2,000 clients with long notes; small enough that parsing
 * it doesn't lock up a phone. */
const MAX_FILE_BYTES = 5 * 1024 * 1024

const TEXT_TYPES = new Set(['csv', 'txt', 'tsv'])

/** For a file with no extension to go by — dragged out of a mail app, say
 * — what its type says it is. */
const TEXT_MIME = new Set([
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
])
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const count = (n: number) => n.toLocaleString('en-AU')

export async function readImportFile(file: File): Promise<ImportSheet> {
  const name = file.name
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''

  if (extension === 'xls') {
    throw new ImportFileError(
      `“${name}” is an older Excel file (.xls). Open it in Excel, save it as .xlsx or CSV, and choose that instead.`,
    )
  }
  if (extension === 'numbers') {
    throw new ImportFileError(
      `“${name}” is a Numbers file. In Numbers, use File › Export To › CSV, and choose that instead.`,
    )
  }
  const excel = extension === 'xlsx' || (!extension && file.type === XLSX_MIME)
  const text =
    TEXT_TYPES.has(extension) || (!extension && TEXT_MIME.has(file.type))
  if (!excel && !text) {
    throw new ImportFileError(
      `PestM8 reads CSV and Excel (.xlsx) files, and “${name}” isn't one. Export your clients as CSV and choose that instead.`,
    )
  }
  if (file.size > MAX_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    throw new ImportFileError(
      `“${name}” is ${mb} MB; PestM8 takes files up to 5 MB — split it and import each part.`,
    )
  }

  const raw = excel ? await readExcel(file) : await readText(file)
  return toSheet(name, raw)
}

// ---------------------------------------------------------------- text

/** Windows-1252's own characters at 0x80–0x9F, which ISO-8859-1 has as
 * control codes. Browsers decode them right; Node's decoder (and so the
 * tests) reads the label as ISO-8859-1, and a curly quote goes missing. */
const CP1252_HIGH =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
  '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178'

/**
 * The bytes as text. UTF-8 when they are valid UTF-8, which is what every
 * app exports; Windows-1252 when they are not, which is what Excel on
 * Windows writes when "CSV (Comma delimited)" is picked over "CSV UTF-8" —
 * one "Café" or curly quote in a note and a strict UTF-8 read throws.
 * UTF-16 is Excel's "Unicode Text", and says so with its byte-order mark.
 */
function decodeText(bytes: Uint8Array): string {
  let text: string
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(bytes)
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(bytes)
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      text = new TextDecoder('windows-1252')
        .decode(bytes)
        .replace(
          /[\u0080-\u009f]/g,
          (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80],
        )
    }
  }
  return text.replace(/^\uFEFF/, '')
}

async function readText(file: File): Promise<Array<Array<string>>> {
  let text = decodeText(new Uint8Array(await file.arrayBuffer()))

  // Excel reads, and some exports write, a first line naming the separator.
  // Excel doesn't show it as a row, so it isn't counted as one.
  let delimiter: string | undefined
  const hint = /^sep=(.)\r?\n/i.exec(text)
  if (hint) {
    delimiter = hint[1]
    text = text.slice(hint[0].length)
  }

  // Papa guesses the separator (, ; tab |) from the first rows when not
  // told, passing over blank ones. The file is then read with its blank
  // rows kept, so that row i is the file's row i + 1 as a spreadsheet counts
  // them — a quoted cell across lines is one row — and toSheet drops them.
  delimiter ??= Papa.parse(text, { preview: 1, skipEmptyLines: 'greedy' }).meta
    .delimiter
  const parsed = Papa.parse<Array<string>>(text, { delimiter })
  // A quote mark that opens a cell and never closes it, or closes it
  // part-way through ("Beware" of dog), makes Papa read on to the next
  // quote that does end a cell — the rows in between vanish into one note.
  // What would be read is not the file, so it's refused. Excel, Sheets and
  // Numbers never write either. Anything else Papa reports (a row short of
  // cells) is padded out below.
  const broken = parsed.errors.find(
    (e) => e.code === 'MissingQuotes' || e.code === 'InvalidQuotes',
  )
  if (broken) {
    // Papa counts rows as a spreadsheet does, blank ones included.
    const row = broken.row === undefined ? '' : ` ${broken.row + 1}`
    throw new ImportFileError(
      `Row${row} of the file has a quote mark (") that doesn't open or close a cell properly, so the rows after it can't be read. Fix that row and try again.`,
    )
  }
  return parsed.data
}

// ---------------------------------------------------------------- Excel

async function readExcel(file: File): Promise<Array<Array<unknown>>> {
  // Loaded only when a workbook is chosen: most files are CSVs, and the
  // reader is the bulk of this page's code. It fills the gaps between the
  // rows it finds with empty ones, from row 1, so row i is sheet row i + 1.
  const { readSheet } = await import('read-excel-file/browser')
  try {
    return await readSheet(file)
  } catch {
    throw new ImportFileError(
      `Could not read “${file.name}” as an Excel workbook. If it has a password, remove it; otherwise save it again as .xlsx or CSV and try again.`,
    )
  }
}

/**
 * One Excel cell as the text a person sees in it.
 *
 * Numbers are the trap: Excel stores a mobile typed without its quote as
 * 412345678 and an ABN as 51824753556, and JavaScript would happily write
 * the bigger ones as 5.1824753556e+10 or with grouping. Whole numbers come
 * out as plain digits; build.ts puts back a lost leading 0. Dates are the
 * Australian way round, and read in UTC because that is how the reader
 * builds them from Excel's day count.
 */
export function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'string') return cell
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  if (typeof cell === 'number') return numberToText(cell)
  if (typeof cell === 'bigint') return cell.toString()
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return ''
    const dd = String(cell.getUTCDate()).padStart(2, '0')
    const mm = String(cell.getUTCMonth() + 1).padStart(2, '0')
    return `${dd}/${mm}/${cell.getUTCFullYear()}`
  }
  return String(cell)
}

function numberToText(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (Number.isInteger(n)) {
    // Past 1e21 even toString() switches to an exponent.
    return Math.abs(n) >= 1e21 ? BigInt(n).toString() : n.toFixed(0)
  }
  // 15 significant digits is all a spreadsheet keeps, and drops the float
  // noise (0.30000000000000004) that would otherwise show.
  return String(Number(n.toPrecision(15)))
}

// ---------------------------------------------------------------- shape

function isBlankRow(row: Array<string>): boolean {
  return row.every((cell) => cell === '')
}

/** How many of a row's cells have something in them. */
function filledCount(row: Array<string>): number {
  return row.reduce((n, cell) => (cell === '' ? n : n + 1), 0)
}

/** The index of a row's last cell with something in it; -1 for none. */
function lastFilled(row: Array<string>): number {
  for (let i = row.length - 1; i >= 0; i--) if (row[i] !== '') return i
  return -1
}

function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return `Column ${name}`
}

/**
 * One cell as the text to import, trimmed.
 *
 * "Download rows that won't import" (skipped.ts) puts a ' in front of a
 * cell starting = + - @ tab or return, so a spreadsheet shows it as text
 * rather than running it. That file is made to be fixed and brought back
 * here, so the ' comes off again: exactly one, and only in front of those
 * characters — every +61 mobile and "- dog in yard" note would otherwise
 * come back with it. A cell that already had ' in front of them was given
 * one more, so one comes off that too.
 */
function importCell(cell: unknown): string {
  return cellToText(cell)
    .replace(/^'(?='*[=+\-@\t\r])/, '')
    .trim()
}

/** How far down the headings are looked for. */
const HEADING_SEARCH_ROWS = 10

/** How many of a row's cells are headings the Match step knows. */
function knownCount(row: Array<string>): number {
  return row.reduce((n, cell) => (isKnownHeading(cell) ? n + 1 : n), 0)
}

/**
 * Which row is the headings. Usually the first, but a sheet kept by hand
 * often has a title above them ("Client list 2024", merged across the top,
 * perhaps with a date out to the side), or a band of grouped headings
 * ("Client", "Address") over the real ones.
 *
 * The first row is the headings unless nothing in it is a heading the
 * Match step knows (isKnownHeading) and it fills fewer cells than the
 * fullest row near the top. Then:
 *  - the first row near the top that is mostly headings the Match step
 *    knows is the headings — a title over headings that cover only some of
 *    the columns ("Name", "Address" over five), or a title of two cells
 *    over a sheet only three wide;
 *  - failing that, a first row filling fewer than half as many cells as
 *    the fullest (or just one) is a title, and the headings are the first
 *    row under it that fills at least half as many.
 * A first row with a known heading, or as full as any, is the headings as
 * it stands: a sheet's own headings ("Cust", "Addr") may know none, and a
 * client's details can hold two ("Business", "Email") — searching further
 * down for known words would lose that client into the headings.
 *
 * When the headings are a band over the real ones, the row straight under
 * is taken instead (see isBand).
 */
function headingRow(rows: Array<Array<string>>): number {
  const top = rows.slice(0, HEADING_SEARCH_ROWS)
  const known = top.map(knownCount)
  const filled = top.map(filledCount)
  // Ten rows at most, so spreading them is fine.
  const fullest = Math.max(...filled)
  const narrowTop = known[0] === 0 && filled[0] < fullest
  const mostlyKnown = narrowTop
    ? known.findIndex((k, i) => k >= 2 && k * 2 >= filled[i])
    : -1
  const title = narrowTop && (filled[0] <= 1 || filled[0] * 2 < fullest)
  let at =
    mostlyKnown !== -1
      ? mostlyKnown
      : title
        ? filled.findIndex((n, i) => i > 0 && n * 2 >= fullest)
        : 0
  while (at + 1 < top.length && isBand(at, known, filled)) at++
  return at
}

/**
 * Whether heading row `at` is a band of grouped headings over the real
 * ones in the row under it. A band is headings the Match step knows (two
 * or more, as band fill in toSheet takes them), merged across the columns
 * it groups: the row under knows more headings and fills more cells, and
 * at least half its cells are headings the Match step knows — which a
 * client's row seldom is, whatever "Business" or "Email" it holds. Only a
 * band of known headings is stepped over: under one of the sheet's own
 * ("Cust", or "Name" over unheaded columns) is the first client.
 */
function isBand(
  at: number,
  known: Array<number>,
  filled: Array<number>,
): boolean {
  const below = at + 1
  return (
    known[at] >= 2 &&
    known[below] > known[at] &&
    filled[below] > filled[at] &&
    known[below] * 2 >= filled[below]
  )
}

/**
 * Rows of cells as a sheet: the headings (see headingRow) with anything
 * above them dropped, every blank row gone, and every row exactly as wide
 * as the last column with something in it — a heading or a cell. Each row
 * that's left keeps the number a spreadsheet shows beside it, counting
 * what was dropped: raw row i is row i + 1.
 *
 * The one exception is the "{}" MYOB puts on the first line of its exports,
 * which is passed over rather than taken as the headings.
 */
function toSheet(fileName: string, raw: Array<Array<unknown>>): ImportSheet {
  const rows: Array<Array<string>> = []
  const numbers: Array<number> = []
  raw.forEach((cells, i) => {
    const row = cells.map(importCell)
    if (isBlankRow(row)) return
    rows.push(row)
    numbers.push(i + 1)
  })

  if (rows.length > 1 && rows[0].filter(Boolean).join('') === '{}') {
    rows.shift()
    numbers.shift()
  }
  if (rows.length === 0) throw new ImportFileError(`“${fileName}” is empty.`)

  const at = headingRow(rows)
  const first = rows[at]
  const body = rows.slice(at + 1)
  const sourceRows = numbers.slice(at + 1)
  // Under a band of grouped headings, a heading merged down across both
  // rows ("Name", beside "Street" and "Suburb" under "Address") is in the
  // band's row only, so a heading left blank takes the band's cell above.
  const band = at > 0 && knownCount(rows[at - 1]) >= 2 ? rows[at - 1] : []

  // Trailing empty cells are Excel's formatting reaching past the data,
  // not columns. A column with data but no heading is still a column: its
  // heading is named for it, as a blank one in the middle is. (A loop, not
  // Math.max(...): a 5 MB file can have more rows than a call takes
  // arguments.)
  let last = lastFilled(first)
  for (const row of body) last = Math.max(last, lastFilled(row))
  const width = last + 1
  const headers = Array.from(
    { length: width },
    (_, i) =>
      (first[i] || band[i] || '').replace(/\s+/g, ' ').trim() || columnName(i),
  )
  const data = body.map((row) =>
    Array.from({ length: width }, (_, i) => row[i] ?? ''),
  )

  if (data.length === 0) {
    throw new ImportFileError(
      `“${fileName}” has headings but no rows under them.`,
    )
  }
  if (data.length > MAX_IMPORT_ROWS) {
    throw new ImportFileError(
      `“${fileName}” has ${count(data.length)} rows; PestM8 takes up to ${count(MAX_IMPORT_ROWS)} at a time — split it and import each part.`,
    )
  }
  return { fileName, headers, rows: data, sourceRows }
}
