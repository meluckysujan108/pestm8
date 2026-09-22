import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { requireMembership } from './lib/access'
import { customTemplateSectionsSchema } from '../src/lib/reportTemplates/customTemplateSchema'
import {
  RETIRED_TEMPLATES,
  getTemplate,
  sectionsOf,
} from '../src/lib/reportTemplates'
import { hasCapability, requireActor, requireCapability } from './lib/actor'

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
    const env = await requireActor(ctx, args.businessId)
    requireCapability(env, 'templates.manage')
    const membership = env.actor.real

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
      updatedByMembershipId: membership._id,
      // Issued on creation: there is nothing to hold back from a form nobody
      // has edited yet, and "published version 1" is what every row that
      // predates this column already was.
      publishedVersion: 1,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    })
  },
})

/**
 * Keeps an edit without issuing it.
 *
 * Deliberately unvalidated. A form halfway through being edited is not a valid
 * form — a field whose key is still being typed, a condition pointing at a
 * question about to be added — and refusing to save it is how the editor came
 * to report "check your connection" about a connection that was fine. The
 * shape is checked at `publish`, which is the moment it starts to matter.
 */
export const saveDraft = mutation({
  args: {
    businessId: v.id('businesses'),
    templateId: v.id('customReportTemplates'),
    name: v.string(),
    shortName: v.string(),
    legalBasis: v.string(),
    blurb: v.string(),
    sections: v.any(),
    boilerplate: v.string(),
  },
  handler: async (ctx, { businessId, templateId, ...draft }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'templates.manage')
    const owner = env.actor.real
    const existing = await requireOwn(ctx, businessId, templateId)

    await ctx.db.patch(existing._id, {
      draft: { ...draft, savedAt: Date.now(), savedByMembershipId: owner._id },
      updatedAt: Date.now(),
      updatedByMembershipId: owner._id,
    })
  },
})

/**
 * Issues the draft: from here on, a new report is started against it.
 *
 * This is where the shape is checked, and where a refusal is worth making —
 * an owner is deciding to put this in front of their technicians, so a
 * structural problem is news rather than an interruption.
 */
export const publish = mutation({
  args: {
    businessId: v.id('businesses'),
    templateId: v.id('customReportTemplates'),
  },
  handler: async (ctx, { businessId, templateId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'templates.manage')
    const owner = env.actor.real
    const existing = await requireOwn(ctx, businessId, templateId)

    const draft = existing.draft
    if (!draft) throw new ConvexError('NOTHING_TO_PUBLISH')

    const parsed = customTemplateSectionsSchema.safeParse(draft.sections)
    if (!parsed.success) throw new ConvexError('INVALID_TEMPLATE')

    const version = (existing.publishedVersion ?? 1) + 1
    const now = Date.now()

    await ctx.db.patch(existing._id, {
      name: draft.name,
      shortName: draft.shortName,
      legalBasis: draft.legalBasis,
      blurb: draft.blurb,
      sections: parsed.data,
      boilerplate: draft.boilerplate,
      // Cleared, not kept: "published" and "has unpublished changes" are the
      // same question asked twice, and two records of it drift.
      draft: undefined,
      publishedVersion: version,
      publishedAt: now,
      updatedAt: now,
      updatedByMembershipId: owner._id,
    })

    await recordVersion(ctx, {
      businessId,
      templateId: existing._id,
      version,
      content: {
        name: draft.name,
        shortName: draft.shortName,
        legalBasis: draft.legalBasis,
        blurb: draft.blurb,
        sections: parsed.data,
        boilerplate: draft.boilerplate,
        terms: existing.terms,
        print: existing.print,
      },
      byMembershipId: owner._id,
      at: now,
    })

    return { version }
  },
})

/** Throws the edit away and goes back to what the business is issuing. */
export const discardDraft = mutation({
  args: {
    businessId: v.id('businesses'),
    templateId: v.id('customReportTemplates'),
  },
  handler: async (ctx, { businessId, templateId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'templates.manage')
    const owner = env.actor.real
    const existing = await requireOwn(ctx, businessId, templateId)
    if (!existing.draft) return

    await ctx.db.patch(existing._id, {
      draft: undefined,
      updatedAt: Date.now(),
      updatedByMembershipId: owner._id,
    })
  },
})

/** Every issue of this form, newest first. */
export const versions = query({
  args: {
    businessId: v.id('businesses'),
    templateId: v.id('customReportTemplates'),
  },
  handler: async (ctx, { businessId, templateId }) => {
    await requireMembership(ctx, businessId)

    const rows = await ctx.db
      .query('customReportTemplateVersions')
      .withIndex('by_template', (q) => q.eq('templateId', templateId))
      .order('desc')
      // Bounded: a list on a settings screen, not an audit export.
      .take(50)

    return rows
      .filter((row) => row.businessId === businessId)
      .map((row) => ({
        version: row.version,
        name: row.name,
        publishedAt: row.publishedAt,
        publishedByMembershipId: row.publishedByMembershipId,
        sections: (row.sections as Array<unknown>).length,
      }))
  },
})

