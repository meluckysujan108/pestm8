import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { jobVisibility, requireMembership } from './lib/access'
import { reportTemplate } from './schema'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import type { Membership } from './lib/access'

/**
 * Reports inherit job scoping: a subcontractor without canViewAllJobs sees the
 * reports they authored, not the whole business's compliance history.
 */
function canSeeReport(m: Membership, report: Doc<'reports'>): boolean {
  const visibility = jobVisibility(m)
  return (
    visibility.scope === 'business' ||
    report.authorMembershipId === visibility.membershipId
  )
}

/**
 * The guard every report-mutating mutation repeats: resolve membership, load
 * the report, confirm it belongs to this business, and refuse a write once the
 * report is finalised or the caller did not author it.
 *
 * Centralised because this file was about to carry it a tenth time — photos,
 * signatures, drafts and finalise already had five independent copies, and the
 * gallery mutations below would have made it ten. A single source means the
 * next photo-like field kind gets this for free instead of getting it wrong.
 */
async function requireEditableReport(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  reportId: Id<'reports'>,
): Promise<{ membership: Membership; report: Doc<'reports'> }> {
  const membership = await requireMembership(ctx, businessId)

  const report = await ctx.db.get(reportId)
  if (!report || report.businessId !== businessId) {
    throw new ConvexError('NOT_FOUND')
  }
  if (report.status === 'finalised') throw new ConvexError('REPORT_FINALISED')
  if (report.authorMembershipId !== membership._id) {
    throw new ConvexError('NO_ACCESS')
  }

  return { membership, report }
}

export const listByProperty = query({
  args: { businessId: v.id('businesses'), propertyId: v.id('properties') },
  handler: async (ctx, { businessId, propertyId }) => {
    const membership = await requireMembership(ctx, businessId)

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
      .order('desc')
      .collect()

    return reports
      .filter((r) => r.businessId === businessId && canSeeReport(membership, r))
      .map(summarise)
  },
})

export const listForBusiness = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const membership = await requireMembership(ctx, businessId)

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .collect()

    const visible = reports.filter((r) => canSeeReport(membership, r))

    return Promise.all(
      visible.map(async (r) => {
        const property = await ctx.db.get(r.propertyId)
        return {
          ...summarise(r),
          clientName: property?.clientName ?? '',
          suburb: property?.suburb ?? '',
        }
      }),
    )
  },
})

function summarise(r: Doc<'reports'>) {
  return {
    _id: r._id,
    template: r.template,
    legalBasis: r.legalBasis,
    status: r.status,
    propertyId: r.propertyId,
    jobId: r.jobId,
    finalisedAt: r.finalisedAt,
    createdAt: r.createdAt,
  }
}

export const get = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const membership = await requireMembership(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return null
    if (!canSeeReport(membership, report)) return null

    const property = await ctx.db.get(report.propertyId)
    const author = await ctx.db.get(report.authorMembershipId)
    const business = await ctx.db.get(businessId)

    return {
      ...report,
      property,
      author: author && {
        _id: author._id,
        licenceNumber: author.licenceNumber,
        colour: author.colour,
      },
      businessName: business?.name ?? '',
      // A finalised report is immutable; only its author may edit a draft.
      canEdit:
        report.status === 'draft' &&
        report.authorMembershipId === membership._id,
    }
  },
})

/**
 * Short-lived upload URL. Photos go straight from the device to storage rather
 * than through a mutation — a subfloor photo from a phone is megabytes, and
 * the tech taking it is usually on mobile data under a house.
 */
export const generateUploadUrl = mutation({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireMembership(ctx, businessId)
    return ctx.storage.generateUploadUrl()
  },
})

export const attachPhoto = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    storageId: v.id('_storage'),
    slot: v.string(),
  },
  handler: async (ctx, { businessId, reportId, storageId, slot }) => {
    // Photos are evidence; a locked report must not gain new ones.
    const { report } = await requireEditableReport(ctx, businessId, reportId)

    await ctx.db.patch(reportId, {
      photoIds: [...report.photoIds, storageId],
      photoSlots: { ...(report.photoSlots ?? {}), [slot]: storageId },
    })
  },
})

/**
 * Mirrors `attachPhoto`, and deliberately so: a signature is an image the
 * client cannot afford to lose, and `data` is replaced wholesale on every save.
 * Only the `{ signedAt, signedBy }` metadata travels in the draft blob.
 */
