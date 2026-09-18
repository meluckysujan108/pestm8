import { fieldsOf } from './index'
import type { RepeaterRow, ReportTemplate } from './types'

/**
 * When a treatment needs a follow-up the label insists on.
 *
 * Second-generation anticoagulant rodenticides were suspended by the APVMA on
 * 24 March 2026 with replacement label instructions, one of which is: do not
 * use the product continuously for more than 35 days without an evaluation.
 * The Service Report's own method list carries that instruction verbatim —
 * "SGARS in compliance with the new 35 day ruling" — which means a finished
 * report already knows when somebody has to go back.
 *
 * It says so and nothing more. Booking the visit is a decision with a price
 * and a person attached, and neither is anything this can guess.
 *
 * Careful with the words: this is a SUSPENSION with replacement label
 * instructions, never a "ban" and never "new legislation".
 */

/** The method option that carries the instruction. Matched on, not renamed. */
const SGAR_METHOD = 'SGARS in compliance with the new 35 day ruling'

const EVALUATION_DAYS = 35

export type SgarFollowUp = {
  /** The last day the label's evaluation can happen. */
  dueBy: number
  /** Days from now, negative once it is late. */
  daysRemaining: number
}

export function sgarFollowUp(
  template: ReportTemplate,
  data: Record<string, unknown>,
  treatedAt: number | undefined,
  now: number = Date.now(),
): SgarFollowUp | null {
  if (treatedAt === undefined) return null
  if (!usedSgar(template, data)) return null

  const dueBy = treatedAt + EVALUATION_DAYS * 24 * 60 * 60 * 1000
  return {
    dueBy,
    daysRemaining: Math.ceil((dueBy - now) / (24 * 60 * 60 * 1000)),
  }
}

function usedSgar(
  template: ReportTemplate,
  data: Record<string, unknown>,
): boolean {
  for (const field of fieldsOf(template)) {
    if (field.kind !== 'repeater') continue
    const rows = data[field.key]
    if (!Array.isArray(rows)) continue

    for (const row of rows as Array<RepeaterRow>) {
      for (const cell of field.columns) {
        const value = row[cell.key]
        const chosen = Array.isArray(value) ? value : [value]
        if (chosen.some((entry) => entry === SGAR_METHOD)) return true
      }
    }
  }
  return false
}
