import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { hasCapability, requireActor, requireWriteActor } from './lib/actor'
import { forSelf, recordAudit } from './lib/audit'
import { claimLicenceFile } from './lib/licenceClaims'
import {
  MAX_LICENCE_FILES,
  checkExpiresOn,
  checkLicenceCount,
  checkLicenceFileCount,
  cleanLicenceName,
  cleanLicenceNumber,
} from './lib/memberLicences'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Infer } from 'convex/values'
import type { WriteEnvelope } from './lib/actor'
import type { MemberLicenceRefusal } from './lib/memberLicences'

/**
 * My licences: every licence a person holds, each with a name they choose, an
 * optional number and expiry, and up to six files — the card front and back,
 * the regulator's PDF. The successor to the single Phase 8.1 document on the
 * membership, whose rules every one of these files still follows.
 *
 * SEPARATE from the licence number on the membership (`licenceNumber`), which
 * prints on reports and decides whether one may be finalised. Nothing here
 * reads or writes that number.
 *
 * ── Who may do what ──────────────────────────────────────────────────────
 *
 *  - Write — add, rename, change the number or expiry, add or remove files,
 *    delete: the holder, and only the holder, whatever their role. "The
 *    holder" is the REAL person (`env.actor.real`): an owner switched into
 *    a technician's account writes nothing of the technician's, and what
 *    they add lands in their own wallet — the way Settings always edits the
 *    real person (`profileEditTarget`). The owner, who keeps the report
 *    licence number for the team, does not keep these: they are the
 *    holder's own record of what they hold.
 *  - Read: the holder, and the owner (`business.manage` — which a switch
 *    drops, so the owner reads everyone's from their own account, and nobody
 *    reads them through someone else's). Not a contractor managing a team: a
 *    licence card carries a date of birth and a home address. Everyone else
 *    is refused with NO_ACCESS, the same answer as for a membership outside
 *    the business, so a membership id says nothing about what it holds. Nor
 *    anyone who is no longer active (`list` has the reasoning).
 *
 * Every write resolves the caller with `requireWriteActor`, which fails closed
 * on a switch that has lapsed, and is audited against the holder's
 * membership, where the owner's history of that person finds it.
 *
 * ── Files are never deleted ──────────────────────────────────────────────
 *
 * Removing a file or a whole licence deletes the rows that point at the files
 * — the wallet's, and the Phase 8.1 pointer on the membership when it is the
 * same file (`dropCopiedDocument`) — and nothing else: no
 * `ctx.storage.delete`, for the reason `products.ts` gives: an id a client
 * handed in may be a file something else still needs.
 *
 * ── Storage ids stay on the server ───────────────────────────────────────
 *
 * The query hands back URLs, never ids: ids are claimable
 * (`claimLicenceFile`), and these belong to one person.
 */

const kindValidator = v.union(v.literal('pdf'), v.literal('image'))

/**
 * One file as the page is given it. A `returns` validator — see `listView` —
 * so a later `...file` in the handler, which would carry the storage id,
 * fails every test instead of leaking.
 */
const fileView = v.object({
  _id: v.id('memberLicenceFiles'),
  /** Null when the file is gone from storage: the page says so rather than
   * offering a viewer that cannot load. */
  url: v.union(v.string(), v.null()),
  kind: kindValidator,
  contentType: v.string(),
  fileName: v.string(),
  size: v.number(),
  /** When it was added, and the identity of this version of the file. */
  uploadedAt: v.number(),
})

const licenceView = v.object({
  _id: v.id('memberLicences'),
  name: v.string(),
  number: v.optional(v.string()),
  /** `YYYY-MM-DD`, the last day it is good for. */
  expiresOn: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  /** Oldest first. */
  files: v.array(fileView),
})

const listView = v.object({
  /** True when these are the caller's own: only then is anything offered
   * but viewing. */
  mine: v.boolean(),
  /** Oldest first. */
  licences: v.array(licenceView),
})

/**
 * How many of a person's licences one read takes. Past `MAX_LICENCES` on
 * purpose: the cap is kept on `create`, but the migration copies a Phase 8.1
 * document into the wallet whatever it holds, rather than lose it.
 */
const READ_LIMIT = 50

/**
 * Somewhere to upload a licence file to. Any active member, for their own:
 * what they upload belongs to nothing until `addFile` claims it.
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
 * One person's licences, each with its files — for the person themself and
 * for the owner (see the top of this file). NO_ACCESS for anyone else, for a
 * membership that is not in this business, and for one no longer active.
 */