export const attachSignature = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    storageId: v.id('_storage'),
    slot: v.string(),
  },
  handler: async (ctx, { businessId, reportId, storageId, slot }) => {
    // A signature attests to a document's contents at a moment in time. Once
    // locked, it must not be possible to attach a different one.
    const { report } = await requireEditableReport(ctx, businessId, reportId)

    await ctx.db.patch(reportId, {
      signatureSlots: { ...(report.signatureSlots ?? {}), [slot]: storageId },
    })
  },
})

/** Signed URLs for display; storage ids are useless to the client on their own. */
export const signatureUrls = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const membership = await requireMembership(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return {}
    if (!canSeeReport(membership, report)) return {}

    const entries = await Promise.all(
      Object.entries(report.signatureSlots ?? {}).map(
        async ([slot, storageId]) => {
          const url = await ctx.storage.getUrl(storageId)
          return [slot, url] as const
        },
      ),
    )

    return Object.fromEntries(entries.filter(([, url]) => url !== null))
  },
})

/**
 * Adds one photo to a `gallery` field. Unlike `attachPhoto`'s named slots, a
 * gallery has no fixed shape — `order` is simply "however many are already
 * there", so a newly taken photo lands at the end of the set.
 */
export const addGalleryPhoto = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    fieldKey: v.string(),
    storageId: v.id('_storage'),
    caption: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, reportId, fieldKey, storageId, caption }) => {
    await requireEditableReport(ctx, businessId, reportId)

    const existing = await ctx.db
      .query('reportPhotos')
      .withIndex('by_report_field', (q) =>
        q.eq('reportId', reportId).eq('fieldKey', fieldKey),
      )
      .collect()

    await ctx.db.insert('reportPhotos', {
      reportId,
      fieldKey,
      storageId,
      caption,
      order: existing.length,
      // Never automatic: "the cover photo" is a claim about which image
      // represents the report, and that is the technician's call to make, the
      // same reasoning that keeps GPS capture behind an explicit tap.
      isCover: false,
      createdAt: Date.now(),
    })
  },
})

/** Fetches and checks one gallery photo, or throws — every mutation below needs this. */
async function requireGalleryPhoto(
  ctx: MutationCtx,
  reportId: Id<'reports'>,
  photoId: Id<'reportPhotos'>,
) {
  const photo = await ctx.db.get(photoId)
  if (!photo || photo.reportId !== reportId) throw new ConvexError('NOT_FOUND')
  return photo
}

/**
 * A gallery's cover is exclusive — one photo represents the report, not a set
 * — so setting it here also clears any previous cover in the same field.
 */
export const setGalleryCover = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    photoId: v.id('reportPhotos'),
  },
  handler: async (ctx, { businessId, reportId, photoId }) => {
    await requireEditableReport(ctx, businessId, reportId)
    const photo = await requireGalleryPhoto(ctx, reportId, photoId)

    const siblings = await ctx.db
      .query('reportPhotos')
      .withIndex('by_report_field', (q) =>
        q.eq('reportId', reportId).eq('fieldKey', photo.fieldKey),
      )
      .collect()

    await Promise.all(
      siblings
        .filter((sibling) => sibling.isCover && sibling._id !== photoId)
        .map((sibling) => ctx.db.patch(sibling._id, { isCover: false })),
    )
    await ctx.db.patch(photoId, { isCover: true })
  },
})

export const updateGalleryCaption = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    photoId: v.id('reportPhotos'),
    caption: v.string(),
  },
  handler: async (ctx, { businessId, reportId, photoId, caption }) => {
    await requireEditableReport(ctx, businessId, reportId)
    await requireGalleryPhoto(ctx, reportId, photoId)
    await ctx.db.patch(photoId, { caption })
  },
})

/**
 * Swaps this photo's position with its neighbour. A full reordered array from
 * the client would let a stale draft silently undo someone else's delete;
 * a single swap is small enough to reason about as its own edit.
 */
export const moveGalleryPhoto = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    photoId: v.id('reportPhotos'),
    direction: v.union(v.literal('up'), v.literal('down')),
  },
  handler: async (ctx, { businessId, reportId, photoId, direction }) => {
    await requireEditableReport(ctx, businessId, reportId)
    const photo = await requireGalleryPhoto(ctx, reportId, photoId)

    const siblings = await ctx.db
      .query('reportPhotos')
      .withIndex('by_report_field', (q) =>
        q.eq('reportId', reportId).eq('fieldKey', photo.fieldKey),
      )
      .collect()
    siblings.sort((a, b) => a.order - b.order)

    const index = siblings.findIndex((s) => s._id === photoId)
    const neighbourIndex = direction === 'up' ? index - 1 : index + 1
    // Already at the end of its row — nothing to swap with. Checked by bounds,
    // not by the result of indexing: without `noUncheckedIndexedAccess`, an
    // out-of-range `siblings[neighbourIndex]` still types as defined, so a
    // falsy-check here would be silently wrong rather than merely undesired.
    if (neighbourIndex < 0 || neighbourIndex >= siblings.length) return
    const neighbour = siblings[neighbourIndex]

    await ctx.db.patch(photo._id, { order: neighbour.order })
    await ctx.db.patch(neighbour._id, { order: photo.order })
  },
})

