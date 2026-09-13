import type {
  CellDef,
  FieldDef,
  Option,
  OptionSetKey,
  ReportTemplate,
  SectionDef,
} from './types'

/**
 * A business's own versions of the vocabularies a template marks as theirs
 * (`optionsFrom`). Absent keys fall back to the template's verbatim defaults.
 */
export type OptionSetOverrides = Partial<Record<OptionSetKey, Array<Option>>>

/**
 * The template with each business-owned list replaced by the business's own.
 *
 * An overlay, never a lookup at render time: a built-in module always exports
 * complete `options` (the verbatim defaults), so everything that reads
 * `field.options` — the controls, `present()`, validation, the fidelity test —
 * works on a template nobody has customised, and a business's edits are one
 * pure pass over it. Pure and synchronous, because template resolution runs
 * inside a Node action and inside the PDF render tree, neither of which can
 * read the database.
 *
 * Returns the same object when there is nothing to apply, so memoised callers
 * do not re-render for no reason.
 */
export function applyOptionSets(
  template: ReportTemplate,
  overrides: OptionSetOverrides | null | undefined,
): ReportTemplate {
  if (!overrides || Object.keys(overrides).length === 0) return template

  // An object, not a `let`: flow analysis cannot see a closure assigning a
  // local, and would conclude nothing ever changes.
  const state = { changed: false }
  const mapField = <T extends FieldDef | CellDef>(field: T): T => {
    if (field.kind === 'repeater') {
      const columns = field.columns.map(mapField)
      if (columns.every((cell, i) => cell === field.columns[i])) return field
      state.changed = true
      return { ...field, columns }
    }
    if (
      (field.kind === 'select' ||
        field.kind === 'radio' ||
        field.kind === 'chips' ||
        field.kind === 'checks') &&
      field.optionsFrom
    ) {
      const own = overrides[field.optionsFrom]
      if (!own) return field
      state.changed = true
      return { ...field, options: own }
    }
    return field
  }

  const sections: Array<SectionDef> | undefined = template.sections?.map(
    (section) => ({ ...section, fields: section.fields.map(mapField) }),
  )
  const fields = template.fields.map(mapField)
  if (!state.changed) return template
  return { ...template, fields, sections }
}

/**
 * Every list a template draws from a business vocabulary, with its defaults.
 * What a settings screen lists, and what a rename has to reach.
 */
export function optionSetsOf(
  template: ReportTemplate,
): Map<OptionSetKey, Array<Option>> {
  const found = new Map<OptionSetKey, Array<Option>>()
  const visit = (field: FieldDef | CellDef) => {
    if (field.kind === 'repeater') {
      field.columns.forEach(visit)
      return
    }
    if (
      (field.kind === 'select' ||
        field.kind === 'radio' ||
        field.kind === 'chips' ||
        field.kind === 'checks') &&
      field.optionsFrom &&
      !found.has(field.optionsFrom)
    ) {
      found.set(field.optionsFrom, field.options)
    }
  }
  for (const section of template.sections ?? []) section.fields.forEach(visit)
  template.fields.forEach(visit)
  return found
}

// ---------------------------------------------------------------------------
// Renaming an option: the pure half. Convex walks drafts; these decide what
// changes inside one.
// ---------------------------------------------------------------------------

/**
 * Where a vocabulary's answers live in a report's `data`: top-level keys, and
 * repeater cells (the treatment grid's Product column is the case that
 * matters). Walks every field whether or not it is currently visible — a hidden
 * answer is still stored, and `pruneHidden` decides about it at validation.
 */
export type BoundPaths = {
  top: Array<string>
  cells: Array<{ repeater: string; cell: string }>
}

export function boundPaths(
  sections: Array<SectionDef>,
  key: OptionSetKey,
): BoundPaths {
  const paths: BoundPaths = { top: [], cells: [] }
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.kind === 'repeater') {
        for (const cell of field.columns) {
          if (bindsTo(cell, key)) {
            paths.cells.push({ repeater: field.key, cell: cell.key })
          }
        }
      } else if (bindsTo(field, key)) {
        paths.top.push(field.key)
      }
    }
  }
  return paths
}

function bindsTo(field: FieldDef | CellDef, key: OptionSetKey): boolean {
  return (
    (field.kind === 'select' ||
      field.kind === 'radio' ||
      field.kind === 'chips' ||
      field.kind === 'checks') &&
    field.optionsFrom === key
  )
}

