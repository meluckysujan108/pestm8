import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership, requireOwner } from './lib/access'
import type { TemplateSettings } from '../src/lib/reportTemplates/settings'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'

/**
 * What a business may change about a form it did not write.
 *
 * Owner-gated, deliberately narrow, and structural changes are still a clone:
 * the point of this table is that a business can put its own cover wording on
 * a Pest M8 form WITHOUT forking the wording it is required to reproduce, and
 * so keep receiving corrections to it.
 */

/** Every form's settings, for the templates page. */
export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    const rows = await ctx.db
      .query('templateSettings')
      .withIndex('by_business_template', (q) => q.eq('businessId', businessId))
      .collect()
    return rows.map(project)
  },
})

/**
 * One form's settings, as the resolver wants them.
 *
 * Returns `null` rather than an empty object when nothing has been set, so a
 * caller can tell "this business has never touched this form" from "this
 * business cleared everything".
 */
export async function settingsFor(
  ctx: QueryCtx | MutationCtx,
  businessId: Id<'businesses'>,
  templateRef: string,
): Promise<TemplateSettings | null> {
  const row = await ctx.db
    .query('templateSettings')
    .withIndex('by_business_template', (q) =>
      q.eq('businessId', businessId).eq('templateRef', templateRef),
    )
    .unique()
  return row ? project(row) : null
}

export const get = query({
  args: { businessId: v.id('businesses'), templateRef: v.string() },
  handler: async (ctx, { businessId, templateRef }) => {
    await requireMembership(ctx, businessId)
    return settingsFor(ctx, businessId, templateRef)
  },
})

/**
 * Sets them, or clears them.
 *
 * Every field is optional and an explicitly empty string clears that override
 * rather than printing an empty cover title — a blank is how a business says
 * "use the form's own words again".
 */
export const set = mutation({
  args: {
    businessId: v.id('businesses'),
    templateRef: v.string(),
    coverTitle: v.optional(v.string()),
    coverSubtitle: v.optional(v.string()),
    formName: v.optional(v.string()),
    requiredSigners: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { businessId, templateRef, ...fields }) => {
    const owner = await requireOwner(ctx, businessId)

    const print = {
      ...(trimmed(fields.formName) ? { formName: trimmed(fields.formName) } : {}),
      ...(trimmed(fields.coverTitle) || trimmed(fields.coverSubtitle)
        ? {
            cover: {
              ...(trimmed(fields.coverTitle)
                ? { title: trimmed(fields.coverTitle) }
                : {}),
              ...(trimmed(fields.coverSubtitle)
                ? { subtitle: trimmed(fields.coverSubtitle) }
                : {}),
            },
          }
        : {}),
    }

    const patch = {
      businessId,
      templateRef,
      ...(Object.keys(print).length > 0 ? { print } : { print: undefined }),
      ...(fields.requiredSigners
        ? { requiredSigners: fields.requiredSigners }
        : { requiredSigners: undefined }),
      updatedByMembershipId: owner._id,
      updatedAt: Date.now(),
    }

    const existing = await ctx.db
      .query('templateSettings')
      .withIndex('by_business_template', (q) =>
        q.eq('businessId', businessId).eq('templateRef', templateRef),
      )
      .unique()

    if (existing) await ctx.db.patch(existing._id, patch)
    else await ctx.db.insert('templateSettings', patch)
  },
})

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text === undefined || text === '' ? undefined : text
}

function project(row: Doc<'templateSettings'>): TemplateSettings & {
  templateRef: string
} {
  return {
    templateRef: row.templateRef,
    print: row.print,
    requiredSigners: row.requiredSigners,
  }
}