export const removeGalleryPhoto = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    photoId: v.id('reportPhotos'),
  },
  handler: async (ctx, { businessId, reportId, photoId }) => {
    await requireEditableReport(ctx, businessId, reportId)
    await requireGalleryPhoto(ctx, reportId, photoId)
    await ctx.db.delete(photoId)
  },
})

/**
 * Every gallery photo on the report, across every `gallery` field it has.
 * One query rather than one per field, matching `photoUrls`/`signatureUrls` —
 * the component for a given field filters to its own `fieldKey`.
 */
export const galleryPhotos = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const membership = await requireMembership(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return []
    if (!canSeeReport(membership, report)) return []

    const photos = await ctx.db
      .query('reportPhotos')
      .withIndex('by_report_field', (q) => q.eq('reportId', reportId))
      .collect()

    const withUrls = await Promise.all(
      photos.map(async (photo) => ({
        _id: photo._id,
        fieldKey: photo.fieldKey,
        caption: photo.caption,
        order: photo.order,
        isCover: photo.isCover,
        url: await ctx.storage.getUrl(photo.storageId),
      })),
    )

    return withUrls
      .filter((photo) => photo.url !== null)
      .sort((a, b) => a.order - b.order)
  },
})

/** Signed URLs for display; storage ids are useless to the client on their own. */
export const photoUrls = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const membership = await requireMembership(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return {}
    if (!canSeeReport(membership, report)) return {}

    const entries = await Promise.all(
      Object.entries(report.photoSlots ?? {}).map(async ([slot, storageId]) => {
        const url = await ctx.storage.getUrl(storageId)
        return [slot, url] as const
      }),
    )

    return Object.fromEntries(entries.filter(([, url]) => url !== null))
  },
})

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    propertyId: v.id('properties'),
    jobId: v.optional(v.id('jobs')),
    template: reportTemplate,
    legalBasis: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.businessId)

    const property = await ctx.db.get(args.propertyId)
    if (!property || property.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    return ctx.db.insert('reports', {
      businessId: args.businessId,
      propertyId: args.propertyId,
      jobId: args.jobId,
      authorMembershipId: membership._id,
      template: args.template,
      legalBasis: args.legalBasis,
      status: 'draft',
      data: args.data ?? {},
      photoIds: [],
      createdAt: Date.now(),
    })
  },
})

export const saveDraft = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    data: v.any(),
  },
  handler: async (ctx, { businessId, reportId, data }) => {
    // The whole point of finalising is that the document stops changing. A
    // signed compliance record that can be edited afterwards is worthless.
    await requireEditableReport(ctx, businessId, reportId)

    await ctx.db.patch(reportId, { data })
  },
})

/**
 * Locks the report and raises whatever manual follow-up the template requires.
 * The durable notice is the motivating case: the app can print the label but
 * cannot fix it to the building, so it becomes a tracked task rather than an
 * assumption (§1.4).
 */
export const finalise = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    data: v.any(),
    tasks: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal('durableNotice'), v.literal('other')),
          label: v.string(),
          detail: v.optional(v.string()),
        }),
      ),
    ),
  },
  handler: async (ctx, { businessId, reportId, data, tasks }) => {
    const { membership, report } = await requireEditableReport(
      ctx,
      businessId,
      reportId,
    )

    const now = Date.now()
    await ctx.db.patch(reportId, {
      data,
      status: 'finalised',
      finalisedAt: now,
    })

    for (const task of tasks ?? []) {
      await ctx.db.insert('tasks', {
        businessId,
        reportId,
        jobId: report.jobId,
        kind: task.kind,
        label: task.label,
        detail: task.detail,
        done: false,
        assignedMembershipId: membership._id,
        createdAt: now,
      })
    }

    await ctx.db.insert('auditLog', {
      businessId,
      actorMembershipId: membership._id,
      action: 'report.finalise',
      entityType: 'reports',
      entityId: reportId,
      meta: { template: report.template, legalBasis: report.legalBasis },
      at: now,
    })

    return reportId
  },
})
