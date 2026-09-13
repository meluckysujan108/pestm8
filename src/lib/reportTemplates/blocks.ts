import { fieldPrints } from './choices'
import { visibleSections } from './visibility'
import type { FieldDef, SectionDef } from './types'

/**
 * A section's fields split into what belongs in the key/value table and what
 * has to escape it, in document order.
 *
 * Static blocks live in `section.fields` rather than a sibling array, because
 * the array order is the only thing that can say "this clause sits between
 * question three and question four" — a separate list would need an anchor
 * index that nothing in the template format has. The cost is that every
 * painter has to split the list again, so both of them split it here, once.
 *
 * Only `note` and `heading` escape. `photos`, `gallery` and `cover` present as
 * `omit` and are filtered out by the painters anyway; `derived` is a value with
 * a label, so it stays in the table where every other value lives.
 *
 * Runs, not one row each: a run of consecutive answers is a single card with
 * hairlines between its rows, and splitting per field would turn one card into
 * six.
 */
export type StaticBlockField = Extract<FieldDef, { kind: 'note' | 'heading' }>

export type GalleryField = Extract<FieldDef, { kind: 'gallery' }>

export type SectionRun =
  | { type: 'fields'; fields: Array<FieldDef> }
  | { type: 'block'; field: StaticBlockField }
  /** A photo set printed where the form puts it — see `inlineGalleries`. */
  | { type: 'gallery'; field: GalleryField }

/**
 * `document`, when given, means this walk paints the FINISHED document: fields
 * and blocks that only belong on screen, or only print when their question was
 * flagged, are left out. The builder omits it and shows everything, because
 * guidance and form-only controls are for the person filling the form in.
 */
export function sectionRuns(
  fields: Array<FieldDef>,
  document?: {
    allFields: Array<FieldDef>
    data: Record<string, unknown>
    /**
     * Print each photo set inside its section, where the form puts it, rather
     * than gathered at the end. A verbatim form's photos belong to a finding —
     * the borer photos under Wood Borers — and five of the Timber report's sets
     * are labelled just "Photos", so detached they could not be told apart.
     */
    inlineGalleries?: boolean
  },
): Array<SectionRun> {
  const runs: Array<SectionRun> = []
  for (const field of fields) {
    if (document && !fieldPrints(field, document.allFields, document.data)) {
      continue
    }
    if (document?.inlineGalleries && field.kind === 'gallery') {
      runs.push({ type: 'gallery', field })
      continue
    }
    if (field.kind === 'note' || field.kind === 'heading') {
      runs.push({ type: 'block', field })
      continue
    }
    const last = runs.at(-1)
    if (last?.type === 'fields') last.fields.push(field)
    else runs.push({ type: 'fields', fields: [field] })
  }
  return runs
}

/**
 * The photo sets a finished document may print: galleries in a section that is
 * showing, not hidden by their own condition, and not screen-only.
 *
 * Photos live in their own table, outside the answers, so hiding a question
 * does not remove them. Without this, answering "Was a Durable Notice fitted?"
 * No after uploading its photo would print a certificate that says No and shows
 * the notice.
 */
export function printedGalleryKeys(
  sections: Array<SectionDef>,
  data: Record<string, unknown>,
): Set<string> {
  const allFields = sections.flatMap((section) => section.fields)
  const keys = new Set<string>()
  for (const section of visibleSections(sections, data)) {
    for (const field of section.fields) {
      if (
        (field.kind === 'gallery' || field.kind === 'cover') &&
        fieldPrints(field, allFields, data)
      ) {
        keys.add(field.key)
      }
    }
  }
  return keys
}
