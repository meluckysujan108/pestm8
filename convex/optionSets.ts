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
  MAX_LIVE_OPTIONS,
  MAX_OPTION_LENGTH,
  MAX_RENAMES,
  OPTION_SET_KEYS,
  OPTION_SET_LABELS,
  defaultOptionSet,
  rememberedOrder,
  usualOrder,
} from '../src/lib/reportTemplates/optionLibraries'
import { pinnedValues } from '../src/lib/reportTemplates/optionSets'
import type { SectionDef } from '../src/lib/reportTemplates'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'

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
 * The lists as an owner edits them, and as a picker orders them.
 *
 * Separate from `list` because that one returns exactly what template
 * resolution takes and nothing else — an extra field there would be hashed
 * into every snapshot at finalise for a change that prints nothing. This one
 * carries the bookkeeping: which options are usual, which are archived, and
 * which of them a template pins so the editor can refuse before the mutation
 * does.
 */
export const editable = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    // Owner only, like the mutations beside it. A technician's picker gets
    // what it needs from `usual`, which is cheap; this one scans every custom
    // template to work out what is pinned, and returns `archived` — the list
    // of products the business has deliberately stopped offering, which
    // appears on no technician's screen.
    await requireOwner(ctx, businessId)

    const rows = await ctx.db
      .query('optionSets')
      .withIndex('by_business_key', (q) => q.eq('businessId', businessId))
      .take(64)
    const own = new Map(rows.map((row) => [row.key, row] as const))

    const sections = await allSections(ctx, businessId)

    return OPTION_SET_KEYS.map((key) => {
      const row = own.get(key)
      const defaults = defaultOptionSet(key)
      return {
        key,
        label: OPTION_SET_LABELS[key],
        options: row
          ? row.options.map((o) => ({
              value: o.value,
              label: o.label,
              usual: o.usual === true,
            }))
          : (defaults?.options ?? []).map((o) => ({
              value: o.value,
              label: o.label,
              usual: false,
            })),
        archived: row?.archived ?? [],
        /** Untouched by this business, so still exactly the form's own list. */
        isDefault: row === undefined,
        /**
         * Strings a template matches by value — a locked item, an answer that
         * decides whether guidance prints, a visibility condition. The editor
         * greys these rather than letting an owner discover the refusal.
         */
        pinned: [...pinnedValues(sections, key)],
      }
    })
  },
})

/**
 * What each picker should offer before the list itself, for the member asking.
 *
 * Two sources, one answer: the options the owner marked usual for the whole
 * business, then the ones this member last reached for. Separate from
 * `editable` because a technician opening a report needs exactly this and
 * nothing else — that query scans every template to work out what is pinned,
 * which is an owner's concern on an owner's screen.
 *
 * A remembered value that has since been renamed or archived simply stops
 * matching anything in the list, and the picker drops it.
 */
export const usual = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const me = await requireMembership(ctx, businessId)

    const rows = await ctx.db
      .query('optionSets')
      .withIndex('by_business_key', (q) => q.eq('businessId', businessId))
      .take(64)

    const recent = me.reportPrefs?.recent ?? {}
    const flagged = new Map(
      rows.map(
        (row) =>
          [
            row.key,
            row.options.filter((o) => o.usual === true).map((o) => o.value),
          ] as const,
      ),
    )

    const out: Record<string, Array<string>> = {}
    for (const key of OPTION_SET_KEYS) {
      const preferred = usualOrder(flagged.get(key) ?? [], recent[key] ?? [])
      // Omitted rather than sent empty: a picker with no preference should
      // render exactly the form's own list, with no heading above it.
      if (preferred.length > 0) out[key] = preferred
    }
    return out
  },
})

/**
 * This member just reached for these answers in this list.
 *
 * Written when a picker closes rather than on every tap, so a technician who
 * opens a sheet, changes their mind and closes it teaches the app nothing.
 * Self-only by construction — the caller's own membership is the only row it
 * can touch — and bounded to five values per list, so the document cannot
 * grow however many reports a member fills.
 */