/**
 * Strings a template matches BY VALUE, which a rename would silently break: an
 * exclusive or locked checklist item, an answer that flags a problem and so
 * decides whether guidance prints, and any visibility condition comparing
 * against a bound field. Renaming "No Risk Safe Access Given" would quietly end
 * its exclusivity on every future report.
 */
export function pinnedValues(
  sections: Array<SectionDef>,
  key: OptionSetKey,
): Set<string> {
  const pinned = new Set<string>()
  const boundKeys = new Set<string>()
  const add = (values: Array<string> | undefined) =>
    values?.forEach((value) => pinned.add(value))

  const collect = (field: FieldDef | CellDef) => {
    if (!bindsTo(field, key)) return
    boundKeys.add(field.key)
    if (
      field.kind === 'select' ||
      field.kind === 'radio' ||
      field.kind === 'chips' ||
      field.kind === 'checks'
    ) {
      add(field.flaggedValues)
    }
    if (field.kind === 'checks') {
      add(field.locked)
      add(field.exclusive)
    }
  }

  for (const section of sections) {
    for (const field of section.fields) {
      if (field.kind === 'repeater') field.columns.forEach(collect)
      else collect(field)
    }
  }

  const walkCondition = (condition: unknown) => {
    if (!condition || typeof condition !== 'object') return
    const c = condition as Record<string, unknown>
    if (typeof c.when === 'string' && boundKeys.has(c.when)) {
      if (typeof c.eq === 'string') pinned.add(c.eq)
      if (typeof c.includes === 'string') pinned.add(c.includes)
      if (Array.isArray(c.oneOf)) {
        c.oneOf.forEach((v) => typeof v === 'string' && pinned.add(v))
      }
    }
    if (Array.isArray(c.all)) c.all.forEach(walkCondition)
    if (Array.isArray(c.any)) c.any.forEach(walkCondition)
    if (c.not) walkCondition(c.not)
  }
  for (const section of sections) {
    walkCondition(section.visibleWhen)
    for (const field of section.fields) walkCondition(field.visibleWhen)
  }
  return pinned
}

/**
 * Where a value ends up after every rename recorded since `since`, in order.
 *
 * The jobs a rename schedules run in no guaranteed order, so a job trusts the
 * log, not the `to` it was scheduled with: A->B then B->C lands on C whichever
 * rewrite runs first, and A->B then B->A lands back on A.
 */
export function resolveRename(
  renames: Array<{ from: string; to: string; at: number }>,
  from: string,
  since: number,
): string {
  let current = from
  for (const rename of renames) {
    if (rename.at >= since && rename.from === current) current = rename.to
  }
  return current
}

function renameValue(value: unknown, from: string, to: string): unknown {
  if (value === from) return to
  if (Array.isArray(value) && value.includes(from)) {
    // De-duplicated: an extensible checklist may already hold `to` as an item
    // the technician typed, and printing it twice would be wrong.
    return [...new Set(value.map((item) => (item === from ? to : item)))]
  }
  return value
}

/**
 * A report's answers with `from` replaced by `to` wherever a bound field or
 * cell holds it. Returns the input untouched when nothing matched, so the
 * caller can skip the write entirely.
 */
export function renameInData(
  data: Record<string, unknown>,
  paths: BoundPaths,
  from: string,
  to: string,
): { data: Record<string, unknown>; changed: boolean } {
  let next = data
  const set = (k: string, v: unknown) => {
    if (next === data) next = { ...data }
    next[k] = v
  }

  for (const k of paths.top) {
    const renamed = renameValue(data[k], from, to)
    if (renamed !== data[k]) set(k, renamed)
  }

  const byRepeater = new Map<string, Array<string>>()
  for (const { repeater, cell } of paths.cells) {
    byRepeater.set(repeater, [...(byRepeater.get(repeater) ?? []), cell])
  }
  for (const [repeater, cells] of byRepeater) {
    const rows = data[repeater]
    if (!Array.isArray(rows)) continue
    // An object, not a `let`: flow analysis cannot see the callback assign it.
    const rowState = { changed: false }
    const nextRows = rows.map((row: Record<string, unknown>) => {
      let nextRow = row
      for (const cell of cells) {
        const renamed = renameValue(row[cell], from, to)
        if (renamed !== row[cell]) {
          if (nextRow === row) nextRow = { ...row }
          nextRow[cell] = renamed
          rowState.changed = true
        }
      }
      return nextRow
    })
    if (rowState.changed) set(repeater, nextRows)
  }

  return { data: next, changed: next !== data }
}
