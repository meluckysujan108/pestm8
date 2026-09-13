import { isDataField } from './types'
import type { FieldDef, SectionDef } from './types'

/**
 * Conditional visibility, as data rather than a predicate function.
 *
 * Five things need to ask "is this showing?": the builder, the on-screen
 * document, the PDF, validation, and — once PDF generation moves server-side —
 * Convex. A closure crosses none of those boundaries; it cannot be stored,
 * inspected, or evaluated anywhere but the module that declared it.
 *
 * Kept deliberately small and total: no arithmetic, no string operations,
 * nothing that can throw on a half-filled draft. Every conditional in the real
 * AS 4349.3 and AS 3660.2 forms is "show this when that toggle is yes", which
 * `eq` alone covers; the rest exist so a template never has to reach for an
 * escape hatch.
 */

export type Scalar = string | number | boolean

export type Condition =
  | { when: string; eq: Scalar }
  | { when: string; oneOf: Array<Scalar> }
  /** For chips and other multi-select values: the array contains this. */
  | { when: string; includes: Scalar }
  /** Answered at all — a non-empty string or a non-empty array. */
  | { when: string; filled: true }
  | { all: Array<Condition> }
  | { any: Array<Condition> }
  | { not: Condition }

/** Exported for `deriveSchema.ts`'s generic required-field validation. */
export function isFilled(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function isVisible(
  condition: Condition | undefined,
  data: Record<string, unknown>,
): boolean {
  if (!condition) return true

  if ('all' in condition) {
    return condition.all.every((c) => isVisible(c, data))
  }
  if ('any' in condition) {
    return condition.any.some((c) => isVisible(c, data))
  }
  if ('not' in condition) {
    return !isVisible(condition.not, data)
  }

  const value = data[condition.when]

  if ('eq' in condition) return value === condition.eq
  if ('oneOf' in condition) {
    return condition.oneOf.some((option) => option === value)
  }
  if ('includes' in condition) {
    return Array.isArray(value) && value.includes(condition.includes)
  }
  return isFilled(value)
}

/** The sections currently on screen, each narrowed to its visible fields. */
export function visibleSections(
  sections: Array<SectionDef>,
  data: Record<string, unknown>,
): Array<SectionDef> {
  return sections
    .filter((section) => isVisible(section.visibleWhen, data))
    .map((section) => ({
      ...section,
      fields: section.fields.filter((field) =>
        isVisible(field.visibleWhen, data),
      ),
    }))
    // A section whose every field is hidden has nothing to show. One left
    // holding only a note or a heading DOES survive: a legal preamble that
    // always prints is exactly the kind of content static blocks exist for,
    // and dropping it because it happens to ask no questions would delete it
    // from the document with nothing failing.
    .filter((section) => section.fields.length > 0)
}

/**
 * Drops answers to questions that are no longer being asked.
 *
 * Without this, answering "yes" then changing it to "no" leaves the follow-up
 * text stored and printed on the finished report — a statement the technician
 * retracted, still appearing in a legal document. Hidden keys are removed
 * before validation too, so a required field cannot block a finalise while
 * being impossible to see.
 */
export function pruneHidden(
  sections: Array<SectionDef>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  // Only fields whose key addresses an answer. A static block's key is a React
  // handle, not an address into `data` — treating it as one makes `delete
  // pruned[key]` a live grenade the moment a note's key matches a key some
  // earlier version of the template stored a real answer under.
  const visible = new Set<string>()
  for (const section of visibleSections(sections, data)) {
    for (const field of section.fields) {
      if (isDataField(field)) visible.add(field.key)
    }
  }

  const declared: Array<FieldDef> = sections.flatMap(
    (section) => section.fields,
  )
  const pruned = { ...data }
  for (const field of declared) {
    if (!isDataField(field)) continue
    if (!visible.has(field.key)) delete pruned[field.key]
  }
  // Keys the template does not declare are left alone rather than silently
  // dropped: older drafts may carry fields since removed, and losing them on
  // the next save would be destructive.
  return pruned
}
