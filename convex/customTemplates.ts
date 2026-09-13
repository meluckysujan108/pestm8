import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership, requireOwner } from './lib/access'
import { customTemplateSectionsSchema } from '../src/lib/reportTemplates/customTemplateSchema'
import {
  RETIRED_TEMPLATES,
  getTemplate,
  sectionsOf,
} from '../src/lib/reportTemplates'

/** The 4 built-in ids — never `'custom'`, which only ever names a *resolved*
 * template, not a source one to clone from. */
const builtinTemplateId = v.union(
  v.literal('treatmentRecord'),
  v.literal('timberPestInspection'),
  v.literal('termiteManagementCert'),
  v.literal('serviceReport'),
)

/**
 * Business-authored report templates — the runtime, per-tenant sibling of
 * the 4 hardcoded ones in `src/lib/reportTemplates`. Every write here is
 * owner-gated, like every other business-policy change in this app
 * (`TeamSection`, branding) — authoring a template the whole business will
 * fill in and finalise against is not a per-technician call.
 */
export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    name: v.string(),
    shortName: v.string(),
    legalBasis: v.string(),
    blurb: v.string(),
    sections: v.any(),
    boilerplate: v.string(),
  },
  handler: async (ctx, args) => {
    const membership = await requireOwner(ctx, args.businessId)

    // `sections` is `v.any()` on the wire (see `customReportTemplates`'s own
    // schema comment) — this is the edge that actually enforces its shape.
    const parsed = customTemplateSectionsSchema.safeParse(args.sections)
    if (!parsed.success) throw new ConvexError('INVALID_TEMPLATE')

    const now = Date.now()
    return ctx.db.insert('customReportTemplates', {
      businessId: args.businessId,
      name: args.name,
      shortName: args.shortName,
      legalBasis: args.legalBasis,
      blurb: args.blurb,
      sections: parsed.data,
      boilerplate: args.boilerplate,
      createdByMembershipId: membership._id,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const get = query({
  args: {
    businessId: v.id('businesses'),
    templateId: v.id('customReportTemplates'),
  },
  handler: async (ctx, { businessId, templateId }) => {
    await requireMembership(ctx, businessId)
    const doc = await ctx.db.get(templateId)
    if (!doc || doc.businessId !== businessId) return null
    return doc
  },
})

/** Every custom template a business has authored, archived ones included —
 * the "start a new report" picker filters those out itself (Phase 6); the
 * template management list (Phase 4) needs to show them, badge and all. */
export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    return ctx.db
      .query('customReportTemplates')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .collect()
  },
})

/**
 * "Editing" a built-in never happens in place — the 4 `.ts` files never
 * change, and a report already finalised against one must keep meaning what
 * it always meant. Cloning copies its current shape into a fresh row here,
 * which the business can then freely tweak via `update`.
 */
export const cloneBuiltin = mutation({
  args: {
    businessId: v.id('businesses'),
    sourceTemplateId: builtinTemplateId,
    name: v.string(),
  },
  handler: async (ctx, { businessId, sourceTemplateId, name }) => {
    const membership = await requireOwner(ctx, businessId)
    if (RETIRED_TEMPLATES.has(sourceTemplateId)) {
      throw new ConvexError('TEMPLATE_RETIRED')
    }
    const source = getTemplate(sourceTemplateId)

    const now = Date.now()
    return ctx.db.insert('customReportTemplates', {
      businessId,
      name,
      shortName: source.shortName,
      legalBasis: source.legalBasis,
      blurb: source.blurb,
      // Normalised through `sectionsOf()` so a flat-`fields` built-in (the
      // retired Treatment Record is one) clones the same shape every other
      // surface already reads via that function.
      sections: sectionsOf(source),
      boilerplate: source.boilerplate,
      // A verbatim built-in prints its warranty or terms from `terms`, with an
      // empty `boilerplate` — without these a clone would silently lose them.
      terms: source.terms,
      print: source.print,
      createdByMembershipId: membership._id,
      createdAt: now,
      updatedAt: now,
    })
  },
})