export const remember = mutation({
  args: {
    businessId: v.id('businesses'),
    key: optionSetKey,
    values: v.array(v.string()),
  },
  handler: async (ctx, { businessId, key, values }) => {
    const me = await requireMembership(ctx, businessId)

    const recent = { ...(me.reportPrefs?.recent ?? {}) }
    const before = recent[key] ?? []
    const picked = values
      .map((value) => value.trim())
      .filter((value) => value !== '' && value.length <= MAX_OPTION_LENGTH)
    const next = rememberedOrder(before, picked)

    // Nothing new to learn: this is called on every picker close, and a
    // no-op patch is still a write on a row several queries watch.
    const same =
      next.length === before.length &&
      next.every((value, i) => value === before[i])
    if (same) return

    recent[key] = next
    await ctx.db.patch(me._id, { reportPrefs: { recent } })
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
    // Including one that is only in the archive: `addOption` restores by name,
    // so a live option and an archived one sharing a name leaves a row in
    // "No longer offered" that can never be brought back.
    if ((row.archived ?? []).some((o) => o.value === target)) {
      throw new ConvexError('OPTION_EXISTS')
    }

    const now = Date.now()
    await ctx.db.patch(row._id, {
      options: row.options.map((o) =>
        // Spread, not replaced: an option is more than its words now. Building
        // a fresh object dropped `usual`, so renaming a starred product
        // silently unstarred it for every technician in the business.
        o.value === from ? { ...o, value: target, label: target } : o,
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
 * Adds an option to a business's vocabulary.
 *
 * `value === label`, as everywhere: an answer stores the words it prints, so a
 * finished report never has to read this row back to know what it says.
 */
export const addOption = mutation({
  args: {
    businessId: v.id('businesses'),
    key: optionSetKey,
    label: v.string(),
  },
  handler: async (ctx, { businessId, key, label }) => {
    const owner = await requireOwner(ctx, businessId)
    const value = label.trim()
    if (value.length === 0 || value.length > MAX_OPTION_LENGTH) {
      throw new ConvexError('INVALID_OPTION')
    }

    const row = await ensureRow(ctx, businessId, key, owner._id)
    if (row.options.some((o) => o.value === value)) {
      throw new ConvexError('OPTION_EXISTS')
    }
    if (row.options.length >= MAX_LIVE_OPTIONS) {
      throw new ConvexError('TOO_MANY_OPTIONS')
    }

    // Back from the archive rather than a second entry, so the two cannot
    // drift apart by a bracket.
    const archived = (row.archived ?? []).filter((o) => o.value !== value)

    await write(ctx, row._id, owner._id, {
      options: [...row.options, { value, label: value }],
      archived,
    })
    await record(ctx, businessId, owner._id, row._id, 'optionSet.add', { key, value })
  },
})

/**
 * Stops offering an option, without losing it.
 *
 * Reports that already chose it still print it — an answer carries its own
 * words — and a product that comes back off the shelf is retyped exactly,
 * brackets and active constituent included, which is a needless chance to get
 * it wrong.
 */
export const archiveOption = mutation({
  args: {
    businessId: v.id('businesses'),
    key: optionSetKey,
    value: v.string(),
  },
  handler: async (ctx, { businessId, key, value }) => {
    const owner = await requireOwner(ctx, businessId)

    // A string a template matches on: a locked item, an answer that decides
    // whether guidance prints, a condition. Removing it would quietly change
    // how the form behaves rather than what it offers.
    const pinned = pinnedValues(await allSections(ctx, businessId), key)
    if (pinned.has(value)) throw new ConvexError('OPTION_PINNED')

    const row = await ensureRow(ctx, businessId, key, owner._id)
    const option = row.options.find((o) => o.value === value)
    if (!option) throw new ConvexError('NOT_FOUND')
    if (row.options.length === 1) throw new ConvexError('LAST_OPTION')

    await write(ctx, row._id, owner._id, {
      options: row.options.filter((o) => o.value !== value),
      archived: [...(row.archived ?? []), { value, label: option.label }],
    })
    await record(ctx, businessId, owner._id, row._id, 'optionSet.archive', {
      key,
      value,
    })
  },
})

/** Offers an archived option again, at the end of the list. */
export const restoreOption = mutation({
  args: {
    businessId: v.id('businesses'),
    key: optionSetKey,
    value: v.string(),
  },
  handler: async (ctx, { businessId, key, value }) => {
    const owner = await requireOwner(ctx, businessId)
    const row = await ensureRow(ctx, businessId, key, owner._id)
    const option = (row.archived ?? []).find((o) => o.value === value)
    if (!option) throw new ConvexError('NOT_FOUND')
    if (row.options.some((o) => o.value === value)) {
      throw new ConvexError('OPTION_EXISTS')
    }

    await write(ctx, row._id, owner._id, {
      options: [...row.options, option],
      archived: (row.archived ?? []).filter((o) => o.value !== value),
    })
    await record(ctx, businessId, owner._id, row._id, 'optionSet.restore', {
      key,
      value,
    })
  },
})

/**
 * Marks the handful a business actually reaches for.
 *
 * The picker puts these first, which is the difference between scrolling
 * thirteen products and tapping the one used on nine jobs in ten. It changes
 * nothing about what prints, so it is not a rename and does not touch drafts.
 */
export const setUsual = mutation({
  args: {
    businessId: v.id('businesses'),
    key: optionSetKey,
    value: v.string(),
    usual: v.boolean(),
  },
  handler: async (ctx, { businessId, key, value, usual: isUsual }) => {
    const owner = await requireOwner(ctx, businessId)
    const row = await ensureRow(ctx, businessId, key, owner._id)
    if (!row.options.some((o) => o.value === value)) {
      throw new ConvexError('NOT_FOUND')
    }

    await write(ctx, row._id, owner._id, {
      options: row.options.map((o) =>
        o.value === value ? { ...o, usual: isUsual ? true : undefined } : o,
      ),
    })
  },
})

/**
 * Puts the list in the order a technician reads it.
 *
 * The order IS the vocabulary's shape — a form prints its options in the order
 * the list gives them — so this is given the whole list rather than a
 * from/to pair: a reorder that lost or duplicated an entry would be a silent
 * edit to what the business offers.
 */
export const reorder = mutation({
  args: {
    businessId: v.id('businesses'),
    key: optionSetKey,
    values: v.array(v.string()),
  },
  handler: async (ctx, { businessId, key, values }) => {
    const owner = await requireOwner(ctx, businessId)
    const row = await ensureRow(ctx, businessId, key, owner._id)

    const before = row.options.map((o) => o.value)
    const same =
      values.length === before.length &&
      new Set(values).size === values.length &&
      values.every((value) => before.includes(value))
    // Refused rather than reconciled: an order that is not a permutation of
    // the list means the client and the server disagree about what the list
    // is, and guessing which is right is how an option disappears.
    if (!same) throw new ConvexError('INVALID_ORDER')

    const by = new Map(row.options.map((o) => [o.value, o] as const))
    await write(ctx, row._id, owner._id, {
      options: values.map((value) => by.get(value)!),
    })
  },
})

/** Back to the form's own list, and the business's row is gone. */
export const resetToDefaults = mutation({
  args: { businessId: v.id('businesses'), key: optionSetKey },
  handler: async (ctx, { businessId, key }) => {
    const owner = await requireOwner(ctx, businessId)
    const row = await ctx.db
      .query('optionSets')
      .withIndex('by_business_key', (q) =>
        q.eq('businessId', businessId).eq('key', key),
      )
      .unique()
    if (!row) return

    await ctx.db.delete(row._id)
    await record(ctx, businessId, owner._id, row._id, 'optionSet.reset', { key })
  },
})

async function write(
  ctx: MutationCtx,
  rowId: Id<'optionSets'>,
  actorMembershipId: Id<'memberships'>,
  patch: Partial<Doc<'optionSets'>>,
) {
  await ctx.db.patch(rowId, {
    ...patch,
    updatedAt: Date.now(),
    updatedByMembershipId: actorMembershipId,
  })
}

/**
 * A vocabulary prints on every signed document a business issues, so every
 * change to one is on the record beside the reports themselves.
 */
async function record(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  actorMembershipId: Id<'memberships'>,
  rowId: Id<'optionSets'>,
  action: string,
  meta: unknown,
) {
  await ctx.db.insert('auditLog', {
    businessId,
    actorMembershipId,
    action,
    entityType: 'optionSets',
    entityId: rowId,
    meta,
    at: Date.now(),
  })
}

/**
 * Every section list across the built-ins and this business's own templates.
 * `pinnedValues` filters to the vocabulary; a pinned string in any of them
 * blocks the rename. Fails closed past the bound rather than checking only
 * some of the business's templates.
 */
async function allSections(
  ctx: QueryCtx | MutationCtx,
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