export const list = query({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
  },
  returns: listView,
  handler: async (ctx, { businessId, membershipId }) => {
    const env = await requireActor(ctx, businessId)
    const mine = env.actor.real._id === membershipId
    if (!mine && !hasCapability(env, 'business.manage')) {
      throw new ConvexError('NO_ACCESS')
    }
    const holder = await ctx.db.get('memberships', membershipId)
    // Not for someone who has left: the owner's roster no longer shows them,
    // and they can no longer take their own cards down, so the owner keeping
    // a way to read them would be holding a former worker's date of birth
    // and home address with no end. The rows stay, like every file here.
    if (
      !holder ||
      holder.businessId !== businessId ||
      holder.status !== 'active'
    ) {
      throw new ConvexError('NO_ACCESS')
    }

    const rows = await ctx.db
      .query('memberLicences')
      .withIndex('by_membership', (q) => q.eq('membershipId', membershipId))
      .take(READ_LIMIT)
    rows.sort(
      (a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime,
    )

    const licences = await Promise.all(
      rows.map(async (licence) => ({
        _id: licence._id,
        name: licence.name,
        number: licence.number,
        expiresOn: licence.expiresOn,
        createdAt: licence.createdAt,
        updatedAt: licence.updatedAt,
        files: await filesOf(ctx, licence._id),
      })),
    )
    return { mine, licences }
  },
})

/**
 * Adds a licence to the caller's own wallet. `number` and `expiresOn` may be
 * left out, or sent empty, for none. Returns the new licence's id, which
 * `addFile` takes.
 */
export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    name: v.string(),
    number: v.optional(v.string()),
    expiresOn: v.optional(v.string()),
  },
  returns: v.id('memberLicences'),
  handler: async (ctx, args) => {
    const env = await requireWriteActor(ctx, args.businessId)
    const holderId = env.actor.real._id

    const name = accept(cleanLicenceName(args.name))
    const number =
      args.number === undefined
        ? undefined
        : accept(cleanLicenceNumber(args.number))
    const expiresOn =
      args.expiresOn === undefined
        ? undefined
        : accept(checkExpiresOn(args.expiresOn))

    const held = await ctx.db
      .query('memberLicences')
      .withIndex('by_membership', (q) => q.eq('membershipId', holderId))
      .take(READ_LIMIT)
    accept(checkLicenceCount(held.length))

    const now = Date.now()
    const licenceId = await ctx.db.insert('memberLicences', {
      businessId: args.businessId,
      membershipId: holderId,
      name,
      number,
      expiresOn,
      createdAt: now,
      updatedAt: now,
    })
    await recordAudit(ctx, forSelf(holderId), {
      businessId: args.businessId,
      action: 'membership.addLicence',
      entityType: 'memberships',
      entityId: holderId,
      meta: { licenceId, name },
      at: now,
    })
    return licenceId
  },
})

/**
 * Changes a licence of the caller's own. Each field: left out to leave it as
 * it is; for `number` and `expiresOn`, null (or an empty string) to clear it.
 * The name cannot be cleared. Saving what is already there changes nothing
 * and writes no history.
 */
export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    licenceId: v.id('memberLicences'),
    name: v.optional(v.string()),
    number: v.optional(v.union(v.string(), v.null())),
    expiresOn: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { licence } = await requireOwnLicence(
      ctx,
      args.businessId,
      args.licenceId,
    )

    const next = {
      name:
        args.name === undefined
          ? licence.name
          : accept(cleanLicenceName(args.name)),
      number:
        args.number === undefined
          ? licence.number
          : args.number === null
            ? undefined
            : accept(cleanLicenceNumber(args.number)),
      expiresOn:
        args.expiresOn === undefined
          ? licence.expiresOn
          : args.expiresOn === null
            ? undefined
            : accept(checkExpiresOn(args.expiresOn)),
    }
    const changed = (['name', 'number', 'expiresOn'] as const).filter(
      (field) => next[field] !== licence[field],
    )
    if (changed.length === 0) return null

    const now = Date.now()
    // An absent field in a patch is left alone; `undefined` removes it, which
    // is what clearing a number or an expiry means.
    await ctx.db.patch('memberLicences', licence._id, {
      ...next,
      updatedAt: now,
    })
    await recordAudit(ctx, forSelf(licence.membershipId), {
      businessId: args.businessId,
      action: 'membership.updateLicence',
      entityType: 'memberships',
      entityId: licence.membershipId,
      // Which fields, not what they now say: the licence has the values.
      meta: { licenceId: licence._id, name: next.name, fields: changed },
      at: now,
    })
    return null
  },
})

/**
 * Deletes a licence of the caller's own, with its files' rows. The files stay
 * in storage. Already gone (a retry, or removed on another device) is done,
 * not an error.
 *
 * The Phase 8.1 document goes with it when one of its files is that document
 * (`dropCopiedDocument`).
 */