/** Copies an existing *custom* template into a second, independent one —
 * unlike `cloneBuiltin`, both ends of this are rows in this table. */
export const duplicate = mutation({
  args: {
    businessId: v.id('businesses'),
    templateId: v.id('customReportTemplates'),
    name: v.string(),
  },
  handler: async (ctx, { businessId, templateId, name }) => {
    const membership = await requireOwner(ctx, businessId)

    const source = await ctx.db.get(templateId)
    if (!source || source.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    const now = Date.now()
    return ctx.db.insert('customReportTemplates', {
      businessId,
      name,
      shortName: source.shortName,
      legalBasis: source.legalBasis,
      blurb: source.blurb,
      sections: source.sections,
      boilerplate: source.boilerplate,
      terms: source.terms,
      print: source.print,
      createdByMembershipId: membership._id,
      createdAt: now,
      updatedAt: now,
    })
  },
})

/** Removes it from the "start a new report" picker only — has zero effect
 * on any report already referencing it, draft or finalised. */
export const archive = mutation({
  args: { businessId: v.id('businesses'), templateId: v.id('customReportTemplates') },
  handler: async (ctx, { businessId, templateId }) => {
    await requireOwner(ctx, businessId)
    const existing = await ctx.db.get(templateId)
    if (!existing || existing.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    await ctx.db.patch(templateId, { archivedAt: Date.now(), updatedAt: Date.now() })
  },
})

export const unarchive = mutation({
  args: { businessId: v.id('businesses'), templateId: v.id('customReportTemplates') },
  handler: async (ctx, { businessId, templateId }) => {
    await requireOwner(ctx, businessId)
    const existing = await ctx.db.get(templateId)
    if (!existing || existing.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    await ctx.db.patch(templateId, { archivedAt: undefined, updatedAt: Date.now() })
  },
})

/**
 * Hard-deletes only when nothing depends on it — the moment even one report
 * (draft or finalised) points at this template via `customTemplateId`,
 * deleting the row would corrupt that report's ability to ever resolve its
 * own shape again, since a draft reads it live. `archive` is the offer in
 * that case, mirroring how `memberships.status` never hard-deletes
 * (`'removed'` instead) and `recurrences.active` stops future work without
 * erasing history.
 */
export const remove = mutation({
  args: { businessId: v.id('businesses'), templateId: v.id('customReportTemplates') },
  handler: async (ctx, { businessId, templateId }) => {
    await requireOwner(ctx, businessId)
    const existing = await ctx.db.get(templateId)
    if (!existing || existing.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    const inUse = await ctx.db
      .query('reports')
      .withIndex('by_custom_template', (q) => q.eq('customTemplateId', templateId))
      .first()
    if (inUse) throw new ConvexError('TEMPLATE_IN_USE')

    await ctx.db.delete(templateId)
  },
})

/**
 * Edits the live template in place — never the report side of the
 * "clone don't edit" rule, which is about the 4 *built-in* `.ts` files.
 * `reports.get`/`reports.finalise` are what stop this from ever mutating a
 * document already signed: a draft rereads this doc live, a finalised report
 * reads its own frozen `customTemplateSnapshot` and never this row again.
 *
 * Full CRUD (duplicate, archive, remove) is Phase 3; `update` exists now
 * because Phase 2's own verification requires editing a live template to
 * prove the draft/finalised split actually holds.
 */
export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    templateId: v.id('customReportTemplates'),
    name: v.optional(v.string()),
    shortName: v.optional(v.string()),
    legalBasis: v.optional(v.string()),
    blurb: v.optional(v.string()),
    sections: v.optional(v.any()),
    boilerplate: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, templateId, sections, ...rest }) => {
    await requireOwner(ctx, businessId)

    const existing = await ctx.db.get(templateId)
    if (!existing || existing.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    const patch: Record<string, unknown> = { ...rest, updatedAt: Date.now() }
    if (sections !== undefined) {
      const parsed = customTemplateSectionsSchema.safeParse(sections)
      if (!parsed.success) throw new ConvexError('INVALID_TEMPLATE')
      patch.sections = parsed.data
    }

    await ctx.db.patch(templateId, patch)
  },
})
