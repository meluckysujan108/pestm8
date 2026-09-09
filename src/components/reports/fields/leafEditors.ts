import {
  AreaControl,
  AreasControl,
  ChecksControl,
  ChipsControl,
  DateControl,
  GpsControl,
  NumberControl,
  PhotosControl,
  RadioControl,
  SelectControl,
  SignatureControl,
  TextControl,
  TimeControl,
  ToggleControl,
} from './controls'
import { emptyAreas } from '#/lib/reportTemplates'
import type { FieldDef, FieldKind } from '#/lib/reportTemplates'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { ComponentType } from 'react'

export type EditorCtx = {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
}

export type EditorProps<TField extends FieldDef = FieldDef> = {
  field: TField
  value: unknown
  /**
   * Pass a value, or a function of the previous value.
   *
   * The updater form exists because two changes in one tick both read the same
   * captured value and the second silently wins — a double-tapped "Add row"
   * adds one row, and two chips tapped together keep only the last. Every
   * stored value is JSON, so a function argument is unambiguously an updater.
   */
  onChange: (next: unknown) => void
  ctx: EditorCtx
}

/**
 * Resolves whatever `onChange` handed back against the current value.
 *
 * Every consumer of `onChange` must go through this. Missing it is silent and
 * nasty: the updater function itself gets stored as the field's value, and the
 * failure surfaces one render later as `.filter is not a function` somewhere
 * unrelated. That is exactly what happened to repeater cells, which are edited
 * through a second `onChange` that did not know about the updater form.
 */
export function applyUpdate(next: unknown, previous: unknown): unknown {
  return typeof next === 'function'
    ? (next as (current: unknown) => unknown)(previous)
    : next
}

export type FieldEditor<TField extends FieldDef = FieldDef> = {
  /**
   * True for multi-control groups, which need fieldset/legend. A <label> names
   * exactly one control — wrapping a group in one makes every button inside
   * inherit the whole group's text as its accessible name, so a screen reader
   * announces the entire checklist per button.
   */
  group: boolean
  /**
   * The value an untouched field starts at. Returning `undefined` keeps the key
   * out of the draft entirely, which is what photos need: they attach straight
   * to the report because `data` is replaced wholesale on every save
   * (convex/schema.ts:146).
   */
  seed: (field: TField) => unknown
  Control: ComponentType<EditorProps<TField>>
}

/**
 * Editors for every kind that can stand alone *and* sit inside a repeater cell.
 *
 * Split out from `registry.ts` for a structural reason, not a stylistic one:
 * the repeater control needs to resolve its cells' editors, and importing the
 * full registry created a cycle — `registry -> RepeaterGrid -> registry` — that
 * left `FIELD_EDITORS` half-initialised at module-eval time. Keeping the leaves
 * here breaks it, and enforces at the module level what `CellDef` asserts in
 * the types: a repeater cannot contain a repeater.
 */
export const LEAF_EDITORS: {
  [K in Exclude<FieldKind, 'repeater'>]: FieldEditor<
    Extract<FieldDef, { kind: K }>
  >
} = {
  // Text-ish fields seed to '' so an untouched required field fails its own
  // .min(1) rule and reports the message written for it, rather than Zod's
  // "expected string, received undefined".
  text: { group: false, seed: () => '', Control: TextControl },
  area: { group: false, seed: () => '', Control: AreaControl },
  select: { group: false, seed: () => '', Control: SelectControl },
  chips: { group: true, seed: () => [], Control: ChipsControl },
  // Seeded so every row starts explicitly "inspected" rather than undefined,
  // which would read as an unanswered question.
  areas: {
    group: true,
    seed: (field) => emptyAreas(field.rows),
    Control: AreasControl,
  },
  photos: { group: true, seed: () => undefined, Control: PhotosControl },
  // Seeded absent, not `false`/0: an unanswered question must not look like a
  // deliberate "No" or a measured zero on a document someone signs.
  toggle: { group: true, seed: () => undefined, Control: ToggleControl },
  number: { group: false, seed: () => undefined, Control: NumberControl },
  radio: { group: true, seed: () => '', Control: RadioControl },
  date: {
    group: false,
    seed: (field) =>
      field.defaultToday ? new Date().toISOString().slice(0, 10) : '',
    Control: DateControl,
  },
  time: { group: false, seed: () => '', Control: TimeControl },
  checks: { group: true, seed: () => [], Control: ChecksControl },
  gps: { group: true, seed: () => undefined, Control: GpsControl },
  // The drawn image lives in storage; `data` holds only `{ signedAt }`, and an
  // unsigned field holds nothing at all.
  signature: { group: true, seed: () => undefined, Control: SignatureControl },
}
