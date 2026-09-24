import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { hasCapability, requireActor, requireWriteActor } from './lib/actor'
import {
  CLAIM_WINDOW_MS,
  MAX_PRODUCTS,
  checkPdfFile,
  checkPhotoFile,
  cleanDescription,
  cleanPdfFileName,
  cleanProductName,
  nameKeyOf,
  normaliseProductUrl,
} from './lib/products'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import type { ActorEnvelope } from './lib/actor'

/**
 * Products (Phase 7.1): the business's shelf — each product's name, a few
 * lines about it, a photo, the maker's link and one PDF (an SDS or a label).
 * See the table in schema.ts for what it is and, as importantly, what it is
 * not.
 *
 * Who may do what, which is the snippets rule (`snippets.ts`) for the same
 * reason: every active member reads the list and adds to it, and a product is
 * changed or removed only by the person who added it or by the owner.
 * "Added it" means the REAL person — `env.actor.real`, never an account they
 * were switched into — and "the owner" means `templates.manage`, which a
 * switch drops, so an owner working inside someone's account has no more say
 * over other people's products than they would.
 *
 * Every write resolves the caller with `requireWriteActor`, not
 * `requireMembership`: it is the resolver that fails closed on a switch that
 * has expired or been revoked, and a Save is a write.
 *
 * ── Files are never deleted ───────────────────────────────────────────────
 *
 * Not when a product is removed, and not when its photo or PDF is replaced or
 * cleared. There is no `ctx.storage.delete` in this module, and there must not
 * be one.
 *
 * A product claims a file by its storage id, and storage ids are not private
 * to the feature that made them: a report's PDF id reaches the client through
 * `reports.get` (the `...report` spread) and `reportPdf.generate`, and a
 * report's PDF, once deleted, is never drawn again — `reports.claimPdf` sees
 * `pdfStorageId` set at the current renderer version and hands the dead id
 * back as ready. So a path that could claim a file here and later delete it
 * would be a way to destroy a finalised certificate: claim the id within the
 * window, remove the product, and the signed document the client was sent is
 * gone for good. The claim rules below make that narrow; not deleting makes
 * it impossible.
 *
 * The cost is orphans: a replaced SDS stays in storage with nothing pointing
 * at it. That is accepted here as it is everywhere else in the app (a report
 * photo removed from a draft, a job photo taken off a job), and it is a few
 * megabytes against a certificate nobody can reissue.
 *
 * Claiming someone else's file is not an escalation in itself, which is why a
 * freshness window is enough: to know a report PDF's id you must already be
 * able to read that report, and to put its bytes on a product you could as
 * easily have downloaded it and uploaded it again.
 */

/**
 * A PDF on its way onto a product: the upload, and the name it had on the
 * phone. The name is tidied (`cleanPdfFileName`), never refused.
 */
const pdfArg = v.object({
  storageId: v.id('_storage'),
  fileName: v.string(),
})

/**
 * One product as the page is given it.
 *
 * Declared as a `returns` validator rather than left to inference because of
 * what it must never carry: a storage id. Ids are treated as capabilities in
 * this app (see `withoutImages` in reports.ts) — `create` and `update` take
 * one, so an id handed to every member is an id every member can try to claim.
 * Convex refuses a return value with a field the validator does not name, so
 * a later `...row` in the handler fails loudly in every test rather than
 * leaking quietly in production. Files reach the page as signed URLs only.
 */
const productRow = v.object({
  id: v.id('products'),
  name: v.string(),
  description: v.union(v.string(), v.null()),
  url: v.union(v.string(), v.null()),
  /** Null with no photo, or when its file is gone from storage. */
  photoUrl: v.union(v.string(), v.null()),
  pdf: v.union(
    v.null(),
    v.object({
      /** Null when the file is gone from storage: the page says so rather
       * than offering a viewer that cannot load. */
      url: v.union(v.string(), v.null()),
      fileName: v.string(),
      size: v.union(v.number(), v.null()),
    }),
  ),
  /**
   * Whether this caller may change or remove it. Sent so the page can leave
   * the Edit and Delete controls off rather than offer ones that refuse — a
   * technician whose tap does nothing learns only that the app is broken.
   */
  canEdit: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
})

