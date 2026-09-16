import { isFlagged } from './choices'
import { isDataField } from './index'
import { present, isEmptyRow } from './present'
import { visibleSections } from './visibility'
import type { PresentContext } from './present'
import type { FieldDef, RepeaterRow, ReportTemplate } from './types'

/**
 * The few answers worth reading back before a report is locked.
 *
 * Not "every answer" — that is the document, and the technician has just
 * filled it in. This is the handful they would check: what was done, whether
 * it was safe, when the next visit is due. Which ones those are is the
 * template's decision (`summary: true`), not this file's, because the three
 * forms summarise to different things and a business's own form summarises to
 * something else again.
 *
 * Pure, and free of React, so the finalise sheet and its tests can both read
 * it, and so a future "In this report" line on the library row can too.
 */

export type SummaryLine = {
  /** Unique within the list — a repeater contributes one line per column. */
  key: string
  label: string
  text: string
  /** `warn` when the answer is the one that means a problem was found. */
  tone: 'default' | 'warn'
}

export function reportSummary(
  template: ReportTemplate,
  data: Record<string, unknown>,
  context?: PresentContext | null,
): Array<SummaryLine> {
  const lines: Array<SummaryLine> = []

  for (const section of visibleSections(template.sections ?? [], data)) {
    for (const field of section.fields) {
      if (!isDataField(field)) continue
      // A repeater is never summarised whole — four columns times four rows is
      // the table itself. Its columns opt in individually.
      if (field.kind === 'repeater') {
        lines.push(...repeaterLines(field, data[field.key], context))
        continue
      }
      if (!field.summary) continue
      const line = lineFor(field, data[field.key], context)
      if (line) lines.push(line)
    }
  }

  return lines
}

function lineFor(
  field: FieldDef,
  value: unknown,
  context?: PresentContext | null,
  keyPrefix = '',
): SummaryLine | null {
  const shown = present(field, value, context ?? undefined)
  // Anything that is not one line of text belongs on the document, not in a
  // summary: an unanswered question, a signature image, a clause of prose.
  if (shown.kind !== 'text' || shown.text === '') return null
  return {
    key: `${keyPrefix}${field.key}`,
    label: field.label.replace(/:$/, ''),
    text: shown.text,
    tone: isFlagged(field, value) ? 'warn' : 'default',
  }
}

/**
 * One line per column that asked for it, listing what appears in that column
 * across every filled row — "Treatment: Chemical soil barrier, Rodent bait" —
 * rather than repeating a four-cell row per treatment.
 */
function repeaterLines(
  field: Extract<FieldDef, { kind: 'repeater' }>,
  value: unknown,
  context?: PresentContext | null,
): Array<SummaryLine> {
  const summarised = field.columns.filter((cell) => cell.summary)
  if (summarised.length === 0 || !Array.isArray(value)) return []

  const rows = (value as Array<RepeaterRow>).filter((row) => !isEmptyRow(field.columns, row))

  return summarised.flatMap((cell) => {
    const seen: Array<string> = []
    for (const row of rows) {
      const line = lineFor(cell, row[cell.key], context)
      // Two rows of the same treatment read as one: the summary answers "what
      // was applied here", not "how many rows were added".
      if (line && !seen.includes(line.text)) seen.push(line.text)
    }
    if (seen.length === 0) return []
    return [
      {
        key: `${field.key}.${cell.key}`,
        label: cell.label.replace(/:$/, ''),
        text: seen.join(', '),
        // A cell's flag is about one row; the joined line cannot carry it.
        tone: 'default' as const,
      },
    ]
  })
}
