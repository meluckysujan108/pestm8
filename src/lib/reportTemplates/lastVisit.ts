import { fieldsOf } from './index'
import type { PrefillMap } from './seed'
import type { RepeaterRow, ReportTemplate } from './types'

/**
 * The second visit to a site, and why it should not cost what the first did.
 *
 * A quarterly service is usually the same treatment, the same products and the
 * same recommendations as three months ago; an annual warranty inspection is
 * the same building it was last year. Re-entering all of that is the single
 * biggest tax on a return visit, and it is a tax the app can simply not
 * charge — it already holds the last report.
 *
 * What may be carried is the template's decision, not this file's: a field
 * says `carryOver` when its answer is about the PLACE rather than the DAY.
 * Everything copied arrives as a suggestion, so a technician sees it marked
 * and confirms it before it prints under their signature. Nothing is copied
 * over an answer they have already given.
 */

/** The keys a template says stay true between visits to the same site. */
export function carryOverKeys(template: ReportTemplate): Array<string> {
  return fieldsOf(template)
    .filter((field) => field.carryOver === true)
    .map((field) => field.key)
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Rows are copied with new ids.
 *
 * A repeater row's `_id` is how the builder keeps a focused input attached to
 * its own data, and how a cell edit finds its row. Two reports sharing one
 * would be two documents whose rows answer to the same name.
 */
function freshRows(rows: Array<RepeaterRow>): Array<RepeaterRow> {
  return rows.map((row) => ({ ...row, _id: crypto.randomUUID() }))
}

function asRows(value: unknown): Array<RepeaterRow> {
  return Array.isArray(value) ? (value as Array<RepeaterRow>) : []
}

/**
 * A repeater row counts as answered only when every cell of it is.
 *
 * The same rule `validateReport` applies — it refuses a half-filled row with
 * "Complete this row or delete it" — and it is the rule that makes carrying
 * treatments work at all. A service report started from a job arrives with one
 * row whose Treatment cell is ticked from the job type and whose product,
 * quantity and method are blank. Reading that as "the technician has answered
 * this" would withhold the three answers they most want.
 */
function rowComplete(row: RepeaterRow, columns: Array<string>): boolean {
  return columns.every((column) => !isEmpty(row[column]))
}

/**
 * Last visit's rows, filled into this report's without displacing anything.
 *
 * Blanks only, cell by cell: today's Treatment came off today's job and is a
 * fact, while last visit's is a guess about the same site — so the fact stays
 * and the guess fills the three cells beside it. Rows last visit had and this
 * one does not are appended only while nothing here is finished, because
 * adding a row to a table somebody is already filling in is a rearrangement,
 * not a head start.
 */
function mergeRows(
  previous: Array<RepeaterRow>,
  current: Array<RepeaterRow>,
  columns: Array<string>,
): Array<RepeaterRow> | null {
  const started = current.some((row) => rowComplete(row, columns))

  let changed = false
  const merged = current.map((row, index) => {
    // Rows this report has and last visit did not simply keep what they hold.
    if (index >= previous.length) return row
    const from = previous[index]
    const filled: RepeaterRow = { ...row }
    for (const column of columns) {
      if (isEmpty(filled[column]) && !isEmpty(from[column])) {
        filled[column] = from[column]
        changed = true
      }
    }
    return filled
  })

  const extra = started ? [] : freshRows(previous.slice(current.length))
  if (extra.length > 0) changed = true

  return changed ? [...merged, ...extra] : null
}

export type CarriedOver = {
  /** The answers to merge in, already excluding anything answered. */
  data: Record<string, unknown>
  /** Marked so each one shows as a suggestion until it is confirmed. */
  prefill: PrefillMap
  /** What the offer should say it will fill in, in the form's own words. */
  labels: Array<string>
}

export function carryOverFrom(
  template: ReportTemplate,
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): CarriedOver {
  const data: Record<string, unknown> = {}
  const prefill: PrefillMap = {}
  const labels: Array<string> = []

  for (const field of fieldsOf(template)) {
    if (field.carryOver !== true) continue
    const value = previous[field.key]
    // Blank last time is nothing to offer.
    if (isEmpty(value)) continue

    if (field.kind === 'repeater') {
      const merged = mergeRows(
        asRows(value),
        asRows(current[field.key]),
        field.columns.map((column) => column.key),
      )
      if (merged === null) continue
      data[field.key] = merged
    } else {
      // An answer already given this time is the technician's — a suggestion
      // never overwrites one.
      if (!isEmpty(current[field.key])) continue
      data[field.key] = value
    }

    prefill[field.key] = { source: 'lastVisit' }
    labels.push(field.label)
  }

  return { data, prefill, labels }
}