export const remove = mutation({
  args: {
    businessId: v.id('businesses'),
    licenceId: v.id('memberLicences'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, licenceId }) => {
    const env = await requireWriteActor(ctx, businessId)
    const licence = await ctx.db.get('memberLicences', licenceId)
    if (!licence) return null
    requireHolder(env, businessId, licence)

    const storageIds: Array<Id<'_storage'>> = []
    for await (const file of ctx.db
      .query('memberLicenceFiles')
      .withIndex('by_licence', (q) => q.eq('licenceId', licence._id))) {
      await ctx.db.delete('memberLicenceFiles', file._id)
      storageIds.push(file.storageId)
    }
    await ctx.db.delete('memberLicences', licence._id)
    const droppedDocument = await dropCopiedDocument(
      ctx,
      licence.membershipId,
      storageIds,
    )

    await recordAudit(ctx, forSelf(licence.membershipId), {
      businessId,
      action: 'membership.removeLicence',
      entityType: 'memberships',
      entityId: licence.membershipId,
      meta: {
        licenceId: licence._id,
        name: licence.name,
        files: storageIds.length,
        ...(droppedDocument ? { clearedLicenceFile: true } : {}),
      },
      at: Date.now(),
    })
    return null
  },
})

/**
 * Puts an upload on a licence of the caller's own. `fileName` is the name it
 * had on the phone — tidied, never refused — and is also what decides the
 * type when storage recorded none (`licenceTypeOf`).
 *
 * The same upload sent again for the same licence (a retry after a dropped
 * reply) answers with the file already made, before any other check. Returns
 * `uploadedAt`, which the page keeps an offline copy under.
 */
