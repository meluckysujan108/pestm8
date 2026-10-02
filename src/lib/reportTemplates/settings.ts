import type { FieldDef, ReportTemplate, SectionDef } from './types'

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
 * So these are overrides applied at resolve time. Nothing a business sets can
 * change a printed question or a printed answer — only the chrome and the
 * signing rule. Pure, so the same merge happens in the browser, in the render
 * action and in the freeze that `finalise` writes.
 *
 * The two rules about the client's signature at the end of this file are the
 * app's, not the business's: it is never required, and while it is switched
 * off a report being filled in leaves out the client's part altogether.
 */

export type TemplateSettings = {
  print?: {
    cover?: { title?: string; subtitle?: string }
    formName?: string
  }
  /**
   * Slots that must hold a signature before a report can lock. Absent leaves
   * the form's own `required` flags standing; an empty list requires nobody.
   * A client's pad is never required, whatever this says
   * (`withOptionalClientSignatures`).
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
      // A client's pad cannot be made required from here either: a setting
      // saved before that rule, naming the client's slot, now asks nothing.
      const shouldRequire = field.role !== 'client' && required.has(field.slot)
      return (field.required ?? false) === shouldRequire
        ? field
        : { ...field, required: shouldRequire }
    })
    return same(fields, section.fields) ? section : { ...section, fields }
  })

  return same(next, sections) ? sections : next
}

/**
 * A client's signature is never required to lock a report.
 *
 * The technician's signature is what makes the record theirs, and it is the
 * one the forms insist on. The client's is welcome when they are there to
 * give it — and often they are not: the job was done while they were at
 * work, or they had gone by the time the paperwork was. Holding the lock for
 * a signature nobody can give stops the record being made at all. So a pad
 * the client signs is optional, whatever a form, a business's own clone or
 * its settings say. Decided 29 Sept 2026, at Pest M8 Pest Control's request.
 *
 * Applied where a draft's template is resolved (`resolveReportTemplate`), so
 * the builder, its progress, the finalise sheet and the server's finalise
 * gate all read the same rule. Returns the same object when nothing changes,
 * which keeps the builder's memoised template from re-rendering every field.
 */
export function withOptionalClientSignatures(
  template: ReportTemplate,
): ReportTemplate {
  const sections = template.sections?.map((section) => {
    const fields = optionalForClients(section.fields)
    return fields === section.fields ? section : { ...section, fields }
  })
  const fields = optionalForClients(template.fields)
  const sectionsChanged =
    sections !== undefined &&
    template.sections !== undefined &&
    !same(sections, template.sections)
  if (!sectionsChanged && fields === template.fields) return template
  return {
    ...template,
    ...(sectionsChanged ? { sections } : {}),
    fields,
  }
}

function optionalForClients(fields: Array<FieldDef>): Array<FieldDef> {
  const next = fields.map((field) =>
    field.kind === 'signature' && field.role === 'client' && field.required
      ? { ...field, required: false }
      : field,
  )
  return same(next, fields) ? fields : next
}

/**
 * Whether a report being filled in asks the client to sign.
 *
 * Off since 1 Oct 2026, at the product owner's request: the client is usually
 * not there to sign, and a pad nobody signs is a blank on every document.
 * `true` brings the client's pad, and the client acknowledgment sections, back
 * on every report not yet locked. The frontend and the backend each bundle
 * this, so flipping it means shipping both: the backend first when switching
 * it off, the frontend first when switching it back on. The side that shows
 * the client less goes first, so a draft is never locked with a client's
 * section nobody was shown — the freeze at lock is the backend's.
 *
 * `as boolean`: a bare `false` is typed as the literal, and every check on it
 * would then be an unnecessary condition to the linter.
 */
export const CLIENT_SIGNATURES_SHOWN = false as boolean

/**
 * The fields of the client acknowledgment sections — Termite §8 and Timber
 * Pest §9 — besides the client's pad: the statement agreed to, the client's
 * name and the date they signed. Matched by key, which `cloneBuiltin` keeps,
 * so a business's copy of either form loses the same section; a section a
 * business wrote itself loses only the client's pad, never its own questions.
 */
const CLIENT_SIGN_OFF_KEYS: ReadonlySet<string> = new Set([
  'acknowledgmentStatement',
  'clientSignatoryName',
  'clientDateSigned',
  'clientAcceptanceStatement',
  'acknowledgmentClientName',
  'clientSignedDate',
])

/**
 * A report not yet locked, without the client's part, while client signatures
 * are off (`CLIENT_SIGNATURES_SHOWN`).
 *
 * The client's part is every pad the client signs, on any form, and a section
 * that holds nothing else but that sign-off. Applied where a draft's form is
 * worked out (`resolveReportTemplate` with `status: 'draft'`) and by the
 * freeze when a report is locked (`freezeTemplate` with `atLock`), so what is
 * locked is what was filled in. Never to a locked report, and never by the
 * snapshot backfills: a document that has been sent stays as it was sent.
 *
 * Removed, not hidden: `pruneHidden` clears the answers of a field the form
 * declares but hides, and nothing stored is to be lost — the answers and the
 * signature images stay where they are, ready for the switch to be flipped
 * back.
 *
 * `keep` is the slots this report already holds a signature in. A signature
 * somebody actually gave is never left off the document: a draft the client
 * signed before this was switched off, or on a phone still running the app
 * from before, keeps its client's pad and section.
 *
 * Returns the same object when nothing is removed, and every untouched
 * section keeps its identity, as `withOptionalClientSignatures` does.
 */
export function withoutClientSigning(
  template: ReportTemplate,
  {
    shown = CLIENT_SIGNATURES_SHOWN,
    keep = [],
  }: { shown?: boolean; keep?: ReadonlyArray<string> } = {},
): ReportTemplate {
  if (shown) return template

  const dropped = (field: FieldDef) =>
    field.kind === 'signature' &&
    field.role === 'client' &&
    !keep.includes(field.slot)

  const removedNumbers: Array<number> = []
  const sections = template.sections?.flatMap((section) => {
    const signOff =
      section.fields.some(dropped) &&
      section.fields.every(
        (field) => dropped(field) || CLIENT_SIGN_OFF_KEYS.has(field.key),
      )
    if (signOff) {
      if (section.number !== undefined) removedNumbers.push(section.number)
      return []
    }
    const fields = withoutFields(section.fields, dropped)
    return [fields === section.fields ? section : { ...section, fields }]
  })
  // A flat `fields` list loses its pads and nothing else: the "Details"
  // section `sectionsOf()` wraps it in is printed output.
  const fields = withoutFields(template.fields, dropped)

  const sectionsChanged =
    sections !== undefined &&
    template.sections !== undefined &&
    !same(sections, template.sections)
  if (!sectionsChanged && fields === template.fields) return template

  return {
    ...template,
    ...(sectionsChanged ? { sections } : {}),
    print: renumberTerms(template.print, removedNumbers),
    fields,
  }
}

function withoutFields(
  fields: Array<FieldDef>,
  dropped: (field: FieldDef) => boolean,
): Array<FieldDef> {
  const next = fields.filter((field) => !dropped(field))
  return next.length === fields.length ? fields : next
}

/**
 * The terms heading, numbered on from the sections still there. The Termite
 * certificate's terms follow its last section ("9. TERMS AND CONDITIONS OF
 * CERTIFICATE" after §8): with §8 gone they are §8, rather than a document
 * that jumps from 7 to 9 as if a page were missing.
 */
function renumberTerms(
  print: ReportTemplate['print'],
  removed: ReadonlyArray<number>,
): ReportTemplate['print'] {
  const heading = print?.termsHeading
  const match = heading ? /^(\d+)\.(\s)/.exec(heading) : null
  if (!print || !heading || !match) return print
  const number = Number(match[1])
  const before = removed.filter((n) => n < number).length
  if (before === 0) return print
  return {
    ...print,
    termsHeading: `${number - before}.${heading.slice(match[1].length + 1)}`,
  }
}

function same<T>(next: Array<T>, before: Array<T>): boolean {
  // Length too: a section removed from the end leaves a prefix that is the
  // same object for object, which would otherwise read as nothing changed.
  return (
    next.length === before.length &&
    next.every((item, index) => item === before[index])
  )
}
