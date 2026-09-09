import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { jobVisibility, requireMembership } from './lib/access'
import { clientNameOf, withClient } from './properties'
import { reportTemplate } from './schema'
import { getTemplate } from '../src/lib/reportTemplates'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Membership } from './lib/access'

/**
 * Reports inherit job scoping: a subcontractor without canViewAllJobs sees the
 * reports they authored, not the whole business's compliance history.
 */
export function canSeeReport(m: Membership, report: Doc<'reports'>): boolean {
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
        const { templateName } = await templateDisplay(ctx, r)
        return {
          ...summarise(r),
          clientName: await clientNameOf(ctx, property),
          suburb: property?.suburb ?? '',
          templateName,
        }
      }),
    )
  },
})

export function summarise(r: Doc<'reports'>) {
  return {
    _id: r._id,
    template: r.template,
    legalBasis: r.legalBasis,
    status: r.status,
    propertyId: r.propertyId,
    jobId: r.jobId,
    finalisedAt: r.finalisedAt,
    emailedAt: r.emailedAt,
    createdAt: r.createdAt,
  }
}

/**
 * Display name only — a list row needs a string to show and search against,
 * not a full renderable `ReportTemplate` (that needs `resolveReportTemplate`
 * on the client, since only there does the executable Zod schema get
 * attached). Built-ins resolve statically; a custom template reads its
 * frozen name once finalised, or the live doc while still a draft — the same
 * split `reports.get`'s own `customTemplate` field draws.
 */
async function templateDisplay(
  ctx: QueryCtx,
  r: Doc<'reports'>,
): Promise<{ templateName: string }> {
  if (r.template !== 'custom') return { templateName: getTemplate(r.template).name }

  if (r.status === 'finalised') {
    const snapshot = r.customTemplateSnapshot as { name?: string } | undefined
    return { templateName: snapshot?.name ?? 'Custom template' }
  }

  const live = r.customTemplateId ? await ctx.db.get(r.customTemplateId) : null
  return { templateName: live?.name ?? 'Custom template' }
}

export const get = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const membership = await requireMembership(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return null
    if (!canSeeReport(membership, report)) return null

    const rawProperty = await ctx.db.get(report.propertyId)
    const property = rawProperty && (await withClient(ctx, rawProperty))
    const author = await ctx.db.get(report.authorMembershipId)
    const business = await ctx.db.get(businessId)
    const logoUrl = business?.logoStorageId
      ? await ctx.storage.getUrl(business.logoStorageId)
      : null
    const pdfUrl = report.pdfStorageId
      ? await ctx.storage.getUrl(report.pdfStorageId)
      : null

    // `null` for a built-in template; a **frozen** snapshot once finalised
    // (nothing may change what a signed document says); the **live** doc
    // while still a draft, since nothing is legally binding yet and picking
    // up a concurrent edit to the template is fine — see
    // `customReportTemplates`'s own schema comment for the full rationale.
    const customTemplate =
      report.template !== 'custom'
        ? null
        : report.status === 'finalised'
          ? (report.customTemplateSnapshot ?? null)
          : report.customTemplateId
            ? await ctx.db.get(report.customTemplateId)
            : null

    return {
      ...report,
      property,
      customTemplate,
      // A finalised report's data never changes, so once generated this is
      // permanently valid — `reportPdf.generate` is the cache-fill path.
      pdfUrl,
      author: author && {
        _id: author._id,
        licenceNumber: author.licenceNumber,
        colour: author.colour,
      },
      businessName: business?.name ?? '',
      business: business && {
        name: business.name,
        logoUrl,
        addressLine: business.addressLine,
        suburb: business.suburb,
        postcode: business.postcode,
        phone: business.phone,
        email: business.email,
        licenceNumber: business.licenceNumber,
      },
      // A finalised report is immutable; only its author may edit a draft.
      canEdit:
        report.status === 'draft' &&
        report.authorMembershipId === membership._id,
      // The caller's own membership — `reportPdf`/`email` actions need this
      // to attribute an audit-log entry, and can't call `requireMembership`
      // themselves (actions have no `ctx.db`).
      callerMembershipId: membership._id,
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
 * Replaces a photo's image with an annotated version — the technician marked
 * up the same evidence, so the row (order, caption, cover) stays put; only
 * the pixels change.
 */
export const annotateGalleryPhoto = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    photoId: v.id('reportPhotos'),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, { businessId, reportId, photoId, storageId }) => {
    await requireEditableReport(ctx, businessId, reportId)
    await requireGalleryPhoto(ctx, reportId, photoId)
    await ctx.db.patch(photoId, { storageId })
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
    customTemplateId: v.optional(v.id('customReportTemplates')),
    legalBasis: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.businessId)

    const property = await ctx.db.get(args.propertyId)
    if (!property || property.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    if (args.template === 'custom') {
      if (!args.customTemplateId) throw new ConvexError('NOT_FOUND')
      const custom = await ctx.db.get(args.customTemplateId)
      if (!custom || custom.businessId !== args.businessId) {
        throw new ConvexError('NOT_FOUND')
      }
      if (custom.archivedAt) throw new ConvexError('TEMPLATE_ARCHIVED')
    }

    return ctx.db.insert('reports', {
      businessId: args.businessId,
      propertyId: args.propertyId,
      jobId: args.jobId,
      authorMembershipId: membership._id,
      template: args.template,
      customTemplateId: args.template === 'custom' ? args.customTemplateId : undefined,
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
 * Locks the report as a finalised, signed document.
 */
export const finalise = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    data: v.any(),
  },
  handler: async (ctx, { businessId, reportId, data }) => {
    const { membership, report } = await requireEditableReport(
      ctx,
      businessId,
      reportId,
    )

    // Frozen the instant this becomes a signed document — editing the live
    // custom template afterward must never change what was already finalised.
    // Undefined for a built-in template, whose 4 `.ts` files never change.
    let customTemplateSnapshot:
      | {
          name: string
          shortName: string
          legalBasis: string
          blurb: string
          sections: unknown
          boilerplate: string
        }
      | undefined
    if (report.template === 'custom' && report.customTemplateId) {
      const live = await ctx.db.get(report.customTemplateId)
      if (live) {
        customTemplateSnapshot = {
          name: live.name,
          shortName: live.shortName,
          legalBasis: live.legalBasis,
          blurb: live.blurb,
          sections: live.sections,
          boilerplate: live.boilerplate,
        }
      }
    }

    const now = Date.now()
    await ctx.db.patch(reportId, {
      data,
      status: 'finalised',
      finalisedAt: now,
      ...(customTemplateSnapshot ? { customTemplateSnapshot } : {}),
    })

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

/**
 * Not exposed to clients — only `reportPdf.generate` calls this, after it has
 * already gone through `reports.get`'s own membership/visibility check to
 * fetch the data it rendered from.
 */
export const setPdfStorageId = internalMutation({
  args: { reportId: v.id('reports'), storageId: v.id('_storage') },
  handler: async (ctx, { reportId, storageId }) => {
    await ctx.db.patch(reportId, { pdfStorageId: storageId })
  },
})

/** Not exposed to clients — only `email.sendReportPdf` calls this, after a
 * real send actually succeeds. */
export const markEmailed = internalMutation({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    await ctx.db.patch(reportId, { emailedAt: Date.now() })
  },
})