/**
 * Every product the business keeps, A to Z.
 *
 * Read whole: the list is bounded (`MAX_PRODUCTS`, which `create` enforces),
 * short, and searched on the phone as it is typed into, so one cached query
 * beats paging. Ordered by the index — `nameKey`, so case and stray spaces do
 * not scatter the list.
 */
export const list = query({
  args: { businessId: v.id('businesses') },
  returns: v.array(productRow),
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)

    const rows = await ctx.db
      .query('products')
      .withIndex('by_businessId_and_nameKey', (q) =>
        q.eq('businessId', businessId),
      )
      .take(MAX_PRODUCTS)

    return Promise.all(
      rows.map(async (row) => ({
        id: row._id,
        name: row.name,
        description: row.description ?? null,
        url: row.url ?? null,
        // `getUrl` answers null for a file that is no longer stored, which is
        // what a missing photo should be: a placeholder, not a failed page.
        photoUrl: row.photoStorageId
          ? await ctx.storage.getUrl(row.photoStorageId)
          : null,
        pdf: row.pdfStorageId
          ? {
              url: await ctx.storage.getUrl(row.pdfStorageId),
              fileName: row.pdfFileName ?? cleanPdfFileName('', row.name),
              size: row.pdfSize ?? null,
            }
          : null,
        canEdit: mayEdit(env, row),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    )
  },
})

/**
 * Somewhere to upload a photo or a PDF to, for a Save about to happen.
 *
 * Gated like the Save itself, so nobody outside the business — and nobody on
 * a switch that has lapsed — can use this business's storage. What they
 * upload belongs to nothing until `create` or `update` claims it.
 */
export const generateUploadUrl = mutation({
  args: { businessId: v.id('businesses') },
  returns: v.string(),
  handler: async (ctx, { businessId }) => {
    await requireWriteActor(ctx, businessId)
    return ctx.storage.generateUploadUrl()
  },
})

/** Adds a product. Any active member; the name is the only thing required. */
export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    name: v.string(),
    description: v.optional(v.string()),
    url: v.optional(v.string()),
    photoStorageId: v.optional(v.id('_storage')),
    pdf: v.optional(pdfArg),
  },
  returns: v.id('products'),
  handler: async (ctx, args) => {
    const env = await requireWriteActor(ctx, args.businessId)

    const name = requireName(args.name)
    const nameKey = nameKeyOf(name)
    const description =
      args.description === undefined
        ? undefined
        : requireDescription(args.description)
    const url = args.url === undefined ? undefined : requireUrl(args.url)

    await refuseDuplicate(ctx, args.businessId, nameKey, null)

    // `list` reads at most MAX_PRODUCTS rows: one saved past that would be
    // accepted and then shown to nobody, which is worse than a refusal.
    const held = await ctx.db
      .query('products')
      .withIndex('by_businessId_and_nameKey', (q) =>
        q.eq('businessId', args.businessId),
      )
      .take(MAX_PRODUCTS)
    if (held.length >= MAX_PRODUCTS) {
      throw new ConvexError('TOO_MANY_PRODUCTS')
    }

    refuseSameFileTwice(args.photoStorageId, args.pdf?.storageId)
    if (args.photoStorageId !== undefined) {
      await claimFile(ctx, args.photoStorageId, 'photo')
    }
    const pdf = args.pdf
      ? {
          pdfStorageId: args.pdf.storageId,
          pdfFileName: cleanPdfFileName(args.pdf.fileName, name),
          pdfSize: (await claimFile(ctx, args.pdf.storageId, 'pdf')).size,
        }
      : {}

    const now = Date.now()
    return ctx.db.insert('products', {
      businessId: args.businessId,
      name,
      nameKey,
      description,
      url,
      photoStorageId: args.photoStorageId,
      ...pdf,
      // The person who tapped Save, whatever account they were working in.
      createdByMembershipId: env.actor.real._id,
      updatedByMembershipId: env.actor.real._id,
      createdAt: now,
      updatedAt: now,
    })
  },
})

