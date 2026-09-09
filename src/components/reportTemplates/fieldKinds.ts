import type { FieldDef, FieldKind } from '#/lib/reportTemplates'

/**
 * Everything the template editor needs to know about a field kind that isn't
 * already in `FieldDef` itself: its display name for the picker, a one-line
 * description, and how to mint a fresh instance with sensible defaults.
 *
 * Deliberately excludes rendering/validation — those already exist
 * (`registry.ts`'s `FIELD_EDITORS`, `deriveSchema.ts`) and this file must
 * never duplicate them, only describe the *authoring* side.
 */

export const ALL_FIELD_KINDS: Array<FieldKind> = [
  'text',
  'area',
  'number',
  'toggle',
  'select',
  'radio',
  'chips',
  'checks',
  'date',
  'time',
  'gps',
  'signature',
  'areas',
  'photos',
  'gallery',
  'repeater',
]

/** The leaf subset `CellDef` restricts a repeater column to — no photos,
 * signatures, GPS, `areas`, or nested repeaters. */
export const CELL_FIELD_KINDS: Array<FieldKind> = [
  'text',
  'area',
  'select',
  'chips',
  'checks',
  'number',
  'date',
  'time',
  'toggle',
  'radio',
]

export const FIELD_KIND_LABELS: Record<FieldKind, string> = {
  text: 'Short text',
  area: 'Long text',
  number: 'Number',
  toggle: 'Yes / No',
  select: 'Choose one (dropdown)',
  radio: 'Choose one (list)',
  chips: 'Choose one (chips)',
  checks: 'Checklist',
  date: 'Date',
  time: 'Time',
  gps: 'GPS location',
  signature: 'Signature',
  areas: 'Area-by-area inspection',
  photos: 'Photos (fixed slots)',
  gallery: 'Photos (open-ended)',
  repeater: 'Repeating rows',
}

export const FIELD_KIND_HINTS: Record<FieldKind, string> = {
  text: 'A single line, e.g. a reference number.',
  area: 'A multi-line note.',
  number: 'A quantity, with an optional unit.',
  toggle: 'A single yes/no question.',
  select: 'One choice from a list, shown as a dropdown.',
  radio: 'One choice from a short list, all visible at once.',
  chips: 'One choice from a short list, shown as pills.',
  checks: 'Any number of items ticked from a list.',
  date: 'A calendar date.',
  time: 'A time of day.',
  gps: 'Captured once, on demand, from the device.',
  signature: 'A drawn signature.',
  areas: 'Inspected / no-access per named area, with a reason required.',
  photos: 'A fixed set of named photo slots.',
  gallery: 'As many photos as needed, with captions and a cover flag.',
  repeater: 'Repeating rows of the same columns, e.g. a treatment grid.',
}

export function slugifyKey(label: string, taken: Set<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'field'

  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

/** A fresh, minimal instance of a kind — the starting point `AddFieldSheet`
 * hands to `FieldConfigForm`, which the user then fills in. */
export function defaultField(
  kind: FieldKind,
  key: string,
  label: string,
): FieldDef {
  switch (kind) {
    case 'text':
      return { kind, key, label }
    case 'area':
      return { kind, key, label, rows: 3 }
    case 'number':
      return { kind, key, label }
    case 'toggle':
      return { kind, key, label }
    case 'select':
      return { kind, key, label, options: [] }
    case 'radio':
      return { kind, key, label, options: [] }
    case 'chips':
      return { kind, key, label, options: [] }
    case 'checks':
      return { kind, key, label, options: [] }
    case 'date':
      return { kind, key, label }
    case 'time':
      return { kind, key, label }
    case 'gps':
      return { kind, key, label }
    case 'signature':
      return { kind, key, label, slot: key, role: 'technician' }
    case 'areas':
      return { kind, key, label, rows: [] }
    case 'photos':
      return { kind, key, label, slots: [] }
    case 'gallery':
      return { kind, key, label }
    case 'repeater':
      return { kind, key, label, columns: [] }
  }
}
