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
    // Blank last time is nothing to offer, and an answer already given this
    // time is the technician's — a suggestion never overwrites one.
    if (isEmpty(value) || !isEmpty(current[field.key])) continue

    data[field.key] =
      field.kind === 'repeater' ? freshRows(value as Array<RepeaterRow>) : value
    prefill[field.key] = { source: 'lastVisit' }
    labels.push(field.label)
  }

  return { data, prefill, labels }
}
