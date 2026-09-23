import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { nextColour, normaliseColour } from '../lib/colours'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * One-off (Phase 4.2, and the owner's instruction of 2026-09-23: "terence /
 * owner to be blue and second staff to be red"): re-deal the technician
 * colours of every business still on the colours dealt before the palette
 * changed.
 *
 * Before Phase 4.2 the owner was dealt #FF3B30 — the brand red, which is no
 * longer offered — and the first person to join, blue. The new palette deals
 * the owner blue and the second person red (convex/lib/colours.ts). Nothing
 * rewrote the stored colours, so an existing business kept the old ones: the
 * owner red, the second person blue, the reverse of what was asked for. Left
 * alone it also misdeals: the old red is off the palette and not counted, so
 * the next person invited would be dealt red too.
 *
 * GUARDS, so nothing anybody chose is overwritten:
 *   - a business is changed only while its owner still holds the old default
 *     #FF3B30, which the colour picker cannot set — an owner who has picked
 *     their own colour keeps it, and a second run changes nothing;
 *   - and not at all if anyone's colour in it has been set by hand
 *     (a `membership.setColour` audit row): between the deploy and this run
 *     the owner may have picked Kevin's colour but not their own.
 * Removed members are not touched.
 *
 * Everyone active is dealt again in joining order — the owner first, then by
 * when they joined — exactly as a new business would deal them: the owner
 * blue, the next red, then teal, pink and so on. No audit rows are written
 * (nobody in the business made these changes); the run returns each change
 * instead, and a dry run returns them without writing.
 *
 * EVERY COMMAND NAMES ITS DEPLOYMENT (see jobStatusV1.ts). For production,
 * after the Phase 4 backend is deployed there:
 *
 *   1. CHECK:   CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/memberColoursV1:remaining
 *   2. PREVIEW: CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/memberColoursV1:run '{"dryRun":true}'
 *   3. RUN:     CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/memberColoursV1:run '{}'
 *   4. VERIFY:  step 1 again reports 0.
 *
 * No schema change and nothing to contract: the colours are ordinary values
 * in an existing field. The owner can still change any of them afterwards in
 * Settings → Team.
 */

const LEGACY_OWNER_COLOUR = '#FF3B30'

type Change = {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  role: Doc<'memberships'>['role']
  from: string
  to: string
}

async function activeMembers(
  ctx: QueryCtx | MutationCtx,
  businessId: Id<'businesses'>,
) {
  return (
    await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
  ).filter((m) => m.status !== 'removed')
}

async function anyColourChosen(
  ctx: QueryCtx | MutationCtx,
  members: Array<Doc<'memberships'>>,
) {
  for (const member of members) {
    const rows = await ctx.db
      .query('auditLog')
      .withIndex('by_entity', (q) =>
        q.eq('entityType', 'memberships').eq('entityId', member._id),
      )
      .collect()
    if (rows.some((row) => row.action === 'membership.setColour')) return true
  }
  return false
}

/** Each business still on the old deal, with its active members in the order
 * a new business deals them: the owner first, then by when they joined. */
async function businessesToRedeal(ctx: QueryCtx | MutationCtx) {
  const owners = (await ctx.db.query('memberships').collect()).filter(
    (m) =>
      m.role === 'owner' &&
      m.status !== 'removed' &&
      normaliseColour(m.colour) === LEGACY_OWNER_COLOUR,
  )
  const due: Array<{
    businessId: Id<'businesses'>
    members: Array<Doc<'memberships'>>
  }> = []
  const skipped: Array<Id<'businesses'>> = []
  for (const businessId of new Set(owners.map((m) => m.businessId))) {
    const members = (await activeMembers(ctx, businessId)).sort(
      (a, b) =>
        Number(b.role === 'owner') - Number(a.role === 'owner') ||
        a.createdAt - b.createdAt ||
        a._creationTime - b._creationTime,
    )
    if (await anyColourChosen(ctx, members)) skipped.push(businessId)
    else due.push({ businessId, members })
  }
  return { due, skipped }
}

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun = false }) => {
    const changes: Array<Change> = []
    const { due, skipped } = await businessesToRedeal(ctx)

    for (const { businessId, members } of due) {
      const dealt: Array<string> = []
      for (const member of members) {
        const colour = nextColour(dealt)
        dealt.push(colour)
        if (normaliseColour(member.colour) === colour) continue
        changes.push({
          businessId,
          membershipId: member._id,
          role: member.role,
          from: member.colour,
          to: colour,
        })
        if (!dryRun) await ctx.db.patch(member._id, { colour })
      }
    }

    // `skipped`: still on the old red, but somebody's colour there was set by
    // hand — left for the owner to finish in Settings → Team.
    return { dryRun, changes, skipped }
  },
})

/** How many businesses the run would still change. Must be 0 after it. */
export const remaining = internalQuery({
  args: {},
  handler: async (ctx) => (await businessesToRedeal(ctx)).due.length,
})
