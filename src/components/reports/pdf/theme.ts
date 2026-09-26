/**
 * What the printed document is made of: one palette, one type scale, one set
 * of margins, shared by every piece of the PDF.
 *
 * The values come from the document the client actually received — the header
 * band, the section headings and the treatment table's header row are the
 * vendor's `#ff0000`, and the label column is tinted `#fff2f2`. The red here is
 * the app's own instead, because this is PestM8's document now and pure red is
 * neither what the app uses on screen nor what a laser printer flatters; the
 * tint is kept exactly, since it reads as the same page either way. That
 * choice is a layout decision, logged in `docs/reports/fidelity.md`, never a
 * wording one.
 */

export const COLOURS = {
  ink: '#1C1C1E',
  /** Body prose and secondary values. */
  ink2: '#3A3A3C',
  muted: '#8E8E93',
  // The screen's red-fill (styles.css), not the brand #FF3B30: the band and
  // the table header put white text on it, which the brand red holds at
  // 3.5:1 and this at 4.8:1, and the red headings on white paper gain the
  // same. Decided 2026-09-26 (design-survey 6.3).
  red: '#DC2A1F',
  /** The label column of every key/value table. */
  labelTint: '#FFF2F2',
  hairline: '#E5E5EA',
  rowRule: '#D8D8DC',
  green: '#34C759',
  // Warning text on white paper: the screen's amber-ink (styles.css), 5.5:1.
  // #B26B00 was 4.2:1.
  amber: '#985B00',
  white: '#FFFFFF',
} as const

export const SIZES = {
  /** A4 side margins. 40pt keeps a full street address on one line. */
  pageX: 40,
  pageTop: 30,
  /** Room for the three-line footer block, which is `fixed` and absolute. */
  pageBottom: 76,
  body: 9.5,
  caption: 8,
  heading: 15,
  subHeading: 10.5,
  band: 12.5,
  /** The width of a status bar beside an answer. */
  bar: 5,
} as const

/**
 * The label column's share of a key/value row, matching the source form's
 * 38/62 split — wide enough for "Risks that were present on or near the
 * treatment site." to sit on two lines rather than five.
 */
export const LABEL_WIDTH = '38%'
export const VALUE_WIDTH = '62%'

/** Helvetica is the only family here: see `fidelity.test.ts`'s WinAnsi check. */
export const FONT = { regular: 'Helvetica', bold: 'Helvetica-Bold' } as const
