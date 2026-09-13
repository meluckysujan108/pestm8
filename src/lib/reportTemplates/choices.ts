import type { FieldDef } from './types'

/**
 * The rules a fixed answer list carries beyond its options: items that are
 * always ticked, items that rule out the rest, and answers that mean a problem
 * was found.
 *
 * Pure and shared, so the control that edits a checklist, the painters that
 * print it and the validator that checks it cannot disagree about what a
 * locked or an exclusive item means.
 */

type ChecksField = Extract<FieldDef, { kind: 'checks' }>

/**
 * A checklist's stored answers with its locked items guaranteed present, in
 * option order first and anything added at fill time after.
 *
 * Printing goes through here rather than trusting the stored array: a draft
 * saved before an item was locked, or one written by an older client, must
 * still print "12 Monthly Timber Pest Visual Inspection to maintain Warranty"
 * on a warranty inspection, because that line is what the document is.
 */
export function withLocked(field: ChecksField, value: unknown): Array<string> {
  const stored = Array.isArray(value) ? value.map(String) : []
  const locked = field.locked ?? []
  if (locked.length === 0) return stored
  const merged = new Set([...locked, ...stored])
  const ordered = field.options
    .map((option) => option.value)
    .filter((v) => merged.has(v))
  const extra = [...merged].filter((v) => !ordered.includes(v))
  return [...ordered, ...extra]
}

/**
 * The checklist after tapping one item.
 *
 * A locked item cannot be unticked. An exclusive item clears everything else
 * when ticked, and ticking anything else clears it — "No Risk Safe Access
 * Given" ticked alongside "Dogs" is a document contradicting itself. Locked
 * items survive both, since they were never the technician's to clear.
 */
export function toggleCheck(
  field: ChecksField,
  current: unknown,
  item: string,
): Array<string> {
  const locked = new Set(field.locked ?? [])
  const exclusive = new Set(field.exclusive ?? [])
  const selected = withLocked(field, current)

  if (selected.includes(item)) {
    if (locked.has(item)) return selected
    return selected.filter((v) => v !== item)
  }

  if (exclusive.has(item)) {
    return [...selected.filter((v) => locked.has(v)), item]
  }
  return [...selected.filter((v) => !exclusive.has(v)), item]
}

/**
 * The options to offer, plus any stored answer the list no longer contains.
 *
 * A business can rename or drop a product after a draft chose it. A control
 * that only renders the current list shows that draft as unanswered — "Choose…"
 * — while the answer is still stored and would print on the signed document.
 * The technician must see what the form will say.
 */
export function retainedOptions(
  options: Array<{ value: string; label: string }>,
  value: unknown,
): Array<{ value: string; label: string }> {
  const stored = (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === 'string' && v !== '',
  )
  const known = new Set(options.map((o) => o.value))
  const extra = stored
    .filter((v) => !known.has(v))
    .map((v) => ({ value: v, label: v }))
  return extra.length === 0 ? options : [...options, ...extra]
}

/** Does this answer mean a problem was found? */
export function isFlagged(field: FieldDef, value: unknown): boolean {
  switch (field.kind) {
    case 'toggle':
      return (
        field.flaggedValue !== undefined &&
        typeof value === 'boolean' &&
        value === field.flaggedValue
      )
    case 'select':
    case 'radio':
      return (
        value !== undefined &&
        value !== null &&
        (field.flaggedValues ?? []).includes(String(value))
      )
    case 'chips':
    case 'checks': {
      const flagged = field.flaggedValues ?? []
      return Array.isArray(value) && value.some((v) => flagged.includes(String(v)))
    }
    default:
      return false
  }
}

/**
 * Whether a field or block belongs on the FINISHED document. The builder always
 * shows everything — guidance and form-only controls are for the person filling
 * the form in.
 *
 * A `whenFlagged` field whose question is missing from the template prints: a
 * broken reference must not silently delete advice from a signed document.
 */
export function fieldPrints(
  field: FieldDef,
  fields: Array<FieldDef>,
  data: Record<string, unknown>,
): boolean {
  if (field.printed === false) return false
  if (field.printed !== 'whenFlagged') return true
  const target = fields.find((candidate) => candidate.key === field.attachedTo)
  if (!target) return true
  return isFlagged(target, data[target.key])
}
