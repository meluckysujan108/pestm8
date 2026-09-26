import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * One-off (My licences, 2026-09-26): copy each Phase 8.1 licence document
 * (`memberships.licenceFile`) into its holder's licence wallet
 * (`memberLicences`, `memberLicenceFiles`), so nobody's uploaded licence goes
 * missing when the Profile page moves to the wallet.
 *
 * For every membership with a document not copied yet: one licence named
 * "Licence", its number and expiry left empty — it is not linked to the
 * report licence number (`licenceNumber`), which stays where it is — and on
 * it one file with the SAME storage id and the metadata the document was
 * claimed with. Written directly, not through `claimLicenceFile`: the file is
 * already this person's, and the claim would refuse it as held (by the
 * membership's own pointer) and as past its claim window. The licence is
 * dated from the upload, which is when the person put it up.
 *
 * Only ACTIVE members are copied. Someone removed (or removed and invited
 * back, but not yet joined) can neither read nor take down a wallet —
 * `memberLicences.list` refuses anyone not active — so a copy would be a
 * second place holding a former worker's date of birth and home address that
 * nobody could see or delete. Their document stays on the membership, where
 * it already was, and is counted in `skippedInactive`, not in `remaining`. If
 * they come back, a run after they have joined copies it then.
 *
 * "Already copied" is a `memberLicenceFiles` row holding that storage id, so a
 * second run copies nothing. `memberships.licenceFile` is left in place: the
 * live frontend reads it until the wallet's ships, and a later contract
 * removes it — after a last run for anyone who has come back since. Deleting
 * the copy in the wallet takes the document with it (`dropCopiedDocument` in
 * memberLicences.ts), so a licence someone deleted is never copied back. No
 * audit rows (nobody in the business made these changes); the run returns
 * each copy instead, and a dry run returns them without writing.
 *
 * WHEN: after this backend is deployed, once the frontend that reads the
 * wallet is live (Vercel's newest successful build includes it) — until
 * then, the Profile page can still replace the document, and a document
 * replaced after the run is a new storage id that a second run would copy as
 * a second "Licence". `remaining` says whether there is anything to do.
 *
 * EVERY COMMAND NAMES ITS DEPLOYMENT (see jobStatusV1.ts). Production is
 * rare-retriever-156 (CLAUDE.md), which had exactly one document to copy on
 * 2026-09-26:
 *
 *   1. CHECK:   CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/licenceWalletV1:remaining
 *   2. PREVIEW: CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/licenceWalletV1:run '{"dryRun":true}'
 *   3. RUN:     CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/licenceWalletV1:run '{}'
 *   4. VERIFY:  step 1 again reports 0.
 *
 * On the personal dev deployment, the same four with
 * `CONVEX_DEPLOYMENT=dev:acoustic-schnauzer-237` in place of the prefix above.
 *
 * Nothing to expand first: the two tables are new and additive. Nothing to
 * contract here either; removing `licenceFile` and `licences.ts` is its own
 * change, once nothing calls them.
 */

type Copy = {
  membershipId: Id<'memberships'>
  businessId: Id<'businesses'>
  /** Null in a dry run. */
  licenceId: Id<'memberLicences'> | null
}

const copyValidator = v.object({
  membershipId: v.id('memberships'),
  businessId: v.id('businesses'),
  licenceId: v.union(v.id('memberLicences'), v.null()),
})

type Holder = Doc<'memberships'> & {
  licenceFile: NonNullable<Doc<'memberships'>['licenceFile']>
}

/**
 * Every active membership whose document is not in a wallet yet. Read
 * through the index on the document's storage id, which files a membership
 * without one under `undefined` — below every id — so only holders are read:
 * a handful in the whole deployment.
 */
async function holdersToCopy(ctx: QueryCtx | MutationCtx): Promise<{
  due: Array<Holder>
  alreadyCopied: number
  skippedInactive: number
}> {
  const due: Array<Holder> = []
  let alreadyCopied = 0
  let skippedInactive = 0
  for await (const membership of ctx.db
    .query('memberships')
    .withIndex('by_licenceFile_storageId', (q) =>
      q.gt('licenceFile.storageId', undefined),
    )) {
    const document = membership.licenceFile
    if (!document) continue
    const copied = await ctx.db
      .query('memberLicenceFiles')
      .withIndex('by_storage', (q) => q.eq('storageId', document.storageId))
      .first()
    if (copied) alreadyCopied++
    else if (membership.status !== 'active') skippedInactive++
    else due.push({ ...membership, licenceFile: document })
  }
  return { due, alreadyCopied, skippedInactive }
}

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    copied: v.array(copyValidator),
    alreadyCopied: v.number(),
    /** Documents of members not active, left where they are (see above). */
    skippedInactive: v.number(),
  }),
  handler: async (ctx, { dryRun = false }) => {
    const { due, alreadyCopied, skippedInactive } = await holdersToCopy(ctx)
    const copied: Array<Copy> = []

    for (const holder of due) {
      const document = holder.licenceFile
      let licenceId: Id<'memberLicences'> | null = null
      if (!dryRun) {
        licenceId = await ctx.db.insert('memberLicences', {
          businessId: holder.businessId,
          membershipId: holder._id,
          name: 'Licence',
          createdAt: document.uploadedAt,
          updatedAt: document.uploadedAt,
        })
        await ctx.db.insert('memberLicenceFiles', {
          businessId: holder.businessId,
          membershipId: holder._id,
          licenceId,
          storageId: document.storageId,
          kind: document.kind,
          contentType: document.contentType,
          fileName: document.fileName,
          size: document.size,
          uploadedAt: document.uploadedAt,
        })
      }
      copied.push({
        membershipId: holder._id,
        businessId: holder.businessId,
        licenceId,
      })
    }

    return { dryRun, copied, alreadyCopied, skippedInactive }
  },
})

/** How many documents the run would still copy — active members' only.
 * Must be 0 after it. */
export const remaining = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await holdersToCopy(ctx)).due.length,
})
