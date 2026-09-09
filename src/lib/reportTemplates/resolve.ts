import { getTemplate } from './index'
import { deriveGenericSchema } from './deriveSchema'
import type { ReportTemplate, SectionDef, TemplateId } from './types'

/** What every render surface needs from a business-authored template. Shaped
 * to match `customReportTemplates` (minus the Convex-only bookkeeping
 * fields), so a live doc or a frozen `customTemplateSnapshot` both fit. */
export type CustomTemplateShape = {
  name: string
  shortName: string
  legalBasis: string
  blurb: string
  sections: Array<SectionDef>
  boilerplate: string
}

/**
 * The one place `report.template` turns into a renderable `ReportTemplate`.
 * `ReportTemplate.schema` is a live `z.ZodType` and cannot cross the Convex
 * wire, so a custom template's schema is always derived here, client-side,
 * from the JSON `sections` the server sent — never fetched pre-built.
 */
export function resolveReportTemplate(report: {
  template: TemplateId | 'custom'
  customTemplate?: CustomTemplateShape | null
}): ReportTemplate {
  if (report.template !== 'custom') return getTemplate(report.template)

  const c = report.customTemplate
  if (!c) {
    throw new Error(
      "resolveReportTemplate: template is 'custom' but no customTemplate was supplied",
    )
  }

  return {
    id: 'custom',
    name: c.name,
    shortName: c.shortName,
    legalBasis: c.legalBasis,
    blurb: c.blurb,
    fields: [],
    sections: c.sections,
    schema: deriveGenericSchema(c.sections),
    boilerplate: c.boilerplate,
  }
}
