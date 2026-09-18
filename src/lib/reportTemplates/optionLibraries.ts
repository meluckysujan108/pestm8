import { REPORT_TEMPLATES } from './index'
import { optionSetsOf } from './optionSets'
import type { Option, OptionSetKey, TemplateId } from './types'

/**
 * The verbatim defaults for each business vocabulary, derived from the
 * built-in templates rather than kept as a second copy of the strings. One copy
 * of every product name, with its `// src:` citation next to it in the
 * template, is the only arrangement the fidelity test can hold to account.
 *
 * Nothing that a template module imports may import this file.
 */

export const MAX_LIVE_OPTIONS = 200
export const MAX_RENAMES = 50
export const MAX_OPTION_LENGTH = 200

/**
 * How much of a list a picker offers before the list itself.
 *
 * Five remembered per member, and eight in the group once the business's own
 * `usual` flags join them. Both are small on purpose: a "Usually" group that
 * needs scrolling is the list again, one heading lower.
 */
export const MAX_RECENT = 5
export const MAX_USUAL = 8

/**
 * The business's usual answers and this member's recent ones, as a picker
 * orders them: what the owner marked first, then what this member last
 * reached for, each appearing once.
 */
export function usualOrder(
  flagged: Array<string>,
  recent: Array<string>,
): Array<string> {
  const seen = new Set(flagged)
  return [...flagged, ...recent.filter((v) => !seen.has(v))].slice(0, MAX_USUAL)
}

/** This member's list after they reached for `picked`, most recent first. */
export function rememberedOrder(
  before: Array<string>,
  picked: Array<string>,
): Array<string> {
  const seen = new Set(picked)
  return [...picked, ...before.filter((v) => !seen.has(v))].slice(0, MAX_RECENT)
}

export type DefaultOptionSet = {
  options: Array<Option>
  template: TemplateId
  version: number
}

export function defaultOptionSet(key: OptionSetKey): DefaultOptionSet | null {
  for (const template of Object.values(REPORT_TEMPLATES)) {
    const found = optionSetsOf(template).get(key)
    if (found && template.id !== 'custom') {
      return { options: found, template: template.id, version: template.version }
    }
  }
  return null
}

/** Which built-ins draw on each vocabulary — what a rename has to reach. */
export function builtinBindings(): Map<OptionSetKey, Array<TemplateId>> {
  const bindings = new Map<OptionSetKey, Array<TemplateId>>()
  for (const template of Object.values(REPORT_TEMPLATES)) {
    if (template.id === 'custom') continue
    for (const key of optionSetsOf(template).keys()) {
      bindings.set(key, [...(bindings.get(key) ?? []), template.id])
    }
  }
  return bindings
}

/**
 * Every vocabulary a business owns, in the order a settings screen should
 * show them: the ones a technician touches on every job first, the
 * once-a-year descriptive ones last.
 *
 * Listed rather than derived from the union, because a union cannot be
 * iterated at runtime and because the order is an editorial decision — the
 * product list is opened weekly and `Facade` almost never.
 */
export const OPTION_SET_KEYS: Array<OptionSetKey> = [
  'products',
  'treatments',
  'methods',
  'quantities',
  'nextVisit',
  'risks',
  'riskActions',
  'housekeeping',
  'areasTreated',
  'limitationFactors',
  'noticeLocation',
  'peoplePresent',
  'wallConstruction',
  'floorType',
  'roofType',
  'structureType',
  'structureHeight',
  'facade',
  'topography',
]

/**
 * What to call each list on screen. Not the form's own label — a form asks
 * "Product & Active Ingredient" in a table heading, and a settings screen is
 * naming the list itself.
 */
export const OPTION_SET_LABELS: Record<OptionSetKey, string> = {
  products: 'Products',
  treatments: 'Treatments',
  methods: 'Application methods',
  quantities: 'Quantities',
  nextVisit: 'Next visit intervals',
  risks: 'Risks on site',
  riskActions: 'Actions taken',
  housekeeping: 'Housekeeping recommendations',
  areasTreated: 'Areas treated',
  limitationFactors: 'Limiting factors',
  noticeLocation: 'Durable notice locations',
  peoplePresent: 'People present',
  wallConstruction: 'Wall construction',
  floorType: 'Floor type',
  roofType: 'Roof type',
  structureType: 'Structure type',
  structureHeight: 'Structure height',
  facade: 'Facade',
  topography: 'Topography',
}
