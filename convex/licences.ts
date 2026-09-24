import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { hasCapability, requireActor, requireWriteActor } from './lib/actor'
import { forSelf, recordAudit } from './lib/audit'
import { heldAnywhere } from './lib/fileClaims'
import { checkLicenceFile, cleanLicenceFileName } from './lib/licences'
import { CLAIM_WINDOW_MS } from './lib/products'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import type { WriteEnvelope } from './lib/actor'

/**
 * Licence documents (Phase 8.1): each person's own licence — a photo of the
 * card or the regulator's PDF — uploaded from Profile and opened inside the
 * app, never downloaded.
 *
 * ── Who may do what ──────────────────────────────────────────────────────
 *
 *  - Upload, replace or remove: the holder, and only the holder. "The holder"
 *    is the REAL person (`env.actor.real`), so an owner switched into a
 *    technician's account cannot put a file on that technician's licence —
 *    the membership they are working in is not theirs to speak for. Unlike
 *    the licence NUMBER (`memberships.setLicence`), which the owner keeps for
 *    the team because a certificate will not finalise without it, the
 *    document is the holder's own evidence of what they hold; an owner who
 *    wants a copy asks for one.
 *  - Read: the holder, and the owner (`business.manage` — which a switch
 *    drops, so the owner reads everyone's licence from their own account,
 *    and nobody reads it through someone else's). A contractor managing a
 *    team does not: a licence card carries a date of birth and a home
 *    address, which is more than running someone's day needs. Everyone else
 *    is refused with NO_ACCESS, the same answer as for someone outside the
 *    business, so a membership id says nothing about whether it has a file.
 *
 * Every write resolves the caller with `requireWriteActor`, which fails closed
 * on a switch that has lapsed.
 *
 * ── Files are never deleted ──────────────────────────────────────────────
 *
 * Replacing or removing a licence drops the membership's pointer and nothing
 * else — no `ctx.storage.delete` here, for the reason `products.ts` gives: an
 * id a client handed in may be a file something else still needs.
 *
 * ── Storage ids stay on the server ───────────────────────────────────────
 *
 * The query hands back a URL, never the id: ids are claimable (see
 * `claimLicenceFile`), and this one belongs to one person.
 */

const kindValidator = v.union(v.literal('pdf'), v.literal('image'))

/**
 * A licence as the page is given it. A `returns` validator so a later
 * `...licenceFile` in the handler — which would carry the storage id — fails
 * every test instead of leaking.
 */
const licenceView = v.object({
  /** Null when the file is gone from storage: the page says so rather than
   * offering a viewer that cannot load. */
  url: v.union(v.string(), v.null()),
  kind: kindValidator,
  contentType: v.string(),
  fileName: v.string(),
  size: v.number(),
  /** When it was uploaded, and the identity of this version of the file. */
  uploadedAt: v.number(),
  /** True when it is the caller's own: Replace, Remove and Share are offered
   * only then, and only then is a copy kept on the phone. */
  mine: v.boolean(),
})

/**
 * Somewhere to upload a licence to. Any active member, for their own: what
 * they upload belongs to nothing until `setFile` claims it.
 */
export const generateUploadUrl = mutation({
  args: { businessId: v.id('businesses') },
  returns: v.string(),
  handler: async (ctx, { businessId }) => {
    await requireWriteActor(ctx, businessId)
    return ctx.storage.generateUploadUrl()
  },
})

/**
 * Puts an upload on the caller's own licence, replacing any there (the old
 * file stays in storage). `fileName` is the name it had on the phone — tidied,
 * never refused — and is also what decides the type when storage recorded
 * none (`licenceTypeOf`).
 *
 * Returns `uploadedAt`, which the page keeps its offline copy under.
 */
export const setFile = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    storageId: v.id('_storage'),
    fileName: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const { env, holder } = await requireOwnLicence(
      ctx,
      args.businessId,
      args.membershipId,
    )

    // Sent again (a retry after a dropped reply): already done.
    if (holder.licenceFile?.storageId === args.storageId) {
      return holder.licenceFile.uploadedAt
    }

    const claimed = await claimLicenceFile(ctx, args.storageId, args.fileName)
    const uploadedAt = Date.now()
    await ctx.db.patch(holder._id, {
      licenceFile: {
        storageId: args.storageId,
        kind: claimed.type.kind,
        contentType: claimed.type.contentType,
        fileName: cleanLicenceFileName(args.fileName, claimed.type),
        size: claimed.size,
        uploadedAt,
      },
    })

    // A licence is compliance evidence: when it changed is worth a trace, as
    // the licence number's changes are.
    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId: args.businessId,
      action: holder.licenceFile
        ? 'membership.replaceLicenceFile'
        : 'membership.addLicenceFile',
      entityType: 'memberships',
      entityId: holder._id,
      meta: { kind: claimed.type.kind, size: claimed.size },
      at: uploadedAt,
    })
    return uploadedAt
  },
})

