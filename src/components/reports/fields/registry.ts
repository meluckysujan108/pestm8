import { GalleryControl, LEAF_EDITORS } from './leafEditors'
import { RepeaterControl } from './RepeaterGrid'
import {
  DerivedRow,
  EmailsControl,
  HeadingBlock,
  MemberControl,
  NoteBlock,
} from './staticBlocks'
import { isDataField } from '#/lib/reportTemplates'
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
  // The static blocks. `group: false` keeps them out of a fieldset — they
  // contain no controls to name — and every one of them seeds `undefined` so
  // its key never reaches `data`.
  note: { group: false, seed: () => undefined, Control: NoteBlock },
  heading: { group: false, seed: () => undefined, Control: HeadingBlock },
  derived: { group: false, seed: () => undefined, Control: DerivedRow },
  // Literally the gallery control — a cover is a gallery of exactly one, whose
  // single photo is the front page. Reached through `leafEditors` rather than
  // a direct import of `PhotoGallery`, which imports `EditorProps` back from
  // this module: a direct edge would recreate the registry -> control ->
  // registry cycle `leafEditors.ts` was split out to break.
  cover: { group: true, seed: () => undefined, Control: GalleryControl },
  member: { group: true, seed: () => undefined, Control: MemberControl },
  emails: { group: false, seed: () => [], Control: EmailsControl },
}

/** Seeds a draft so untouched fields validate against their own rules. */
export function seedData(
  fields: Array<FieldDef>,
  initial: Record<string, unknown>,
): Record<string, unknown> {
  const seeded = { ...initial }
  for (const field of fields) {
    // Structural, not a promise each registry entry remembers to keep: a
    // static block or a record-bound fact has a key for React's benefit, and
    // writing that key into `data` would make it look like an answer.
    if (!isDataField(field)) continue
    if (seeded[field.key] !== undefined) continue
    const editor = FIELD_EDITORS[field.kind] as FieldEditor
    const value = editor.seed(field)
    if (value !== undefined) seeded[field.key] = value
  }
  return seeded
}
