import { LEAF_EDITORS } from './leafEditors'
import { RepeaterControl } from './RepeaterGrid'
import type { FieldEditor } from './leafEditors'
import type { FieldDef, FieldKind } from '#/lib/reportTemplates'

export type { EditorCtx, EditorProps, FieldEditor } from './leafEditors'

/**
 * The one place a field kind is bound to how it is edited. The mapped type is
 * the enforcement: adding a kind to the `FieldDef` union makes this object fail
 * to compile until the kind is handled, so a new kind cannot silently render as
 * nothing (§5.3).
 */
export const FIELD_EDITORS: {
  [K in FieldKind]: FieldEditor<Extract<FieldDef, { kind: K }>>
} = {
  ...LEAF_EDITORS,
  repeater: { group: true, seed: () => [], Control: RepeaterControl },
}

/** Seeds a draft so untouched fields validate against their own rules. */
export function seedData(
  fields: Array<FieldDef>,
  initial: Record<string, unknown>,
): Record<string, unknown> {
  const seeded = { ...initial }
  for (const field of fields) {
    if (seeded[field.key] !== undefined) continue
    const editor = FIELD_EDITORS[field.kind] as FieldEditor
    const value = editor.seed(field)
    if (value !== undefined) seeded[field.key] = value
  }
  return seeded
}