/** Takes the caller's licence off their profile. The file stays in storage. */
export const removeFile = mutation({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, membershipId }) => {
    const { env, holder } = await requireOwnLicence(
      ctx,
      businessId,
      membershipId,
    )
    if (!holder.licenceFile) return null
    await ctx.db.patch(holder._id, { licenceFile: undefined })
    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId,
      action: 'membership.removeLicenceFile',
      entityType: 'memberships',
      entityId: holder._id,
      at: Date.now(),
    })
    return null
  },
})

/**
 * One person's licence document, or null when they have none — for the
 * person themself and for the owner (see the top of this file). NO_ACCESS for
 * anyone else, and for a membership that is not in this business.
 */
export const file = query({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
  },
  returns: v.union(v.null(), licenceView),
  handler: async (ctx, { businessId, membershipId }) => {
    const env = await requireActor(ctx, businessId)
    const mine = env.actor.real._id === membershipId
    if (!mine && !hasCapability(env, 'business.manage')) {
      throw new ConvexError('NO_ACCESS')
    }
    const holder = await ctx.db.get(membershipId)
    // Not for someone who has left: the owner's roster no longer shows them,
    // and they can no longer take their own card down (`removeFile` needs an
    // active membership), so the owner keeping a way to read it would be
    // holding a former worker's date of birth and home address with no end.
    // The pointer stays on the row, like every other file here.
    if (
      !holder ||
      holder.businessId !== businessId ||
      holder.status !== 'active'
    ) {
      throw new ConvexError('NO_ACCESS')
    }
    const licence = holder.licenceFile
    if (!licence) return null
    return {
      // `getUrl` answers null for a file no longer stored.
      url: await ctx.storage.getUrl(licence.storageId),
      kind: licence.kind,
      contentType: licence.contentType,
      fileName: licence.fileName,
      size: licence.size,
      uploadedAt: licence.uploadedAt,
      mine,
    }
  },
})

// ─────────────────────────────────────────────────────────────────── helpers

/**
 * The caller, and their own membership — the only one whose licence they may
 * change. NO_ACCESS for any other membership, in this business or not.
 */
async function requireOwnLicence(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  membershipId: Id<'memberships'>,
): Promise<{ env: WriteEnvelope; holder: Doc<'memberships'> }> {
  const env = await requireWriteActor(ctx, businessId)
  if (env.actor.real._id !== membershipId) throw new ConvexError('NO_ACCESS')
  const holder = await ctx.db.get(membershipId)
  // The resolver has just read this row as the caller's, active and in this
  // business; a second look costs nothing and keeps the patch honest.
  if (
    !holder ||
    holder.businessId !== businessId ||
    holder.status !== 'active'
  ) {
    throw new ConvexError('NO_ACCESS')
  }
  return { env, holder }
}

/**
 * Takes an upload for a licence, or refuses it — `products.claimFile`'s rule:
 *
 *  - It must exist and have been uploaded within `CLAIM_WINDOW_MS`: storage
 *    ids are not secrets, so only a fresh upload can be the one this person
 *    just made (FILE_NOT_FOUND otherwise, whichever it was).
 *  - Nothing that can be asked may already hold it — a product, a report
 *    photo, a note's picture, or someone's licence, this person's included
 *    (ALREADY_ATTACHED).
 *  - It must be a PDF, PNG or JPEG within its size (`checkLicenceFile`:
 *    WRONG_FILE_TYPE, FILE_TOO_LARGE) — the checks the page makes before it
 *    uploads, so this only ever refuses a client that skipped them.
 *
 * The type and size kept are storage's, not the client's.
 */
async function claimLicenceFile(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  fileName: string,
) {
  const stored = await ctx.db.system.get('_storage', storageId)
  if (!stored || Date.now() - stored._creationTime > CLAIM_WINDOW_MS) {
    throw new ConvexError('FILE_NOT_FOUND')
  }
  if (await heldAnywhere(ctx, storageId)) {
    throw new ConvexError('ALREADY_ATTACHED')
  }
  const checked = checkLicenceFile(stored, fileName)
  if (!checked.ok) throw new ConvexError(checked.refusal)
  return { type: checked.type, size: stored.size }
}