export const addFile = mutation({
  args: {
    businessId: v.id('businesses'),
    licenceId: v.id('memberLicences'),
    storageId: v.id('_storage'),
    fileName: v.string(),
  },
  returns: v.object({
    fileId: v.id('memberLicenceFiles'),
    uploadedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const { licence } = await requireOwnLicence(
      ctx,
      args.businessId,
      args.licenceId,
    )

    // Sent again: already done. On any other licence — this person's own
    // included — it is held, and the claim below refuses it.
    const already = await ctx.db
      .query('memberLicenceFiles')
      .withIndex('by_storage', (q) => q.eq('storageId', args.storageId))
      .first()
    if (already?.licenceId === licence._id) {
      return { fileId: already._id, uploadedAt: already.uploadedAt }
    }

    const held = await ctx.db
      .query('memberLicenceFiles')
      .withIndex('by_licence', (q) => q.eq('licenceId', licence._id))
      .take(MAX_LICENCE_FILES)
    accept(checkLicenceFileCount(held.length))

    const claimed = await claimLicenceFile(ctx, args.storageId, args.fileName)
    const uploadedAt = Date.now()
    const fileId = await ctx.db.insert('memberLicenceFiles', {
      businessId: licence.businessId,
      membershipId: licence.membershipId,
      licenceId: licence._id,
      storageId: args.storageId,
      kind: claimed.kind,
      contentType: claimed.contentType,
      fileName: claimed.fileName,
      size: claimed.size,
      uploadedAt,
    })
    await ctx.db.patch('memberLicences', licence._id, {
      updatedAt: uploadedAt,
    })

    // A licence is compliance evidence: when it changed is worth a trace.
    await recordAudit(ctx, forSelf(licence.membershipId), {
      businessId: args.businessId,
      action: 'membership.addLicenceFile',
      entityType: 'memberships',
      entityId: licence.membershipId,
      meta: {
        licenceId: licence._id,
        fileId,
        kind: claimed.kind,
        size: claimed.size,
      },
      at: uploadedAt,
    })
    return { fileId, uploadedAt }
  },
})

/**
 * Takes a file off a licence of the caller's own. The file stays in storage.
 * Already gone is done, not an error. The Phase 8.1 document goes with it
 * when that is what the file is (`dropCopiedDocument`).
 */
export const removeFile = mutation({
  args: {
    businessId: v.id('businesses'),
    fileId: v.id('memberLicenceFiles'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, fileId }) => {
    const env = await requireWriteActor(ctx, businessId)
    const file = await ctx.db.get('memberLicenceFiles', fileId)
    if (!file) return null
    requireHolder(env, businessId, file)

    await ctx.db.delete('memberLicenceFiles', file._id)
    const now = Date.now()
    const licence = await ctx.db.get('memberLicences', file.licenceId)
    if (licence) {
      await ctx.db.patch('memberLicences', licence._id, { updatedAt: now })
    }
    const droppedDocument = await dropCopiedDocument(ctx, file.membershipId, [
      file.storageId,
    ])
    await recordAudit(ctx, forSelf(file.membershipId), {
      businessId,
      action: 'membership.removeLicenceFile',
      entityType: 'memberships',
      entityId: file.membershipId,
      meta: {
        licenceId: file.licenceId,
        fileId: file._id,
        kind: file.kind,
        size: file.size,
        ...(droppedDocument ? { clearedLicenceFile: true } : {}),
      },
      at: now,
    })
    return null
  },
})

// ─────────────────────────────────────────────────────────────────── helpers

/**
 * How many licences a membership holds — `team.roster`'s `licenceCount`. Asks
 * nothing about who may know: the caller decides that (the owner, and the
 * holder, exactly as `list`).
 */
export async function licenceCountOf(
  ctx: QueryCtx,
  membershipId: Id<'memberships'>,
): Promise<number> {
  const rows = await ctx.db
    .query('memberLicences')
    .withIndex('by_membership', (q) => q.eq('membershipId', membershipId))
    .take(READ_LIMIT)
  return rows.length
}

/**
 * Takes the Phase 8.1 document off the holder's membership
 * (`memberships.licenceFile`) when it is one of `removed` — files just taken
 * out of their wallet. Returns whether it did.
 *
 * `migrations/licenceWalletV1` copied each document into the wallet under the
 * SAME storage id and left the membership's pointer where it was, for the
 * frontend that still read it. So the wallet file and the document are one
 * licence, and deleting it in the wallet has to delete both: left behind, a
 * second run of the migration would put it back in the wallet, and
 * `migrations/licenceFileContractV1` — which clears only documents a wallet
 * file still holds — would find it uncopied and leave it, holding up the
 * drop of the field. No audit row of its own: the caller's row for the
 * removal says it happened (`clearedLicenceFile`), as one change the holder
 * made. Goes with the field, once that contract has run everywhere.
 *
 * A document replaced since the copy (from the old Profile page) is a
 * different storage id, and stays.
 */
async function dropCopiedDocument(
  ctx: MutationCtx,
  membershipId: Id<'memberships'>,
  removed: ReadonlyArray<Id<'_storage'>>,
): Promise<boolean> {
  const holder = await ctx.db.get('memberships', membershipId)
  const document = holder?.licenceFile
  if (!holder || !document || !removed.includes(document.storageId)) {
    return false
  }
  await ctx.db.patch('memberships', holder._id, { licenceFile: undefined })
  return true
}

/** A licence's files as the page is given them, oldest first. */
async function filesOf(
  ctx: QueryCtx,
  licenceId: Id<'memberLicences'>,
): Promise<Array<Infer<typeof fileView>>> {
  const rows = await ctx.db
    .query('memberLicenceFiles')
    .withIndex('by_licence', (q) => q.eq('licenceId', licenceId))
    .take(MAX_LICENCE_FILES)
  return Promise.all(
    rows.map(async (file) => ({
      _id: file._id,
      // `getUrl` answers null for a file no longer stored.
      url: await ctx.storage.getUrl(file.storageId),
      kind: file.kind,
      contentType: file.contentType,
      fileName: file.fileName,
      size: file.size,
      uploadedAt: file.uploadedAt,
    })),
  )
}

/**
 * The caller, and a licence of their own — the only kind they may change.
 * NOT_FOUND when there is no such licence (deleted, say, on another device);
 * NO_ACCESS when it is someone else's, in this business or not.
 */
async function requireOwnLicence(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  licenceId: Id<'memberLicences'>,
): Promise<{ env: WriteEnvelope; licence: Doc<'memberLicences'> }> {
  const env = await requireWriteActor(ctx, businessId)
  const licence = await ctx.db.get('memberLicences', licenceId)
  if (!licence) throw new ConvexError('NOT_FOUND')
  requireHolder(env, businessId, licence)
  return { env, licence }
}

/**
 * NO_ACCESS unless the row is the REAL caller's own, in this business. The
 * resolver has read the caller's membership as active and in this business,
 * so a match on both is the whole of the check.
 */
function requireHolder(
  env: WriteEnvelope,
  businessId: Id<'businesses'>,
  row: { businessId: Id<'businesses'>; membershipId: Id<'memberships'> },
): void {
  if (
    row.businessId !== businessId ||
    row.membershipId !== env.actor.real._id
  ) {
    throw new ConvexError('NO_ACCESS')
  }
}

/** A check's value, or its refusal thrown as the `ConvexError` the page reads. */
function accept<T>(
  checked:
    { ok: true; value: T } | { ok: false; refusal: MemberLicenceRefusal },
): T
function accept(
  checked: { ok: true } | { ok: false; refusal: MemberLicenceRefusal },
): void
function accept(
  checked:
    | { ok: true; value?: unknown }
    | { ok: false; refusal: MemberLicenceRefusal },
): unknown {
  if (!checked.ok) throw new ConvexError(checked.refusal)
  return checked.value
}
