import { termiteManagementCert } from './termiteManagementCert'
import { timberPestInspection } from './timberPestInspection'
import { serviceReport } from './serviceReport'
import { treatmentRecord } from './treatmentRecord'
import { serviceReport as serviceReportV1 } from './legacy/serviceReport.v1'
import { timberPestInspection as timberPestInspectionV1 } from './legacy/timberPestInspection.v1'
import { termiteManagementCert as termiteManagementCertV1 } from './legacy/termiteManagementCert.v1'
import type { FieldDef, ReportTemplate, SectionDef, TemplateId } from './types'

export const REPORT_TEMPLATES: Record<TemplateId, ReportTemplate> = {
  treatmentRecord,
  timberPestInspection,
  termiteManagementCert,
  serviceReport,
}

/**
 * Derived, not hand-listed. `REPORT_TEMPLATES` is a `Record<TemplateId, …>` so
 * the compiler forces a new template into it — but a parallel array is
 * unchecked, and a template missing from here is simply invisible in the
 * picker with nothing failing to say so.
 */
export const TEMPLATE_LIST: Array<ReportTemplate> =
  Object.values(REPORT_TEMPLATES)

/**
 * Built-ins that still render but can no longer be started. `treatmentRecord`
 * was an app-invented document with no source form behind it; every report
 * already written against it keeps opening, printing and emailing exactly as
 * before.
 */
export const RETIRED_TEMPLATES: ReadonlySet<TemplateId> = new Set([
  'treatmentRecord',
])

/** What the "new report" picker and "clone a built-in" offer. */
export const CREATABLE_TEMPLATES: Array<ReportTemplate> = TEMPLATE_LIST.filter(
  (template) =>
    template.id !== 'custom' && !RETIRED_TEMPLATES.has(template.id),
)

/**
 * The CURRENT revision of a built-in — what a new report is created against,
 * what the picker offers and what a clone copies. Never use it to render or
 * freeze an existing report: that report may have been written against an
 * earlier revision. Use `templateFor(id, report.templateVersion)`.
 */
export function getTemplate(id: TemplateId): ReportTemplate {
  return REPORT_TEMPLATES[id]
}

/**
 * Earlier revisions, kept byte-for-byte. A template only appears here once its
 * wording has been superseded; `treatmentRecord` has no source form to be
 * rewritten against and stays current at v1.
 */
export const LEGACY_TEMPLATES: Partial<
  Record<TemplateId, Record<number, ReportTemplate>>
> = {
  serviceReport: { 1: serviceReportV1 },
  timberPestInspection: { 1: timberPestInspectionV1 },
  termiteManagementCert: { 1: termiteManagementCertV1 },
}

/**
 * The revision a specific report was written against.
 *
 * This is what makes the wording change safe to ship in any order. A v1 draft
 * keeps filling in the v1 form, a v1 report finalised before the snapshot
 * backfill ran still renders v1, and the backfill freezes v1 whether it runs
 * before or after the new templates merge — none of them depends on what the
 * current module happens to say on the day.
 *
 * An unknown revision falls back to the current one rather than throwing: a
 * report must always open.
 */
export function templateFor(
  id: TemplateId,
  version: number | undefined,
): ReportTemplate {
  const current = REPORT_TEMPLATES[id]
  const wanted = version ?? 1
  if (wanted === current.version) return current
  return LEGACY_TEMPLATES[id]?.[wanted] ?? current
}

/**
 * The one way to read a template's structure. A template may declare numbered
 * `sections`, or the legacy flat `fields` list — every surface reads through
 * here so neither shape leaks into a renderer.
 */
export function sectionsOf(template: ReportTemplate): Array<SectionDef> {
  if (template.sections) return template.sections
  return [{ title: 'Details', fields: template.fields, implicit: true }]
}

/** Every field in document order, regardless of how the template groups them. */
export function fieldsOf(template: ReportTemplate): Array<FieldDef> {
  return sectionsOf(template).flatMap((section) => section.fields)
}

// v1-only by construction: it reads the v1 certificate's field keys.
export { durableNoticeText } from './legacy/termiteManagementCert.v1'
export { INSPECTION_AREAS } from './legacy/timberPestInspection.v1'
export { emptyAreas } from './shared'
export { isDataField } from './types'
export { printedGalleryKeys, sectionRuns } from './blocks'
export { coverFieldKeys, coverPhotoOf } from './cover'
export type { GalleryField, SectionRun, StaticBlockField } from './blocks'
export type {
  AreaResult,
  DataField,
  DataFieldKind,
  DerivedSource,
  FieldDef,
  FieldKind,
  CellDef,
  GpsValue,
  Option,
  RepeaterRow,
  RichBlock,
  RichDefinition,
  RichDoc,
  PrintSpec,
  Correction,
  SupersededString,
  OptionSetKey,
  RichListItem,
  RichMark,
  RichText,
  SignatureValue,
  SectionDef,
  ReportTemplate,
  TemplateId,
} from './types'

/**
 * The heading a section prints, which is not always the heading it is filled
 * in under: the screen shows the form's own numbered title, the document shows
 * what the client received. `null` means print none — read through here rather
 * than with `??`, because an explicit null and an absent key mean opposite
 * things.
 */
export function printsDurableNotice(template: ReportTemplate): boolean {
  // The durable notice is app-invented, not part of the AS 3660.2 form the
  // business issues. The v1 certificate always printed it, so every v1
  // certificate — signed or still a draft — keeps printing it exactly. The
  // verbatim certificate prints it only if a template opts in by name.
  return (
    template.id === 'termiteManagementCert' &&
    (template.version === 1 ||
      (template.features ?? []).includes('durableNotice'))
  )
}

export function printHeadingOf(section: SectionDef): string | null {
  if (section.print && 'heading' in section.print) {
    return section.print.heading ?? null
  }
  return section.title
}
