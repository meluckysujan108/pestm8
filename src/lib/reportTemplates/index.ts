import { termiteManagementCert } from './termiteManagementCert'
import { timberPestInspection } from './timberPestInspection'
import { serviceReport } from './serviceReport'
import { treatmentRecord } from './treatmentRecord'
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

export function getTemplate(id: TemplateId): ReportTemplate {
  return REPORT_TEMPLATES[id]
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

export { durableNoticeText } from './termiteManagementCert'
export { INSPECTION_AREAS } from './timberPestInspection'
export { emptyAreas } from './shared'
export type {
  AreaResult,
  FieldDef,
  FieldKind,
  CellDef,
  GpsValue,
  Option,
  RepeaterRow,
  SignatureValue,
  SectionDef,
  ReportTemplate,
  TemplateId,
} from './types'
