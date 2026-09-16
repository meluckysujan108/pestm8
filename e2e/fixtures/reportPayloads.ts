import { expect } from '@playwright/test'
import { api } from '../fixtures'
import { getTemplate, sectionsOf } from '../../src/lib/reportTemplates'
import { sectionKey } from '../../src/lib/reportTemplates/progress'
import type { SectionDef } from '../../src/lib/reportTemplates'
import type { Page } from '@playwright/test'
import type { ConvexHttpClient } from 'convex/browser'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * One place that knows the argument shape of `reports.create` and what a report
 * needs to be finalisable.
 *
 * Every spec used to inline both. That made two later changes disproportionately
 * expensive: `create` gains server-side prefill (so `legalBasis` and `data` stop
 * being the caller's job), and `finalise` gains server-side validation (so the
 * `{ safeToStart: true, treatments: [] }` stub stops passing). Routing all of it
 * through here makes each of those a one-file edit instead of forty.
 */

type Ids = {
  businessId: Id<'businesses'>
  propertyId: Id<'properties'>
  jobId?: Id<'jobs'>
}

/**
 * The built-in templates a spec can start a report against. Narrowed to the
 * creatable ones: `treatmentRecord` is retired and `reports.create` refuses it,
 * so leaving it in this type would let a spec compile and fail at setup.
 */
export type TemplateId =
  | 'serviceReport'
  | 'timberPestInspection'
  | 'termiteManagementCert'

export async function createReport(
  client: ConvexHttpClient,
  ids: Ids,
  template: TemplateId,
  data: Record<string, unknown> = {},
) {
  return client.mutation(api.reports.create, {
    businessId: ids.businessId,
    propertyId: ids.propertyId,
    ...(ids.jobId ? { jobId: ids.jobId } : {}),
    template,
    // Read from the template rather than hard-coded, so a template's filing tag
    // cannot drift away from what the specs create.
    legalBasis: getTemplate(template).legalBasis,
    data,
  })
}

export async function createCustomReport(
  client: ConvexHttpClient,
  ids: Ids,
  customTemplateId: Id<'customReportTemplates'>,
  legalBasis = 'Internal',
  data: Record<string, unknown> = {},
) {
  return client.mutation(api.reports.create, {
    businessId: ids.businessId,
    propertyId: ids.propertyId,
    ...(ids.jobId ? { jobId: ids.jobId } : {}),
    template: 'custom',
    customTemplateId,
    legalBasis,
    data,
  })
}

/**
 * The revision a newly created built-in report is written against — what every
 * write to it must declare. The server refuses a write shaped for a different
 * revision (`TEMPLATE_VERSION_MISMATCH`), which is how a stale browser tab is
 * stopped from saving old answers into a new form.
 */
export function versionOf(template: TemplateId): number {
  return getTemplate(template).version
}

/**
 * A payload each built-in will accept at finalise, in the verbatim forms' own
 * keys and words (every stored answer is the string it prints).
 *
 * `addPhotos` matters on the Service Report: its "Report Photos" section only
 * shows while "Add Photos?" is Yes, and `finalise` replaces the answers
 * wholesale, so a payload without it would hide photos a spec just uploaded.
 */
export const FINALISE: Record<TemplateId, Record<string, unknown>> = {
  serviceReport: {
    serviceDate: '2026-08-28',
    safeToStart: true,
    treatments: [],
    addPhotos: true,
  },
  timberPestInspection: {
    inspectionDate: '2026-08-28',
    clientAgreesToInspection: 'Yes',
    inspectionTypeWarranty: [
      '12 Monthly Timber Pest Visual Inspection to maintain Warranty',
      'Year 1',
    ],
  },
  termiteManagementCert: {
    installDate: '2026-08-28',
    systemType: 'Chemical Soil Barrier',
    product: 'Termidor HE',
    activeConstituent: 'Fipronil 100g/L',
    reinspectionInterval: '12 months',
    durableNoticeFitted: 'Yes',
  },
}

export async function finaliseReport(
  client: ConvexHttpClient,
  ids: Pick<Ids, 'businessId'>,
  reportId: Id<'reports'>,
  template: TemplateId,
  overrides: Record<string, unknown> = {},
) {
  return client.mutation(api.reports.finalise, {
    businessId: ids.businessId,
    reportId,
    data: { ...FINALISE[template], ...overrides },
    templateVersion: versionOf(template),
  })
}

/** Save a draft of a built-in report, declaring the revision it was written against. */
export async function saveReportDraft(
  client: ConvexHttpClient,
  ids: Pick<Ids, 'businessId'>,
  reportId: Id<'reports'>,
  template: TemplateId,
  data: Record<string, unknown>,
) {
  return client.mutation(api.reports.saveDraft, {
    businessId: ids.businessId,
    reportId,
    data,
    templateVersion: versionOf(template),
  })
}

/**
 * A small business-authored template, for the behaviour no verbatim form has:
 * the area-by-area checklist with its no-access reason, and fixed photo slots.
 * Those kinds still exist for custom templates; the built-ins that used them
 * were paraphrases of forms the business never issued.
 */
/**
 * Waits until the builder can actually be used.
 *
 * The report page is server-rendered, so a tap before hydration is dropped —
 * and `setInputFiles` does not even check. The footer marks itself ready, which
 * is true on every screen of the fill flow, unlike any one button's label.
 */
export async function builderReady(page: Page) {
  await expect(page.locator('[data-report-footer][data-ready="true"]')).toBeVisible()
}

/**
 * The URL of the section a field lives in.
 *
 * A report is filled a section at a time, so a spec that wants one control has
 * to open the screen it is on. Derived from the template rather than written
 * out, so a form reordered tomorrow does not quietly send a spec to the wrong
 * screen — it sends it to the right one.
 */
export function sectionUrl(
  slug: string,
  reportId: Id<'reports'>,
  template: TemplateId,
  fieldKey: string,
): string {
  const sections = sectionsOf(getTemplate(template))
  const index = sections.findIndex((section) =>
    section.fields.some((field) => field.key === fieldKey),
  )
  if (index === -1) throw new Error(`No section holds the field ${fieldKey}`)
  return `/${slug}/reports/${reportId}?s=${sectionKey(sections[index], index)}`
}

/**
 * The first section of a business-authored template, which has no declared id
 * and so is addressed positionally.
 */
export function customSectionUrl(slug: string, reportId: Id<'reports'>, index = 0): string {
  return `/${slug}/reports/${reportId}?s=s${index + 1}`
}

export function customTemplateArgs(
  overrides: Partial<{ name: string; sections: Array<SectionDef> }> = {},
) {
  return {
    name: overrides.name ?? 'Site Walkthrough',
    shortName: 'Walkthrough',
    legalBasis: 'Internal',
    blurb: 'A quick custom walkthrough form.',
    sections: overrides.sections ?? [
      {
        number: 1,
        title: 'Inspection',
        fields: [
          {
            kind: 'areas' as const,
            key: 'areas',
            label: 'Areas inspected',
            rows: ['Roof void', 'Subfloor', 'Interior'],
          },
          {
            kind: 'photos' as const,
            key: 'photos',
            label: 'Photos',
            slots: ['Before', 'After'],
          },
          { kind: 'text' as const, key: 'product', label: 'Product' },
        ],
      },
    ],
    boilerplate: 'This is not a statutory document.',
  }
}
