import type { ImportSheet } from './types'

/**
 * "Download rows that won't import": the file's own rows, as they came,
 * for the person to fix in their spreadsheet and import again. Same
 * headings, so the second import matches its columns the same way.
 */

/**
 * A cell as a spreadsheet opens it safely. One starting = + - or @ is run
 * as a formula by Excel — a client list is exactly where someone could
 * plant one — so it gets a ' in front, which Excel shows as text and
 * hides. A leading tab or carriage return is the same trick. One that
 * already has a ' (or more) before one of those gets another, as importing
 * the file again takes exactly one off (read.ts `importCell`).
 */
function safeCell(value: string): string {
  const guarded = /^'*[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

function csvLine(cells: Array<string>): string {
  return cells.map(safeCell).join(',')
}

/**
 * The heading row and the given rows (1 = the first data row), in the
 * file's order, as CSV (RFC 4180). With `reasons`, a last column says why
 * each row wasn't imported.
 */
export function rowsCsv(
  sheet: ImportSheet,
  rowNumbers: Array<number>,
  reasons?: ReadonlyMap<number, string>,
): string {
  const wanted = [...new Set(rowNumbers)]
    .filter((n) => n >= 1 && n <= sheet.rows.length)
    .sort((a, b) => a - b)
  const headers = reasons
    ? [...sheet.headers, "Why it wasn't imported"]
    : sheet.headers
  const lines = [csvLine(headers)]
  for (const n of wanted) {
    const row = sheet.rows[n - 1]
    lines.push(csvLine(reasons ? [...row, reasons.get(n) ?? ''] : row))
  }
  return `${lines.join('\r\n')}\r\n`
}

/**
 * Hands the person a text file. A CSV starts with a byte-order mark: without
 * one, Excel on Windows opens UTF-8 as Windows-1252, and "Café" comes back
 * as "CafÃ©".
 */
export function downloadText(fileName: string, text: string): void {
  const csv = /\.csv$/i.test(fileName)
  const blob = new Blob([csv ? `\uFEFF${text}` : text], {
    type: csv ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked later, not now: Safari starts the download after click()
  // returns, and a revoked URL gives it nothing.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
