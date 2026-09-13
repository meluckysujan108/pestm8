import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership, requireOwner } from './lib/access'
import {
  MAX_TEMPLATES_SCANNED,
  ensureRow,
  loadOverrides,
  rewriteDraftsForRename,
} from './lib/optionSets'
import { optionSetKey } from './schema'
import { REPORT_TEMPLATES, sectionsOf } from '../src/lib/reportTemplates'
import {
  MAX_OPTION_LENGTH,
  MAX_RENAMES,
} from '../src/lib/reportTemplates/optionLibraries'
import { pinnedValues } from '../src/lib/reportTemplates/optionSets'
import type { SectionDef } from '../src/lib/reportTemplates'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

/**
 * Per-business option libraries: the vocabularies a business owns and its
 * reports print — its products, the treatments it offers.
 *
 * Phase 2 ships the mechanism: resolution (defaults, or the business's own
 * list) and renaming an option across open drafts. Adding, archiving and
 * reordering land with the settings screen that needs them.
 */

/** The business's own lists. Any member: technicians fill reports from them. */
export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    return loadOverrides(ctx, businessId)
  },
})

/**
 * Rename one option in a business vocabulary, and rewrite every open draft that
 * already chose it — in the same transaction.
 *
 * Inline, not scheduled. Rewrite jobs run in no guaranteed order, and renames
 * can chain: rename A to B, then C to A, and a late A-to-B job can no longer
 * tell an original A from a C that was renamed a moment ago, so it folds both
 * into B. Rewriting inside the rename's own transaction makes the order the
 * order the owner tapped. A business's open drafts are few; the bound fails
 * closed with a clear error rather than half-applying.
 *
 * Owner only: a vocabulary prints on every technician's signed documents, so
 * changing it is business policy. Finalised reports are never touched — they
 * carry their own frozen copy of the list inside their template snapshot.
 *
 * Best-effort against a technician editing that draft right now: their next
 * save carries the old value back. Stated in the settings copy rather than
 * hidden behind a locking scheme a one-technician draft does not need.
 */
export const renameOption = mutation({
  args: {
    businessId: v.id('businesses'),
    key: optionSetKey,
    from: v.string(),
    to: v.string(),
  },
  handler: async (ctx, { businessId, key, from, to }) => {
    const owner = await requireOwner(ctx, businessId)
    const target = to.trim()
    if (target === from) return { rewritten: 0 }
    if (target.length === 0 || target.length > MAX_OPTION_LENGTH) {
      throw new ConvexError('INVALID_OPTION')
    }

    const sections = await allSections(ctx, businessId)
    // Strings a template matches by value — an exclusive or locked item, an
    // answer that decides whether guidance prints, a visibility condition.
    // Renaming one away breaks that behaviour; renaming onto one silently
    // starts it for every answer being renamed.
    const pinned = pinnedValues(sections, key)
    if (pinned.has(from) || pinned.has(target)) {
      throw new ConvexError('OPTION_PINNED')
    }
    const blanks = sections
      .flatMap((section) => section.fields)
      .flatMap((field) =>
        field.kind === 'repeater' ? field.columns : [field],
      )
      .map((field) => ('blankOption' in field ? field.blankOption : undefined))
    if (blanks.includes(target)) throw new ConvexError('INVALID_OPTION')

    const row = await ensureRow(ctx, businessId, key, owner._id)
    if (!row.options.some((o) => o.value === from)) {
      throw new ConvexError('NOT_FOUND')
    }
    // A rename onto a value that already exists would merge two answers.
    if (row.options.some((o) => o.value === target)) {
      throw new ConvexError('OPTION_EXISTS')
    }

    const now = Date.now()
    await ctx.db.patch(row._id, {
      options: row.options.map((o) =>
        o.value === from ? { value: target, label: target } : o,
      ),
      renames: [...row.renames, { from, to: target, at: now }].slice(
        -MAX_RENAMES,
      ),
      updatedAt: now,
      updatedByMembershipId: owner._id,
    })
    await ctx.db.insert('auditLog', {
      businessId,
      actorMembershipId: owner._id,
      action: 'optionSet.rename',
      entityType: 'optionSets',
      entityId: row._id,
      meta: { key, from, to: target },
      at: now,
    })

    const rewritten = await rewriteDraftsForRename(ctx, {
      businessId,
      key,
      from,
      to: target,
      actorMembershipId: owner._id,
    })
    return { rewritten }
  },
})

/**
 * Every section list across the built-ins and this business's own templates.
 * `pinnedValues` filters to the vocabulary; a pinned string in any of them
 * blocks the rename. Fails closed past the bound rather than checking only
 * some of the business's templates.
 */
async function allSections(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<Array<SectionDef>> {
  const builtins = Object.values(REPORT_TEMPLATES).flatMap((template) =>
    sectionsOf(template),
  )
  const custom = await ctx.db
    .query('customReportTemplates')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .take(MAX_TEMPLATES_SCANNED + 1)
  if (custom.length > MAX_TEMPLATES_SCANNED) {
    throw new ConvexError('TOO_MANY_TEMPLATES')
  }
  const customSections = custom.flatMap(
    (template) => (template.sections ?? []) as Array<SectionDef>,
  )
  return [...builtins, ...customSections]
}
