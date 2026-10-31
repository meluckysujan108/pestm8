import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import {
  hasCapability,
  requireActor,
  requireCapability,
  requireWriteActor,
} from './lib/actor'
import { isBinned, unbinned } from './lib/bin'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { matchEvidence } from './schema'
import type { Infer } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

/**
 * "May be the same customer as Jane Nguyen": the possible duplicates the
 * server's check let through when a booking made a new client
 * (lib/findSame.ts), for the office to merge or set aside. A technician who
 * booked past a match, or whose phone sent a booking later with nobody to
 * ask, may not be able to merge (`clients.manage`); this is how the person
 * who can finds out. It is also the list of duplicates already coming in,
 * for the owner's C9.
 *
 * Server-side only. Never sent to phones, never in a kept copy: read on the
 * live client sheet by the owner and contractors only (`forClient` says
 * why), filtered by who may see each client. A row holds ids and the kind
 * of evidence, never the number, email or address itself.
 *
 * Cleared with its clients: deleted when either is wiped from the Recycle
 * bin (bin.wipeStep), taken back by an import's Undo
 * (clientImports.undoStep) or removed with a demo (demo/cleanup.ts). A
 * client merely in the bin keeps its rows, which come back with a restore,
 * and are left out of the sheet meanwhile. A merge answers the pair's own
 * row as merged and hands the merged-away client's others to the client it
 * was merged into (`settleHintsOnMerge`).
 */

/** More hints than any one client gathers; the reads stay bounded. */
const HINTS_PER_CLIENT = 100

type Evidence = Infer<typeof matchEvidence>

/**
 * Notes each possible duplicate against the client a booking just made, in
 * the transaction that made it. Nothing for none.
 */
export async function noteMatchHints(
  ctx: MutationCtx,
  made: {
    businessId: Id<'businesses'>
    clientId: Id<'clients'>
    madeBy: Id<'memberships'>
  },
  hints: ReadonlyArray<{
    otherClientId: Id<'clients'>
    evidence: Array<Evidence>
  }>,
): Promise<void> {
  if (hints.length === 0) return
  const now = Date.now()
  for (const hint of hints) {
    if (hint.otherClientId === made.clientId || hint.evidence.length === 0) {
      continue
    }
    await ctx.db.insert('clientMatchHints', {
      businessId: made.businessId,
      clientId: made.clientId,
      otherClientId: hint.otherClientId,
      evidence: hint.evidence,
      madeAt: now,
      madeBy: made.madeBy,
    })
  }
}

/** Every hint naming the client, on either side. */
async function hintsNaming(ctx: MutationCtx, clientId: Id<'clients'>) {
  const [made, other] = await Promise.all([
    ctx.db
      .query('clientMatchHints')
      .withIndex('by_clientId', (q) => q.eq('clientId', clientId))
      .take(HINTS_PER_CLIENT),
    ctx.db
      .query('clientMatchHints')
      .withIndex('by_otherClientId', (q) => q.eq('otherClientId', clientId))
      .take(HINTS_PER_CLIENT),
  ])
  return [...made, ...other]
}

/** The client a hint pairs with `clientId`. */
function otherOf(
  hint: { clientId: Id<'clients'>; otherClientId: Id<'clients'> },
  clientId: Id<'clients'>,
): Id<'clients'> {
  return hint.clientId === clientId ? hint.otherClientId : hint.clientId
}

/**
 * Before a client is deleted for good (a wipe, an import's Undo): every
 * hint naming it goes, so none points at nobody. A read's worth at a time
 * until there are none, however many there are.
 */
export async function clearMatchHints(
  ctx: MutationCtx,
  clientId: Id<'clients'>,
): Promise<void> {
  for (;;) {
    const naming = await hintsNaming(ctx, clientId)
    if (naming.length === 0) return
    for (const hint of naming) {
      await ctx.db.delete('clientMatchHints', hint._id)
    }
  }
}

/**
 * B merged into A (clientMerge.merge): the hint between the two is answered,
 * merged, by whoever merged them. B's hints with anyone else become A's, B
 * being part of A now: C may still be the same customer as A, and the
 * office should go on seeing it on both sheets. One with a C that A already
 * has a hint with goes instead, open or answered: A's says it already, and
 * a pair the office set aside as Not the same stays set aside. A's own are
 * left as they are.
 */