/**
 * Changes a product. Its creator or the owner.
 *
 * Each field: left out, it is left alone; `null` clears it (a blank string
 * does too, for the description and the link). A file id the product already
 * holds in that place is left alone rather than claimed again — so a form
 * that sends back everything it loaded, changed or not, saves cleanly — and
 * the file name that comes with it is ignored: renaming a PDF is not offered.
 * Clearing or replacing a file drops the product's pointer to it and nothing
 * else (see the note at the top of this file).
 */
export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    productId: v.id('products'),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    url: v.optional(v.union(v.string(), v.null())),
    photoStorageId: v.optional(v.union(v.id('_storage'), v.null())),
    pdf: v.optional(v.union(pdfArg, v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { env, product } = await requireEditableProduct(
      ctx,
      args.businessId,
      args.productId,
    )

    const patch: Partial<Doc<'products'>> = {}

    let name = product.name
    if (args.name !== undefined) {
      name = requireName(args.name)
      const nameKey = nameKeyOf(name)
      await refuseDuplicate(ctx, args.businessId, nameKey, product._id)
      patch.name = name
      patch.nameKey = nameKey
    }
    if (args.description !== undefined) {
      patch.description =
        args.description === null
          ? undefined
          : requireDescription(args.description)
    }
    if (args.url !== undefined) {
      patch.url = args.url === null ? undefined : requireUrl(args.url)
    }

    // Only a file this product does not already hold there is a claim.
    const newPhoto =
      args.photoStorageId && args.photoStorageId !== product.photoStorageId
        ? args.photoStorageId
        : undefined
    const newPdf =
      args.pdf && args.pdf.storageId !== product.pdfStorageId
        ? args.pdf
        : undefined
    refuseSameFileTwice(newPhoto, newPdf?.storageId)

    if (args.photoStorageId === null) {
      patch.photoStorageId = undefined
    } else if (newPhoto !== undefined) {
      await claimFile(ctx, newPhoto, 'photo')
      patch.photoStorageId = newPhoto
    }

    if (args.pdf === null) {
      patch.pdfStorageId = undefined
      patch.pdfFileName = undefined
      patch.pdfSize = undefined
    } else if (newPdf !== undefined) {
      const file = await claimFile(ctx, newPdf.storageId, 'pdf')
      patch.pdfStorageId = newPdf.storageId
      patch.pdfFileName = cleanPdfFileName(newPdf.fileName, name)
      patch.pdfSize = file.size
    }

    await ctx.db.patch(product._id, {
      ...patch,
      updatedByMembershipId: env.actor.real._id,
      updatedAt: Date.now(),
    })
    return null
  },
})

/**
 * Removes a product. Its creator or the owner. The row only: its photo and
 * PDF stay in storage (see the note at the top of this file).
 */
export const remove = mutation({
  args: {
    businessId: v.id('businesses'),
    productId: v.id('products'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, productId }) => {
    const { product } = await requireEditableProduct(ctx, businessId, productId)
    await ctx.db.delete(product._id)
    return null
  },
})

// ─────────────────────────────────────────────────────────────────── helpers

/**
 * Its creator, or someone holding `templates.manage` — the owner, and only
 * while not switched into anyone's account. The same test for the flag
 * `list` sends and for the refusal a write meets, so the two cannot disagree.
 */
function mayEdit(env: ActorEnvelope, product: Doc<'products'>): boolean {
  return (
    hasCapability(env, 'templates.manage') ||
    product.createdByMembershipId === env.actor.real._id
  )
}

