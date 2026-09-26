import Papa from 'papaparse'
import { MAX_IMPORT_ROWS } from '../../../convex/lib/clientImport'
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
  let delimiter: string | undefined
  const hint = /^sep=(.)\r?\n/i.exec(text)
  if (hint) {
    delimiter = hint[1]
    text = text.slice(hint[0].length)
  }

  // Papa guesses the separator (, ; tab |) from the first rows when not told.
  const parsed = Papa.parse<Array<string>>(text, {
    skipEmptyLines: 'greedy',
    ...(delimiter ? { delimiter } : {}),
  })
  // An opening quote never closed swallows every row after it into one
  // cell, so what would be read is not the file. Anything else Papa reports
  // (a row short of cells) is padded out below.
  const unclosed = parsed.errors.find((e) => e.code === 'MissingQuotes')
  if (unclosed) {
    const row = unclosed.row === undefined ? '' : ` ${unclosed.row + 1}`
    throw new ImportFileError(
      `Row${row} of the file opens a quote mark (") that never closes, so the rows after it can't be read. Fix that row and try again.`,
    )
  }
  return parsed.data
}

// ---------------------------------------------------------------- Excel

async function readExcel(file: File): Promise<Array<Array<unknown>>> {
  // Loaded only when a workbook is chosen: most files are CSVs, and the
  // reader is the bulk of this page's code.
  const { readSheet } = await import('read-excel-file/browser')
  try {
    return await readSheet(file)
  } catch {
    throw new ImportFileError(
      `Couldn't read “${file.name}” as an Excel workbook. If it has a password, remove it; otherwise save it again as .xlsx or CSV and try again.`,
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

function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return `Column ${name}`
}

/**
 * Rows of cells as a sheet: the first row with something in it is the
 * headings, every blank row is gone, and every row is exactly as wide as the
 * headings.
 *
 * The one exception is the "{}" MYOB puts on the first line of its exports,
 * which is passed over rather than taken as the headings.
 */
function toSheet(fileName: string, raw: Array<Array<unknown>>): ImportSheet {
  const rows = raw
    .map((row) => row.map((cell) => cellToText(cell).trim()))
    .filter((row) => !isBlankRow(row))

  if (rows.length > 1 && rows[0].filter(Boolean).join('') === '{}') {
    rows.shift()
  }

  const first = rows.shift()
  if (!first) throw new ImportFileError(`“${fileName}” is empty.`)

  // Trailing empty headings are Excel's formatting reaching past the data,
  // not columns.
  let width = first.length
  while (width > 0 && first[width - 1] === '') width--
  const headers = first
    .slice(0, width)
    .map((h, i) => h.replace(/\s+/g, ' ').trim() || columnName(i))

  const data = rows
    .map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''))
    // Cut to the headings' width, a row whose only cells were past them is
    // blank now.
    .filter((row) => !isBlankRow(row))

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
  return { fileName, headers, rows: data }
}
