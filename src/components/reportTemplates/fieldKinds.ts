import type { CellDef, FieldDef, FieldKind } from '#/lib/reportTemplates'

/**
 * Everything the template editor needs to know about a field kind that isn't
 * already in `FieldDef` itself: its display name for the picker, a one-line
 * description, and how to mint a fresh instance with sensible defaults.
 *
 * Deliberately excludes rendering/validation — those already exist
 * (`registry.ts`'s `FIELD_EDITORS`, `deriveSchema.ts`) and this file must
 * never duplicate them, only describe the *authoring* side.
 */

/**
 * The kinds a business author may add to their own template.
 *
 * All twenty-two. `derived`, `member`, `cover` and `emails` were held back
 * while they were promises the app had not yet kept: each binds to something
 * outside the form — a client record, the team roster, the front page, the
 * delivery — and offering one in a picker before that plumbing existed would
 * have let somebody build a form that silently printed nothing.
 *
 * All four now have it. `reports.get` returns the records a `derived` row
 * prints and the roster a `member` field chooses from, the cover is its own
 * page, and `emails` recipients reach `deliveries` through the field's
 * semantic. So they are offered.
 *
 * An array, so nothing checks it for completeness — keep it in step with
 * `FieldKind` by hand, and `FIELD_KIND_LABELS` (a `Record`) is what the
 * compiler does check.
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
  'heading',
  'note',
  'derived',
  'member',
  'cover',
  'emails',
]

/** The leaf subset `CellDef` restricts a repeater column to — no photos,
 * signatures, GPS, `areas`, or nested repeaters. */
export const CELL_FIELD_KINDS: Array<CellDef['kind']> = [
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
  heading: 'Sub-heading',
  note: 'Printed note',
  derived: 'Record detail',
  member: 'Team member',
  cover: 'Front page photo',
  emails: 'Email recipients',
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
  heading: 'Groups the questions beneath it. Asks nothing.',
  note: 'Prose that prints on the document — a clause or a disclaimer.',
  derived: 'Printed from the record. Never asked for, never stored.',
  member: 'Who did the work, chosen from your team.',
  cover: 'One landscape photo for the front page.',
  emails: 'Extra addresses this document is sent to.',
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
    case 'heading':
      return { kind, key, label, text: label }
    case 'note':
      // A note with an empty body would print as a blank inset, so it starts
      // with one empty paragraph the author types into rather than nothing.
      return {
        kind,
        key,
        label,
        body: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
        tone: 'note',
      }
    case 'derived':
      return { kind, key, label, source: 'client.name' }
    case 'member':
      return { kind, key, label, roleWord: 'Technician' }
    case 'cover':
      return { kind, key, label }
    case 'emails':
      return { kind, key, label, semantic: 'emailTo' }
  }
}
