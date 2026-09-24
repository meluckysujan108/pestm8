/**
 * A real PDF, with as many pages as a spec needs and words on each one.
 *
 * The in-app viewer is judged on things only a real document has: a page
 * count for "N pages" and "3 of 12", text for search to find (and a phrase
 * that sits on one page and not the other, so "1 of 1" means something), and
 * an em dash, because a search that cannot match what a safety data sheet
 * actually prints — "Section 4 — First aid measures" — is not finished.
 *
 * No PDF library is a devDependency, and none is needed: a text-only PDF is a
 * catalog, a page tree, one page and one content stream per page, and a font
 * every reader already has (Helvetica is one of the standard 14, so nothing is
 * embedded). What makes a hand-written one *valid* rather than merely
 * something pdf.js is lenient about is the cross-reference table: every
 * object's byte offset, ten digits, twenty bytes a line. Those are counted
 * from the bytes as they are built, never typed in.
 *
 * Text is encoded as WinAnsi (Windows-1252), the single-byte encoding the
 * standard fonts use, so every character is one byte and the offsets are
 * plain string lengths. A character WinAnsi cannot print throws here rather
 * than turning into a box in someone's screenshot.
 */

/** What each page says by default: sections of a safety data sheet. */
export const SAMPLE_PDF_SECTIONS = [
  'First aid measures',
  'Personal protective equipment',
  'Fire-fighting measures',
  'Handling and storage',
  'Accidental release measures',
  'Toxicological information',
  'Disposal considerations',
  'Transport information',
] as const

/** The heading on page `n` (1-based) of the default document. */
export function samplePdfHeading(n: number): string {
  return `Page ${n} — ${SAMPLE_PDF_SECTIONS[(n - 1) % SAMPLE_PDF_SECTIONS.length]}`
}

/**
 * The default body under each heading. Page 1's second line is the one phrase
 * that appears nowhere else, for a search spec that wants exactly one match.
 */
function defaultLines(n: number): string[] {
  const lines = [samplePdfHeading(n)]
  if (n === 1) lines.push('If swallowed, rinse mouth. Do NOT induce vomiting.')
  lines.push(`Product reference sheet, page ${n}.`)
  return lines
}

/**
 * Windows-1252 bytes for the characters outside Latin-1 that a safety data
 * sheet is likely to print. Latin-1 itself (0xA0–0xFF) maps to the same byte.
 */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '™': 0x99,
}

/** A PDF string literal for `text`, WinAnsi-encoded and escaped. */
function pdfString(text: string): string {
  let out = '('
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '(' || ch === ')' || ch === '\\') {
      out += `\\${ch}`
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch
    } else {
      const byte = WIN_ANSI[ch] ?? (code >= 0xa0 && code <= 0xff ? code : -1)
      if (byte < 0) {
        throw new Error(`samplePdf: "${ch}" has no WinAnsi encoding`)
      }
      // Octal escapes keep the file itself ASCII, so string length is bytes.
      out += `\\${byte.toString(8).padStart(3, '0')}`
    }
  }
  return `${out})`
}

export type SamplePdfOptions = {
  /** How many pages. Defaults to 2. */
  pages?: number
  /** The lines of text on page `n` (1-based), top to bottom. */
  lines?: (n: number) => string[]
  /** Page size in points. Defaults to A4 portrait (595 × 842). */
  width?: number
  height?: number
}

/**
 * Builds the PDF. Deterministic — no dates, no IDs — so the same options give
 * the same bytes, and a spec can compare what it uploaded with what it gets
 * back.
 */
export function samplePdf(options: SamplePdfOptions = {}): Buffer {
  const { pages = 2, lines = defaultLines, width = 595, height = 842 } = options
  if (!Number.isInteger(pages) || pages < 1) {
    throw new Error('samplePdf: pages must be a whole number, at least 1')
  }

  // Object numbers: 1 catalog, 2 page tree, 3 font, then a page and its
  // content stream for each page.
  const pageObj = (i: number) => 4 + i * 2
  const contentObj = (i: number) => 5 + i * 2
  const objects: string[] = []

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  const kids = Array.from({ length: pages }, (_, i) => `${pageObj(i)} 0 R`)
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`
  objects[3] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  for (let i = 0; i < pages; i++) {
    const text = lines(i + 1)
    // The heading at 20pt, the rest at 12pt, from 72pt below the top edge.
    const ops = ['BT', '/F1 20 Tf', `72 ${height - 96} Td`]
    text.forEach((line, n) => {
      if (n === 1) ops.push('/F1 12 Tf', '0 -32 Td')
      else if (n > 1) ops.push('0 -18 Td')
      ops.push(`${pdfString(line)} Tj`)
    })
    ops.push('ET')
    const stream = ops.join('\n')

    objects[pageObj(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`
    objects[contentObj(i)] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }

  // The second line's high bytes tell transfer tools this is binary, as the
  // spec recommends; they are the only non-ASCII bytes in the file.
  let body = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'
  const offsets: number[] = []
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = body.length
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`
  }

  const xrefAt = body.length
  const size = objects.length
  // Each entry is exactly 20 bytes: 10-digit offset, 5-digit generation, a
  // keyword, and a two-byte end of line (space + newline).
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let n = 1; n < size; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`

  // Latin-1, so each of the four marker characters above is the one byte it
  // stands for and every offset counted in UTF-16 units is a byte offset.
  return Buffer.from(body + xref + trailer, 'latin1')
}