/**
 * The caller, and a product of THIS business they may change.
 *
 * NOT_FOUND for another business's product — the same answer as for one that
 * does not exist, so a product id says nothing about any business but the
 * caller's own — and NO_ACCESS for a product here that is not theirs to
 * change.
 */
async function requireEditableProduct(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  productId: Id<'products'>,
) {
  const env = await requireWriteActor(ctx, businessId)
  const product = await ctx.db.get(productId)
  if (!product || product.businessId !== businessId) {
    throw new ConvexError('NOT_FOUND')
  }
  if (!mayEdit(env, product)) throw new ConvexError('NO_ACCESS')
  return { env, product }
}

function requireName(input: string): string {
  const name = cleanProductName(input)
  if (name === null) throw new ConvexError('INVALID_PRODUCT')
  return name
}

function requireDescription(input: string): string | undefined {
  const description = cleanDescription(input)
  if (description === null) throw new ConvexError('INVALID_PRODUCT')
  return description
}

function requireUrl(input: string): string | undefined {
  const url = normaliseProductUrl(input)
  if (url === null) throw new ConvexError('INVALID_URL')
  return url
}

/**
 * One product per name in a business, compared folded (`nameKeyOf`): two
 * "Termidor"s nobody can tell apart are worse than being told the first one
 * is already there. `except` is the product being renamed, which may keep its
 * own name or change only its capitals.
 */
async function refuseDuplicate(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  nameKey: string,
  except: Id<'products'> | null,
) {
  const same = await ctx.db
    .query('products')
    .withIndex('by_businessId_and_nameKey', (q) =>
      q.eq('businessId', businessId).eq('nameKey', nameKey),
    )
    .take(2)
  if (same.some((row) => row._id !== except)) {
    throw new ConvexError('PRODUCT_EXISTS')
  }
}

/** One upload is a photo or a PDF, never both: each is claimed against the
 * rows already stored, so two claims in the same Save cannot see each other. */
function refuseSameFileTwice(
  photo: Id<'_storage'> | undefined,
  pdf: Id<'_storage'> | undefined,
) {
  if (photo !== undefined && photo === pdf) {
    throw new ConvexError('ALREADY_ATTACHED')
  }
}

/**
 * Takes an uploaded file for a product, or refuses it — `notes.addAttachment`'s
 * rule, with the file checked for what it is to be.
 *
 *  - It must exist and have been uploaded within `CLAIM_WINDOW_MS`: storage
 *    ids are not secrets, so only a fresh, unclaimed upload can be the one
 *    this person just made (FILE_NOT_FOUND otherwise, whichever it was).
 *  - No product may already hold it, as its photo or its PDF
 *    (ALREADY_ATTACHED): one file on two products would be one file two
 *    people think is theirs.
 *  - It must pass `checkPhotoFile` / `checkPdfFile` (WRONG_FILE_TYPE,
 *    FILE_TOO_LARGE) — the same checks the form makes before uploading, so
 *    this only ever refuses a client that skipped them.
 *
 * Returns the file's stored facts; the PDF's size is kept from them rather
 * than from anything the client said.
 */
async function claimFile(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  as: 'photo' | 'pdf',
) {
  const file = await ctx.db.system.get('_storage', storageId)
  if (!file || Date.now() - file._creationTime > CLAIM_WINDOW_MS) {
    throw new ConvexError('FILE_NOT_FOUND')
  }

  const asPdf = await ctx.db
    .query('products')
    .withIndex('by_pdfStorageId', (q) => q.eq('pdfStorageId', storageId))
    .first()
  const asPhoto = await ctx.db
    .query('products')
    .withIndex('by_photoStorageId', (q) => q.eq('photoStorageId', storageId))
    .first()
  if (asPdf || asPhoto) throw new ConvexError('ALREADY_ATTACHED')

  const refusal = as === 'pdf' ? checkPdfFile(file) : checkPhotoFile(file)
  if (refusal !== null) throw new ConvexError(refusal)
  return file
}
