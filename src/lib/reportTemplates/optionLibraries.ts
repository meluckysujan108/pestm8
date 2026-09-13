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
