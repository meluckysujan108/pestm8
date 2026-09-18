import { isFilled } from './visibility'
import type { FieldDef } from './types'

/**
 * Answering a whole group at once, when the answer is "nothing found".
 *
 * A twelve-month warranty inspection where nothing is wrong is the common
 * case, and it should not cost twelve identical taps: the Timber form's
 * conducive conditions and the Service Report's safety checklist are both
 * groups where one honest tap can say what twelve would.
 *
 * Three rules keep it honest:
 *
 * - It is always an explicit tap, never a stored default. An unanswered
 *   question and one answered "No" are different claims, and only the
 *   technician may make the second.
 * - It never overwrites an answer already given.
 * - It never answers "Is it safe to commence work?". That question is the
 *   form's one mandatory gate, and an app that answers it has defeated it.
 */

export type QuickMode = 'allYes' | 'allClear'

export function quickAnswersFor(
  fields: Array<FieldDef>,
  mode: QuickMode,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  for (const field of fields) {
    if (field.semantic === 'safetyGate') continue
    if (isFilled(data[field.key])) continue

    const answer = mode === 'allYes' ? affirmative(field) : unflagged(field)
    if (answer !== undefined) patch[field.key] = answer
  }

  return patch
}

/** "Yes" for the safety checklist's toggles — nothing else is a yes/no claim. */
function affirmative(field: FieldDef): unknown {
  return field.kind === 'toggle' ? true : undefined
}

/**
 * The answer that means "no problem here", read from the field's own flags.
 *
 * Derived rather than listed, because the forms disagree about which word is
 * the clear one: drainage is clear at "Adequate", a slab edge at "Yes", water
 * leaks at "No". What they share is that the template already says which
 * answers mean a problem was found.
 */
function unflagged(field: FieldDef): unknown {
  switch (field.kind) {
    case 'toggle':
      // Only where the form says which way is the problem: a plain yes/no with
      // no flag attached is a question this cannot answer for anyone.
      return field.flaggedValue === undefined ? undefined : !field.flaggedValue
    case 'radio':
    case 'select': {
      const flagged = field.flaggedValues ?? []
      if (flagged.length === 0) return undefined
      // The first option the form does not flag, in the form's own order —
      // which is how these lists are written: the good answer comes first.
      return field.options.find((option) => !flagged.includes(option.value))
        ?.value
    }
    default:
      return undefined
  }
}

/**
 * How many questions a quick answer would actually settle, so a button can say
 * so — and can be hidden once there is nothing left for it to do.
 */
export function quickAnswerCount(
  fields: Array<FieldDef>,
  mode: QuickMode,
  data: Record<string, unknown>,
): number {
  return Object.keys(quickAnswersFor(fields, mode, data)).length
}
