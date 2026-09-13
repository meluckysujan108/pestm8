import { ConvexError } from 'convex/values'
import { defaultOptionSet } from '../../src/lib/reportTemplates/optionLibraries'
import { sectionsOf, templateFor } from '../../src/lib/reportTemplates'
import {
  boundPaths,
  renameInData,
} from '../../src/lib/reportTemplates/optionSets'
import type { OptionSetOverrides } from '../../src/lib/reportTemplates/optionSets'
import type { OptionSetKey, SectionDef } from '../../src/lib/reportTemplates'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/** How many vocabularies exist — the most rows one business can have. */
const OPTION_SET_KEY_COUNT = 19

/**
 * A business's own lists, projected to exactly what a template carries.
 *
 * The projection is the point: anything else on the row (the rename log,
 * bookkeeping) must never reach a template, because the template is hashed
 * into a snapshot at finalise and extra fields would mint a new snapshot row
 * for a change that prints nothing.
 *
 * No rows means an empty overlay — the verbatim defaults — which is where
 * every business starts.
 */
export async function loadOverrides(
  ctx: QueryCtx | MutationCtx,
  businessId: Id<'businesses'>,
): Promise<OptionSetOverrides> {
  const rows = await ctx.db
    .query('optionSets')
    .withIndex('by_business_key', (q) => q.eq('businessId', businessId))
    .take(OPTION_SET_KEY_COUNT)
  const overrides: OptionSetOverrides = {}
  for (const row of rows) {
    overrides[row.key] = row.options.map((o) => ({
      value: o.value,
      label: o.label,
    }))
  }
  return overrides
}

/**
 * The business's row for a vocabulary, seeded from the verbatim defaults the
 * first time an owner edits it. Mutations only — a query cannot write, and a
 * read with no row already resolves to the defaults.
 */
export async function ensureRow(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  key: OptionSetKey,
  membershipId: Id<'memberships'>,
): Promise<Doc<'optionSets'>> {
  const existing = await ctx.db
    .query('optionSets')
    .withIndex('by_business_key', (q) =>
      q.eq('businessId', businessId).eq('key', key),
    )
    .unique()
  if (existing) return existing

  const defaults = defaultOptionSet(key)
  if (!defaults) throw new ConvexError('NOT_FOUND')

  const id = await ctx.db.insert('optionSets', {
    businessId,
    key,
    options: defaults.options.map((o) => ({ value: o.value, label: o.label })),
    renames: [],
    seedVersion: defaults.version,
    updatedAt: Date.now(),
    updatedByMembershipId: membershipId,
  })
  const row = await ctx.db.get(id)
  if (!row) throw new ConvexError('NOT_FOUND')
  return row
}

/** The most custom templates a rename's pinned-value check will read. */
export const MAX_TEMPLATES_SCANNED = 1000
/** The most open drafts one rename will rewrite in its transaction. */
export const MAX_DRAFTS_REWRITTEN = 500

async function sectionsOfReport(
  ctx: MutationCtx,
  report: Doc<'reports'>,
): Promise<Array<SectionDef> | null> {
  if (report.template !== 'custom') {
    // The revision this draft was written against: a v1 draft's module has no
    // business vocabularies at all, so a rename passes it by untouched.
    return sectionsOf(templateFor(report.template, report.templateVersion))
  }
  if (!report.customTemplateId) return null
  const custom = await ctx.db.get(report.customTemplateId)
  return custom ? ((custom.sections ?? []) as Array<SectionDef>) : null
}

/**
 * Rewrite every open draft of a business that chose `from` for a field bound
 * to `key`. Returns how many drafts changed.
 *
 * Only drafts: finalised reports carry a frozen copy of the list. Soft-deleted
 * drafts are left alone. Each changed draft gets its own audit row, because it
 * is another member's report edited on the owner's authority.
 */
export async function rewriteDraftsForRename(
  ctx: MutationCtx,
  args: {
    businessId: Id<'businesses'>
    key: OptionSetKey
    from: string
    to: string
    actorMembershipId: Id<'memberships'>
  },
): Promise<number> {
  const drafts = await ctx.db
    .query('reports')
    .withIndex('by_business_status_template', (q) =>
      q.eq('businessId', args.businessId).eq('status', 'draft'),
    )
    .take(MAX_DRAFTS_REWRITTEN + 1)
  if (drafts.length > MAX_DRAFTS_REWRITTEN) {
    throw new ConvexError('TOO_MANY_DRAFTS')
  }

  let rewritten = 0
  const now = Date.now()
  for (const report of drafts) {
    if (report.deletedAt !== undefined) continue
    const sections = await sectionsOfReport(ctx, report)
    if (!sections) continue
    const { data, changed } = renameInData(
      (report.data ?? {}) as Record<string, unknown>,
      boundPaths(sections, args.key),
      args.from,
      args.to,
    )
    if (!changed) continue
    await ctx.db.patch(report._id, { data })
    await ctx.db.insert('auditLog', {
      businessId: args.businessId,
      actorMembershipId: args.actorMembershipId,
      action: 'report.optionRenamed',
      entityType: 'reports',
      entityId: report._id,
      meta: { key: args.key, from: args.from, to: args.to },
      at: now,
    })
    rewritten += 1
  }
  return rewritten
}

/**
 * Carry a business's own renames onto answers that were just written in the
 * verbatim defaults' words — the switch of a v1 draft to the new form. Applied
 * in the order the owner made them, per vocabulary, so a product the business
 * renamed prints under the name it uses rather than the default it replaced.
 */
export async function applyBusinessRenames(
  ctx: QueryCtx | MutationCtx,
  businessId: Id<'businesses'>,
  sections: Array<SectionDef>,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rows = await ctx.db
    .query('optionSets')
    .withIndex('by_business_key', (q) => q.eq('businessId', businessId))
    .take(OPTION_SET_KEY_COUNT)
  let next = data
  for (const row of rows) {
    const paths = boundPaths(sections, row.key)
    for (const rename of row.renames) {
      next = renameInData(next, paths, rename.from, rename.to).data
    }
  }
  return next
}