export async function settleHintsOnMerge(
  ctx: MutationCtx,
  merge: {
    from: Id<'clients'>
    into: Id<'clients'>
    by: Id<'memberships'>
    now: number
  },
): Promise<void> {
  const paired = new Set(
    (await hintsNaming(ctx, merge.into)).map((hint) =>
      otherOf(hint, merge.into),
    ),
  )
  for (const hint of await hintsNaming(ctx, merge.from)) {
    const other = otherOf(hint, merge.from)
    if (other === merge.into) {
      await ctx.db.patch('clientMatchHints', hint._id, {
        answer: 'merged',
        answeredAt: merge.now,
        answeredBy: merge.by,
      })
    } else if (paired.has(other)) {
      await ctx.db.delete('clientMatchHints', hint._id)
    } else {
      await ctx.db.patch(
        'clientMatchHints',
        hint._id,
        hint.clientId === merge.from
          ? { clientId: merge.into }
          : { otherClientId: merge.into },
      )
      paired.add(other)
    }
  }
}

/**
 * The open hints on a client's sheet: each other client it may be, with
 * the evidence, newest first. Only clients the caller may see, on either
 * side, and neither in the Recycle bin; nothing for a client they can't
 * see. Merge… and Not the same are for `clients.manage`, which the sheet
 * asks for itself (`useCan`).
 *
 * And only for someone who manages the team (`team.manage`, the test the
 * roster gives everyone's phone and email by): the owner and contractors,
 * who are also the ones who may merge (the owner's C8, "the possible-
 * duplicate line, for the owner and contractors"). Everyone else gets
 * nothing, whatever there is. A hint is worked out with every member's
 * number and email left out, whoever booked (lib/findSame.ts), as the
 * office's own phones leave them out, so it never rests on a team member's
 * number that an office put on a client. So for a subcontractor, a pair of
 * clients with the same name and number and no hint, beside another pair
 * with one, would say the number is a team member's, which the roster
 * keeps from them. Someone who holds every member's details learns nothing
 * from it.
 */
export const forClient = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  returns: v.array(
    v.object({
      _id: v.id('clientMatchHints'),
      otherClientId: v.id('clients'),
      otherName: v.string(),
      evidence: v.array(matchEvidence),
      madeAt: v.number(),
    }),
  ),
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireActor(ctx, businessId)
    if (!hasCapability(env, 'team.manage')) return []
    const client = unbinned(await ctx.db.get('clients', clientId))
    if (!client || client.businessId !== businessId) return []
    const visible = await visibleClientIds(ctx, env)
    if (!inClientScope(visible, clientId)) return []

    const [made, other] = await Promise.all([
      ctx.db
        .query('clientMatchHints')
        .withIndex('by_clientId', (q) => q.eq('clientId', clientId))
        .take(HINTS_PER_CLIENT),
      ctx.db
        .query('clientMatchHints')
        .withIndex('by_otherClientId', (q) => q.eq('otherClientId', clientId))
        .take(HINTS_PER_CLIENT),
    ])
    const open = [...made, ...other].filter(
      (hint) => hint.answer === undefined && hint.businessId === businessId,
    )
    const rows = await Promise.all(
      open.map(async (hint) => {
        const otherId =
          hint.clientId === clientId ? hint.otherClientId : hint.clientId
        const otherClient = await ctx.db.get('clients', otherId)
        if (
          !otherClient ||
          isBinned(otherClient) ||
          otherClient.businessId !== businessId ||
          !inClientScope(visible, otherId)
        ) {
          return null
        }
        return {
          _id: hint._id,
          otherClientId: otherId,
          otherName: otherClient.name,
          evidence: hint.evidence,
          madeAt: hint.madeAt,
        }
      }),
    )
    return rows
      .filter((row) => row !== null)
      .sort((a, b) => b.madeAt - a.madeAt)
  },
})

/**
 * Not the same: whoever may merge clients sets a hint aside, and it is no
 * longer shown on either sheet. Merged is set by the merge itself.
 * Answering one already answered changes nothing.
 */
export const answer = mutation({
  args: {
    businessId: v.id('businesses'),
    hintId: v.id('clientMatchHints'),
    answer: v.literal('different'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, hintId, answer: given }) => {
    const env = await requireWriteActor(ctx, businessId)
    requireCapability(env, 'clients.manage')
    const hint = await ctx.db.get('clientMatchHints', hintId)
    if (!hint || hint.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (hint.answer !== undefined) return null
    await ctx.db.patch('clientMatchHints', hintId, {
      answer: given,
      answeredAt: Date.now(),
      answeredBy: env.actor.real._id,
    })
    return null
  },
})
