import { termiteManagementCert } from './termiteManagementCert'
import { timberPestInspection } from './timberPestInspection'
import { treatmentRecord } from './treatmentRecord'
import type { ReportTemplate, TemplateId } from './types'

export const REPORT_TEMPLATES: Record<TemplateId, ReportTemplate> = {
  treatmentRecord,
  timberPestInspection,
  termiteManagementCert,
}

export const TEMPLATE_LIST: Array<ReportTemplate> = [
  treatmentRecord,
  timberPestInspection,
  termiteManagementCert,
]

export function getTemplate(id: TemplateId): ReportTemplate {
  return REPORT_TEMPLATES[id]
}

export { durableNoticeText } from './termiteManagementCert'
export { INSPECTION_AREAS } from './timberPestInspection'
export { emptyAreas } from './shared'
export type { AreaResult, FieldDef, ReportTemplate, TemplateId } from './types'
