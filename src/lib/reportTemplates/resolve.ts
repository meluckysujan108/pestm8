import { templateFor } from './index'
import { deriveGenericSchema } from './deriveSchema'
import { applyOptionSets } from './optionSets'
import type { OptionSetOverrides } from './optionSets'
import type {
  PrintSpec,
  ReportTemplate,
  RichDoc,
  SectionDef,
  TemplateId,
} from './types'

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
  version?: number
  terms?: RichDoc
  print?: PrintSpec
  features?: Array<'durableNotice'>
}

/**
 * A row from `reportTemplateSnapshots` as a renderer sees it. Structurally the
 * same printed fields as a live custom template plus the revision it froze,
 * so one merge path serves both — a Convex doc arrives with `_id`, `hash` and
 * the rest, which structural typing ignores.
 */
export type TemplateSnapshotShape = CustomTemplateShape

/**
 * The one place `report.template` turns into a renderable `ReportTemplate`.
 * `ReportTemplate.schema` is a live `z.ZodType` and cannot cross the Convex
 * wire, so a custom template's schema is always derived here, client-side,
 * from the JSON `sections` the server sent — never fetched pre-built.
 *
 * Runs in three runtimes — the browser, a Convex Node action (`email.ts`), and
 * inside the @react-pdf render tree — so it stays pure and synchronous. It can
 * never fetch a snapshot itself; `reports.get` hands one over inline.
 */
export function resolveReportTemplate(report: {
  template: TemplateId | 'custom'
  /**
   * The revision this report was written against. Absent means 1, which is
   * what every report created before revisions existed was written against.
   */
  templateVersion?: number
  customTemplate?: CustomTemplateShape | null
  /**
   * The wording this report was signed against. Present only for finalised
   * reports, and only once the backfill has run — a missing snapshot falls
   * back to the revision the report was written against, never to whatever is
   * current, so an unmigrated signed report shows its own wording rather than
   * a newer form's.
   */
  templateSnapshot?: TemplateSnapshotShape | null
  /**
   * The business's own option lists, applied to a report still being filled
   * in. Ignored whenever a snapshot is present: a signed document's lists were
   * frozen with its wording, and a later edit to the business's products must
   * not reorder or relabel them.
   */
  optionSets?: OptionSetOverrides | null
}): ReportTemplate {
  const snapshot = report.templateSnapshot

  if (report.template !== 'custom') {
    if (!snapshot) {
      return applyOptionSets(
        templateFor(report.template, report.templateVersion),
        report.optionSets,
      )
    }

    const version = snapshot.version ?? report.templateVersion ?? 1
    // Every printed key is named explicitly, from the snapshot. Spreading the
    // live module underneath would hand a v1 signed report the current
    // revision's `terms` and `print` for any key the v1 snapshot lacks — the
    // warranty pages of a form it was never issued under.
    return {
      id: report.template,
      version,
      name: snapshot.name,
      shortName: snapshot.shortName,
      legalBasis: snapshot.legalBasis,
      blurb: snapshot.blurb,
      // Emptied so `sectionsOf()` can only read the frozen sections.
      fields: [],
      sections: snapshot.sections,
      // The revision's own schema, never derived. A built-in's hand-written
      // Zod rules cannot be reconstructed from JSON sections. Safe to take from
      // code: `schema` runs only at the builder's finalise gate, on a draft; a
      // finalised report never revalidates.
      schema: templateFor(report.template, version).schema,
      boilerplate: snapshot.boilerplate,
      terms: snapshot.terms,
      print: snapshot.print,
      features: snapshot.features,
    }
  }

  // A signed custom report reads its frozen copy; a draft reads the live one.
  const frozen = snapshot ?? null
  const c = frozen ?? report.customTemplate
  if (!c) {
    throw new Error(
      "resolveReportTemplate: template is 'custom' but no customTemplate was supplied",
    )
  }

  const built: ReportTemplate = {
    id: 'custom',
    version: typeof c.version === 'number' ? c.version : 1,
    name: c.name,
    shortName: c.shortName,
    legalBasis: c.legalBasis,
    blurb: c.blurb,
    fields: [],
    sections: c.sections,
    schema: deriveGenericSchema(c.sections),
    boilerplate: c.boilerplate,
    terms: c.terms,
    print: c.print,
    features: c.features,
  }
  if (frozen) return built

  const overlaid = applyOptionSets(built, report.optionSets)
  return overlaid === built
    ? built
    : { ...overlaid, schema: deriveGenericSchema(overlaid.sections ?? []) }
}
