import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { membershipStatus } from '../schema'
import type { Infer } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * One-off (My licences, contract): clear the Phase 8.1 licence document
 * (`memberships.licenceFile`) from every membership whose document is already
 * in its holder's licence wallet, so the next commit can drop the field.
 *
 * Expand → migrate → contract, as `notesV2.ts` sets out. The expand was the
 * wallet (`memberLicences`, `memberLicenceFiles`); the migrate was
 * `licenceWalletV1`, which copied each document into the wallet under the SAME
 * storage id and deliberately left the membership's pointer in place. This is
 * the first half of the contract: nothing reads or writes the pointer any
 * more (`licences.ts` is gone), so it is cleared here. The second half drops
 * `licenceFile` and its index from convex/schema.ts — and Convex refuses a
 * schema push that drops a field while any document still has it.
 *
 * Cleared ONLY where a `memberLicenceFiles` row holds the same storage id,
 * i.e. where the document was copied: clearing then loses nothing, because
 * the wallet file IS the document. Any other document — a member who was not
 * active when `licenceWalletV1` ran, say (its `skippedInactive`) — is left on
 * the membership and reported in `notCopied`. Nothing is deleted from storage,
 * and no audit rows (nobody in the business made this change). A second run
 * clears nothing new; a dry run reports the same and writes nothing.
 *
 * EVERY COMMAND NAMES ITS DEPLOYMENT (see jobStatusV1.ts). Production is
 * rare-retriever-156 (CLAUDE.md). After the backend that carries this file is
 * deployed:
 *
 *   1. CHECK:   CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/licenceFileContractV1:remaining
 *   2. PREVIEW: CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/licenceFileContractV1:run '{"dryRun":true}'
 *   3. RUN:     CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/licenceFileContractV1:run '{}'
 *   4. VERIFY:  step 1 again reports 0.
 *
 * On the personal dev deployment, the same four with
 * `CONVEX_DEPLOYMENT=dev:acoustic-schnauzer-237` in place of the prefix above.
 *
 * The commit that drops `memberships.licenceFile` can deploy to a deployment
 * ONLY once step 4 reports 0 there. If the run reports anything in
 * `notCopied`, step 4 will not: for a member who has since become active
 * again, run `migrations/licenceWalletV1:run` first (it copies them now) and
 * then this again; for anyone else, it is a decision to make — nothing here
 * clears a document the wallet does not hold.
 */

const clearedValidator = v.object({
  membershipId: v.id('memberships'),
  businessId: v.id('businesses'),
})

const notCopiedValidator = v.object({
  membershipId: v.id('memberships'),
  businessId: v.id('businesses'),
  status: membershipStatus,
})

type Holder = Doc<'memberships'> & {
  licenceFile: NonNullable<Doc<'memberships'>['licenceFile']>
}

/**
 * Every membership that still has a document. Read through the index on the
 * document's storage id, which files a membership without one under
 * `undefined` — below every id — so only holders are read: a handful in the
 * whole deployment.
 */
async function holders(ctx: QueryCtx | MutationCtx): Promise<Array<Holder>> {
  const found: Array<Holder> = []
  for await (const membership of ctx.db
    .query('memberships')
    .withIndex('by_licenceFile_storageId', (q) =>
      q.gt('licenceFile.storageId', undefined),
    )) {
    const document = membership.licenceFile
    if (document) found.push({ ...membership, licenceFile: document })
  }
  return found
}

/** Whether a wallet file holds this storage id — the document was copied. */
async function inWallet(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
): Promise<boolean> {
  const copy = await ctx.db
    .query('memberLicenceFiles')
    .withIndex('by_storage', (q) => q.eq('storageId', storageId))
    .first()
  return copy !== null
}

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    /** Documents taken off their membership (in a dry run: would be). */
    cleared: v.array(clearedValidator),
    /** Documents no wallet file holds, left where they are (see above). */
    notCopied: v.array(notCopiedValidator),
  }),
  handler: async (ctx, { dryRun = false }) => {
    // Read them all before writing any: the patch below changes the very
    // index this reads through.
    const found = await holders(ctx)
    const cleared: Array<Infer<typeof clearedValidator>> = []
    const notCopied: Array<Infer<typeof notCopiedValidator>> = []

    for (const holder of found) {
      if (!(await inWallet(ctx, holder.licenceFile.storageId))) {
        notCopied.push({
          membershipId: holder._id,
          businessId: holder.businessId,
          status: holder.status,
        })
        continue
      }
      if (!dryRun) {
        await ctx.db.patch('memberships', holder._id, {
          licenceFile: undefined,
        })
      }
      cleared.push({ membershipId: holder._id, businessId: holder.businessId })
    }

    return { dryRun, cleared, notCopied }
  },
})

/** How many memberships still have a document — copied or not. Must be 0
 * before `licenceFile` is dropped from the schema. */
export const remaining = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await holders(ctx)).length,
})
