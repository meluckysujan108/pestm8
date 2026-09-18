import type { ReportTemplate, SectionDef } from './types'

/**
 * The parts of a form a business owns.
 *
 * The three Pest M8 forms are reproduced word for word and stay that way —
 * their wording is the contract, and a correction to it should reach every
 * business that issues them. But a handful of things on the page are not the
 * form's: what the cover says, what the running footer calls it, and who has
 * to sign before it can be locked. Changing those used to mean cloning the
 * whole template, which forks the wording too and cuts the business off from
 * every later fix to it.
 *
 * So these are overrides applied at resolve time. Nothing here can change a
 * printed question or a printed answer — only the chrome and the signing rule.
 * Pure, so the same merge happens in the browser, in the render action and in
 * the freeze that `finalise` writes.
 */

export type TemplateSettings = {
  print?: {
    cover?: { title?: string; subtitle?: string }
    formName?: string
  }
  /**
   * Slots that must hold a signature before a report can lock. An empty or
   * absent list leaves the form's own `required` flags standing.
   */
  requiredSigners?: Array<string>
}

export function applyTemplateSettings(
  template: ReportTemplate,
  settings: TemplateSettings | null | undefined,
): ReportTemplate {
  if (!settings) return template

  const print = mergePrint(template, settings)
  const sections = applySigners(template.sections, settings.requiredSigners)

  if (print === template.print && sections === template.sections)
    return template
  return { ...template, print, sections }
}

function mergePrint(
  template: ReportTemplate,
  settings: TemplateSettings,
): ReportTemplate['print'] {
  const override = settings.print
  if (!override || (!override.cover && override.formName === undefined)) {
    return template.print
  }
  // A form with no print spec of its own is a v1 template or a
  // business-authored one; there is no chrome to override, and inventing a
  // spec here would change how it prints in ways nobody asked for.
  if (!template.print) return template.print

  return {
    ...template.print,
    ...(override.formName ? { formName: override.formName } : {}),
    ...(override.cover && template.print.cover
      ? {
          cover: {
            ...template.print.cover,
            ...(override.cover.title ? { title: override.cover.title } : {}),
            ...(override.cover.subtitle !== undefined
              ? { subtitle: override.cover.subtitle }
              : {}),
          },
        }
      : {}),
  }
}

/**
 * Rewrites which signature pads block a finalise.
 *
 * Named slots, not field keys: a slot is what the storage is keyed by and what
 * the validator checks, and it survives a form being reworded.
 */
function applySigners(
  sections: Array<SectionDef> | undefined,
  requiredSigners: Array<string> | undefined,
): Array<SectionDef> | undefined {
  if (!sections || !requiredSigners) return sections

  const required = new Set(requiredSigners)
  // Rebuilt by identity rather than with mutable flags: a section whose
  // fields all came back unchanged IS the original object, which keeps the
  // memoised resolve in the builder from re-rendering every field.
  const next = sections.map((section) => {
    const fields = section.fields.map((field) => {
      if (field.kind !== 'signature') return field
      const shouldRequire = required.has(field.slot)
      return (field.required ?? false) === shouldRequire
        ? field
        : { ...field, required: shouldRequire }
    })
    return same(fields, section.fields) ? section : { ...section, fields }
  })

  return same(next, sections) ? sections : next
}

function same<T>(next: Array<T>, before: Array<T>): boolean {
  return next.every((item, index) => item === before[index])
}
