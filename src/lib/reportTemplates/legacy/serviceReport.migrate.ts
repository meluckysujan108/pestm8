import { fieldsOf } from '../index'
import { serviceReport as v2 } from '../serviceReport'
import { serviceReport as v1 } from './serviceReport.v1'
import type { CellDef, FieldDef } from '../types'

/**
 * Carrying a v1 Service Report draft's answers across to the verbatim form.
 *
 * The questions kept their keys, so every answer has somewhere to go. The
 * wording of the ANSWERS changed — "100 mL / 10 L" is "100ml/10L" on the form
 * the business actually issues — so a stored choice has to be re-worded to the
 * option it now corresponds to, or it would sit in the draft as a string no
 * option matches.
 *
 * The map is built from the two modules, not typed out: each v1 list lines up
 * index for index with its v2 list, which `serviceReport.migrate.test.ts`
 * asserts pair by pair. A hand-typed copy of two hundred product strings is
 * exactly where a stray space would hide.
 */

type Choice = Extract<FieldDef | CellDef, { options: Array<{ value: string }> }>

function choicesByPath(template: typeof v1): Map<string, Choice> {
  const out = new Map<string, Choice>()
  for (const field of fieldsOf(template)) {
    if (field.kind === 'repeater') {
      for (const cell of field.columns) {
        if ('options' in cell) out.set(`${field.key}.${cell.key}`, cell)
      }
    } else if ('options' in field) {
      out.set(field.key, field)
    }
  }
  return out
}

/** v1 value -> v2 value, per answer path (`risks`, `treatments.product`). */
export function valueMigrations(): Map<string, Map<string, string>> {
  const before = choicesByPath(v1)
  const after = choicesByPath(v2)
  const maps = new Map<string, Map<string, string>>()
  for (const [path, old] of before) {
    const next = after.get(path)
    if (!next) continue
    const pairs = new Map<string, string>()
    old.options.forEach((option, i) => {
      const target = next.options.at(i)
      if (target) pairs.set(option.value, target.value)
    })
    maps.set(path, pairs)
  }
  return maps
}

export type SwitchResult = {
  data: Record<string, unknown>
  /**
   * Stored answers no v2 option corresponds to — kept as they are, and
   * recorded in the switch's audit row. With the built-in lists these can only
   * be items a technician typed into an extensible checklist, which carry
   * across unchanged anyway.
   */
  unmapped: Array<{ path: string; value: string }>
  /** Signatures were given against the old wording, so they do not carry over. */
  clearedSignatures: boolean
}

export function migrateServiceReportV1(
  input: Record<string, unknown>,
  { hasReportPhotos }: { hasReportPhotos: boolean },
): SwitchResult {
  const maps = valueMigrations()
  const unmapped: SwitchResult['unmapped'] = []
  const data: Record<string, unknown> = { ...input }

  const remap = (path: string, value: unknown): unknown => {
    const map = maps.get(path)
    if (!map) return value
    const one = (item: unknown) => {
      if (typeof item !== 'string' || item === '') return item
      const next = map.get(item)
      if (next !== undefined) return next
      // An item the technician typed into an extensible list has no v1
      // option either; it carries across as itself.
      unmapped.push({ path, value: item })
      return item
    }
    return Array.isArray(value) ? [...new Set(value.map(one))] : one(value)
  }

  for (const path of maps.keys()) {
    const dot = path.indexOf('.')
    const top = dot === -1 ? path : path.slice(0, dot)
    const cell = dot === -1 ? undefined : path.slice(dot + 1)
    if (cell === undefined) {
      if (top in data) data[top] = remap(path, data[top])
      continue
    }
    const rows = data[top]
    if (Array.isArray(rows)) {
      data[top] = rows.map((row: Record<string, unknown>) =>
        cell in row ? { ...row, [cell]: remap(path, row[cell]) } : row,
      )
    }
  }

  // "Email Report To" was one free-text line and is now a list of addresses.
  if (typeof data.emailReportTo === 'string') {
    const addresses = data.emailReportTo
      .split(/[\s,;]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
    data.emailReportTo = [...new Set(addresses)]
  }

  // The photos section only shows while "Add Photos?" is Yes. A draft that
  // already has photos must not hide them by switching.
  if (hasReportPhotos && data.addPhotos === undefined) data.addPhotos = true

  const clearedSignatures =
    data.technicianSignature !== undefined || data.clientSignature !== undefined
  delete data.technicianSignature
  delete data.clientSignature

  return { data, unmapped, clearedSignatures }
}