/**
 * Appends an issue of this form to its history.
 *
 * Both paths that change what the business issues come through here —
 * `publish` and the direct `update` — so "what was this form saying in March?"
 * is answerable whichever one was used.
 */
async function recordVersion(
  ctx: MutationCtx,
  entry: {
    businessId: Id<'businesses'>
    templateId: Id<'customReportTemplates'>
    version: number
    content: {
      name: string
      shortName: string
      legalBasis: string
      blurb: string
      sections: unknown
      boilerplate: string
      terms?: unknown
      print?: Doc<'customReportTemplates'>['print']
    }
    byMembershipId: Id<'memberships'>
    at: number
  },
) {
  const { terms, print, ...content } = entry.content
  await ctx.db.insert('customReportTemplateVersions', {
    businessId: entry.businessId,
    templateId: entry.templateId,
    version: entry.version,
    ...content,
    ...(terms !== undefined ? { terms } : {}),
    ...(print !== undefined ? { print } : {}),
    publishedByMembershipId: entry.byMembershipId,
    publishedAt: entry.at,
  })
}

async function requireOwn(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  templateId: Id<'customReportTemplates'>,
) {
  const doc = await ctx.db.get(templateId)
  if (!doc || doc.businessId !== businessId) throw new ConvexError('NOT_FOUND')
  return doc
}

export const get = query({
  args: {
    businessId: v.id('businesses'),
    templateId: v.id('customReportTemplates'),
  },
  handler: async (ctx, { businessId, templateId }) => {
    // The draft is template administration: `templates.manage`, which a
    // switch drops, so an owner working inside a technician's account is
    // handed what that technician would be — the issued form.
    const canEdit = hasCapability(await requireActor(ctx, businessId), 'templates.manage')
    const doc = await ctx.db.get(templateId)
    if (!doc || doc.businessId !== businessId) return null

    // The draft is the owner's unissued work, so it is not handed to the
    // technicians who fill this form in — they get what the business issues,
    // which is everything else on the row.
    const { draft, ...published } = doc
    return {
      ...published,
      draft: canEdit ? draft : undefined,
      hasUnpublishedChanges: draft !== undefined,
      publishedVersion: doc.publishedVersion ?? 1,
    }
  },
})

/** Every custom template a business has authored, archived ones included —
 * the "start a new report" picker filters those out itself (Phase 6); the
 * template management list (Phase 4) needs to show them, badge and all. */
export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    const rows = await ctx.db
      .query('customReportTemplates')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .collect()
    // The owner's unissued draft is theirs until they issue it — the same rule
    // `get` applies, so the list cannot hand out what the detail withholds.
    // The flag survives, because "has unpublished changes" is worth a badge.
    return rows.map(({ draft, ...published }) => ({
      ...published,
      hasUnpublishedChanges: draft !== undefined,
    }))
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
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'templates.manage')
    const membership = env.actor.real
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
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'templates.manage')
    const membership = env.actor.real

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
    requireCapability(await requireActor(ctx, businessId), 'templates.manage')
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
    requireCapability(await requireActor(ctx, businessId), 'templates.manage')
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
    requireCapability(await requireActor(ctx, businessId), 'templates.manage')
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
 * reads the frozen copy `templateSnapshotId` points at and never this row
 * again — finalise refuses to lock a custom report it cannot freeze.
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
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'templates.manage')
    // The capability is dropped while switched, so this is the person.
    const owner = env.actor.real

    const existing = await ctx.db.get(templateId)
    if (!existing || existing.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    const now = Date.now()
    const version = (existing.publishedVersion ?? 1) + 1

    const patch: Record<string, unknown> = {
      ...rest,
      updatedAt: now,
      updatedByMembershipId: owner._id,
      publishedVersion: version,
      publishedAt: now,
    }
    if (sections !== undefined) {
      const parsed = customTemplateSectionsSchema.safeParse(sections)
      if (!parsed.success) throw new ConvexError('INVALID_TEMPLATE')
      patch.sections = parsed.data
    }

    await ctx.db.patch(templateId, patch)

    // This writes the PUBLISHED columns directly, so it issues a version of
    // the form just as `publish` does, and the history says so either way.
    const after = { ...existing, ...patch }
    await recordVersion(ctx, {
      businessId,
      templateId,
      version,
      content: {
        name: after.name,
        shortName: after.shortName,
        legalBasis: after.legalBasis,
        blurb: after.blurb,
        sections: after.sections,
        boilerplate: after.boilerplate,
        terms: after.terms,
        print: after.print,
      },
      byMembershipId: owner._id,
      at: now,
    })
  },
})
