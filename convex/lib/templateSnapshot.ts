import {
  canonicalise,
  hashSnapshot,
  snapshotOf,
} from '../../src/lib/reportTemplates/snapshot'
import { templateFor } from '../../src/lib/reportTemplates'
import { applyOptionSets } from '../../src/lib/reportTemplates/optionSets'
import type { TemplateSnapshotContent } from '../../src/lib/reportTemplates/snapshot'
import { loadOverrides } from './optionSets'
import type { PrintSpec, RichDoc, SectionDef } from '../../src/lib/reportTemplates'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * Freezes the wording a report was signed against, and returns the row every
 * report with that same wording shares.
 *
 * The one writer. `finalise` and the backfill migration both come through here
 * so they cannot mint different rows for identical content — and the hash is
 * over a canonical, key-sorted string precisely because those two callers see
 * the same template from opposite directions: one from a module literal, whose
 * keys are in declaration order, and one from a Convex read, which returns
 * them sorted.
 */
export async function freezeTemplate(
  ctx: MutationCtx,
  report: Doc<'reports'>,
  sources: { custom?: CustomSource } = {},
): Promise<Id<'reportTemplateSnapshots'> | undefined> {
  try {
    const content = await contentFor(ctx, report, sources.custom)
    if (!content) return undefined
    return await upsertSnapshot(ctx, content)
  } catch (error) {
    // A snapshot is protection, not a precondition. If hashing or the lookup
    // fails, the technician still gets to lock the document they just signed —
    // the alternative is a report stuck in draft on a phone in someone's
    // driveway.
    //
    // Logged rather than swallowed: silence here looks identical to success,
    // and the only other detector is a migration query someone has to remember
    // to run. The invariant still counts the row; this says why.
    console.error(
      `freezeTemplate failed for report ${report._id} (${report.template})`,
      error,
    )
    return undefined
  }
}

export type CustomSource = {
  name: string
  shortName: string
  legalBasis: string
  blurb: string
  sections: unknown
  boilerplate: string
  terms?: unknown
  print?: PrintSpec
}

async function contentFor(
  ctx: MutationCtx,
  report: Doc<'reports'>,
  custom?: CustomSource,
): Promise<TemplateSnapshotContent | undefined> {
  if (report.template !== 'custom') {
    // The revision this report was WRITTEN against, never the current module.
    // A v1 draft finalised after the verbatim rewrite must freeze v1 wording
    // over its v1 answers, and the backfill must freeze v1 whichever side of
    // the rewrite it runs on.
    //
    // Through `snapshotOf`, which normalises via `sectionsOf()` — the v1
    // built-ins declare a flat `fields` list, and the synthetic "Details"
    // wrapper that function adds is printed output, not plumbing.
    const template = templateFor(report.template, report.templateVersion)
    return snapshotOf(applyOptionSets(template, await overridesFor(ctx, report)))
  }

  // The inline copy first — it is what this report has been rendering from all
  // along. The live doc is a deliberate last resort, not the normal path: it
  // may have moved on since the report was signed, but a report with no inline
  // copy cannot be opened at all today (`resolveReportTemplate` throws on a
  // null custom template), so slightly-drifted wording is strictly better than
  // an unopenable page. Rare by construction — every finalised custom report on
  // dev carries an inline copy.
  const source =
    custom ??
    (report.customTemplateId
      ? ((await ctx.db.get(report.customTemplateId)) ?? undefined)
      : undefined)
  if (!source) return undefined

  // With the business's own lists applied, exactly as the draft showed them —
  // otherwise the signed custom report froze a different list than the one the
  // technician chose from.
  const overlaid = applyOptionSets(
    {
      id: 'custom',
      version: report.templateVersion ?? 1,
      name: source.name,
      shortName: source.shortName,
      legalBasis: source.legalBasis,
      blurb: source.blurb,
      fields: [],
      // Already normalised: `customTemplates.create` validates `sections` at
      // the edge and `cloneBuiltin` writes `sectionsOf(source)`.
      sections: source.sections as Array<SectionDef>,
      schema: undefined as never,
      boilerplate: source.boilerplate,
    },
    await overridesFor(ctx, report),
  )

  return {
    template: 'custom',
    version: report.templateVersion ?? 1,
    name: source.name,
    shortName: source.shortName,
    legalBasis: source.legalBasis,
    blurb: source.blurb,
    sections: overlaid.sections ?? [],
    boilerplate: source.boilerplate,
    terms: source.terms as RichDoc | undefined,
    print: source.print,
  }
}

/**
 * The business's own option lists, frozen into the snapshot alongside the
 * wording. Kept behind a function so a deployment without the table's rows
 * resolves to the verbatim defaults and hashes exactly as before.
 */
async function overridesFor(
  ctx: MutationCtx,
  report: Doc<'reports'>,
) {
  return loadOverrides(ctx, report.businessId)
}

/** Insert, or reuse the row that already holds exactly this content. */
export async function upsertSnapshot(
  ctx: MutationCtx,
  content: TemplateSnapshotContent,
): Promise<Id<'reportTemplateSnapshots'>> {
  const hash = hashSnapshot(content)
  const existing = await ctx.db
    .query('reportTemplateSnapshots')
    .withIndex('by_hash', (q) => q.eq('hash', hash))
    .collect()

  for (const row of existing) {
    // A hash hit is not proof. Comparing the canonical strings makes a
    // collision cost one extra row rather than the wrong wording on a signed
    // document.
    if (canonicalise(rowContent(row)) === canonicalise(content)) return row._id
  }

  return await ctx.db.insert('reportTemplateSnapshots', {
    hash,
    template: content.template,
    version: content.version,
    name: content.name,
    shortName: content.shortName,
    legalBasis: content.legalBasis,
    blurb: content.blurb,
    sections: content.sections,
    boilerplate: content.boilerplate,
    terms: content.terms,
    print: content.print,
    features: content.features,
    createdAt: Date.now(),
  })
}

function rowContent(row: Doc<'reportTemplateSnapshots'>): TemplateSnapshotContent {
  return {
    template: row.template,
    version: row.version,
    name: row.name,
    shortName: row.shortName,
    legalBasis: row.legalBasis,
    blurb: row.blurb,
    sections: row.sections,
    boilerplate: row.boilerplate,
    // Without these the canonical compare never matches a verbatim template's
    // content, and every finalise would insert a fresh duplicate row with
    // nothing reporting it except the row count climbing.
    terms: row.terms as RichDoc | undefined,
    print: row.print,
    features: row.features,
  }
}
