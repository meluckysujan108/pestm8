import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { jobVisibility, requireMembership, resolveViewScope } from './lib/access'
import { clientNameOf, withClient } from './properties'
import { reportTemplate } from './schema'
import {
  RETIRED_TEMPLATES,
  getTemplate,
  sectionsOf,
  templateFor,
} from '../src/lib/reportTemplates'
import { freezeTemplate } from './lib/templateSnapshot'
import { buildReportContext, toPresentContext } from './lib/reportContext'
import type { ReportContextSnapshot } from './lib/reportContext'
import { applyBusinessRenames, loadOverrides } from './lib/optionSets'
import { migrateServiceReportV1 } from '../src/lib/reportTemplates/legacy/serviceReport.migrate'
import type { Doc, Id } from './_generated/dataModel'
import type { TemplateId } from '../src/lib/reportTemplates'
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
  if (report.deletedAt !== undefined) throw new ConvexError('NOT_FOUND')
  if (report.status === 'finalised') throw new ConvexError('REPORT_FINALISED')
  if (report.authorMembershipId !== membership._id) {
    throw new ConvexError('NO_ACCESS')
  }

  return { membership, report }
}

/**
 * Refuses a write from a client holding a different revision of the form than
 * the report was written against.
 *
 * The case this exists for is a stale browser tab — a service worker keeps an
 * old bundle alive — rendering yesterday's form for a draft created against
 * today's, then autosaving answers keyed and worded for the wrong one. Absent
 * means 1: a client too old to send a revision is, by definition, one that
 * only knows v1, so it can keep editing a v1 draft and is stopped at a v2 one.
 */
function requireSameVersion(
  report: Doc<'reports'>,
  clientVersion: number | undefined,
) {
  if ((clientVersion ?? 1) !== (report.templateVersion ?? 1)) {
    throw new ConvexError('TEMPLATE_VERSION_MISMATCH')
  }
}

export const listByProperty = query({
  args: { businessId: v.id('businesses'), propertyId: v.id('properties') },
  handler: async (ctx, { businessId, propertyId }) => {
    const membership = await resolveViewScope(ctx, businessId)

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
      .order('desc')
      .collect()

    return reports
      .filter(
        (r) =>
          r.businessId === businessId &&
          r.deletedAt === undefined &&
          canSeeReport(membership, r),
      )
      .map(summarise)
  },
})

export const listForBusiness = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const membership = await resolveViewScope(ctx, businessId)

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .collect()

    const visible = reports.filter(
      (r) => r.deletedAt === undefined && canSeeReport(membership, r),
    )

    // Resolved BEFORE the fan-out, not lazily inside it. Snapshots dedupe by
    // content hash, so hundreds of finalised reports share a handful of rows —
    // but `Promise.all` starts every handler before any of them can populate a
    // shared cache, so a check-then-read inside the map would miss on almost
    // every row and reintroduce the read-per-report it was meant to avoid.
    const snapshotIds = [
      ...new Set(
        visible
          .filter((r) => r.status === 'finalised' && r.templateSnapshotId)
          .map((r) => r.templateSnapshotId!),
      ),
    ]
    const snapshotNames = new Map(
      (await Promise.all(snapshotIds.map((id) => ctx.db.get(id))))
        .filter((row) => row !== null)
        .map((row) => [row._id, row.name] as const),
    )

    return Promise.all(
      visible.map(async (r) => {
        const property = await ctx.db.get(r.propertyId)
        const { templateName } = await templateDisplay(ctx, r, snapshotNames)
        // A signed report is listed as it was signed, matching the document
        // it opens — not under a client's later name.
        const frozen = r.status === 'finalised' ? r.contextSnapshot : undefined
        return {
          ...summarise(r),
          clientName: frozen?.client?.name ?? (await clientNameOf(ctx, property)),
          suburb: frozen?.property?.suburb ?? property?.suburb ?? '',
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
 *
 * A finalised report of ANY kind now reads its snapshot first. Without that,
 * renaming a built-in would retroactively relabel every historic row in the
 * list — the list saying one thing and the opened document another.
 */
async function templateDisplay(
  ctx: QueryCtx,
  r: Doc<'reports'>,
  names?: Map<Id<'reportTemplateSnapshots'>, string>,
): Promise<{ templateName: string }> {
  if (r.status === 'finalised' && r.templateSnapshotId) {
    const name =
      names?.get(r.templateSnapshotId) ??
      (await ctx.db.get(r.templateSnapshotId))?.name
    if (name) return { templateName: name }
  }

  // The revision the report was written against: a v1 draft is listed under
  // the name of the form it is actually filling in.
  if (r.template !== 'custom') {
    return { templateName: templateFor(r.template, r.templateVersion).name }
  }

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
    const viewScope = await resolveViewScope(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return null
    if (!canSeeReport(viewScope, report)) return null
    // Soft-deleted: gone from every list, and not openable by a stale link.
    if (report.deletedAt !== undefined) return null

    const rawProperty = await ctx.db.get(report.propertyId)
    const liveProperty = rawProperty && (await withClient(ctx, rawProperty))
    const author = await ctx.db.get(report.authorMembershipId)
    const business = await ctx.db.get(businessId)
    const pdfUrl = report.pdfStorageId
      ? await ctx.storage.getUrl(report.pdfStorageId)
      : null

    const finalised = report.status === 'finalised'

    // `null` for a built-in template; a **frozen** snapshot once finalised
    // (nothing may change what a signed document says); the **live** doc
    // while still a draft, since nothing is legally binding yet and picking
    // up a concurrent edit to the template is fine — see
    // `customReportTemplates`'s own schema comment for the full rationale.
    const customTemplate =
      report.template !== 'custom'
        ? null
        : finalised
          ? (report.customTemplateSnapshot ?? null)
          : report.customTemplateId
            ? await ctx.db.get(report.customTemplateId)
            : null

    // The wording this report was signed against — for EVERY kind, not just
    // custom. A missing snapshot falls back to the revision the report was
    // written against rather than failing: a row finalised before the backfill
    // ran must still open.
    const templateSnapshot =
      finalised && report.templateSnapshotId
        ? await ctx.db.get(report.templateSnapshotId)
        : null

    // What the document prints from records. Frozen once signed, when the
    // freeze exists; live otherwise — which is what a report finalised before
    // snapshots existed has always done.
    const frozen = finalised ? report.contextSnapshot : undefined
    const live = frozen
      ? null
      : await buildReportContext(
          ctx,
          report,
          (report.data ?? {}) as Record<string, unknown>,
        )
    const contextSnapshot = frozen ?? live!.snapshot
    const roster = live?.roster ?? []

    // The painter-facing record fields are overlaid from the freeze too: the
    // document's property block, header and filename read these, and freezing
    // only `context` would still let a renamed client rewrite a signed PDF's
    // header.
    const property =
      liveProperty &&
      (frozen?.property
        ? {
            ...liveProperty,
            addressLine: frozen.property.addressLine,
            suburb: frozen.property.suburb,
            state: frozen.property.state,
            postcode: frozen.property.postcode,
            client: liveProperty.client && {
              ...liveProperty.client,
              name: frozen.client?.name ?? liveProperty.client.name,
            },
          }
        : liveProperty)
    const businessFacts = frozen?.business ?? contextSnapshot.business
    const logoStorageId = frozen
      ? frozen.business?.logoStorageId
      : business?.logoStorageId
    const logoUrl = logoStorageId ? await ctx.storage.getUrl(logoStorageId) : null

    return {
      ...report,
      property,
      customTemplate,
      templateSnapshot,
      /** The records this document prints from and never asks about. */
      context: toPresentContext(contextSnapshot, finalised ? undefined : roster),
      /**
       * The team a `member` field can name, for the picker. Active members
       * only; empty for a form that names nobody, and for a signed report.
       */
      roster: finalised
        ? []
        : roster
            .filter((m) => m.status === 'active')
            .map((m) => ({ id: m._id, name: m.printed })),
      /**
       * The business's own option lists, for a report still being filled in.
       * `null` once signed: its lists were frozen with its wording.
       */
      optionSets: finalised ? null : await loadOverrides(ctx, businessId),
      /**
       * Whether this draft was written against a superseded form, and what the
       * technician can do about it: carry the answers across, or start again
       * where the questions no longer correspond.
       */
      upgrade: finalised ? null : upgradeFor(report),
      // A finalised report's data never changes, so once generated this is
      // permanently valid — `reportPdf.generate` is the cache-fill path.
      pdfUrl,
      author: author && {
        _id: author._id,
        licenceNumber: frozen
          ? frozen.author.licenceNumber
          : author.licenceNumber,
        colour: author.colour,
      },
      businessName: businessFacts?.name ?? business?.name ?? '',
      /**
       * Who an email about this report comes from and where replies go —
       * always the business as it is NOW. The frozen block above is what the
       * document printed; a reply to a mailbox the business closed is not.
       */
      sender: business && { name: business.name, email: business.email },
      business: businessFacts && {
        name: businessFacts.name,
        logoUrl,
        addressLine: businessFacts.addressLine,
        suburb: businessFacts.suburb,
        postcode: businessFacts.postcode,
        phone: businessFacts.phone,
        email: businessFacts.email,
        licenceNumber: businessFacts.licenceNumber,
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
 * Service Report answers carry across a wording change — the questions kept
 * their keys. The Timber and Certificate forms were rebuilt question by
 * question, so their old answers have nowhere to go.
 */
const SWITCHABLE: ReadonlySet<TemplateId> = new Set(['serviceReport'])

function upgradeFor(report: Doc<'reports'>): 'switch' | 'restart' | null {
  if (report.template === 'custom') return null
  const current = getTemplate(report.template).version
  if ((report.templateVersion ?? 1) >= current) return null
  return SWITCHABLE.has(report.template) ? 'switch' : 'restart'
}

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
    const membership = await resolveViewScope(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return {}
    if (report.deletedAt !== undefined) return {}
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
    const membership = await resolveViewScope(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return []
    if (report.deletedAt !== undefined) return []
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
    const membership = await resolveViewScope(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return {}
    if (report.deletedAt !== undefined) return {}
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

    // A retired built-in still renders every report written against it, but a
    // stale bundle or a direct API call must not keep minting documents that
    // have no source form behind them.
    if (args.template !== 'custom' && RETIRED_TEMPLATES.has(args.template)) {
      throw new ConvexError('TEMPLATE_RETIRED')
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
      // Stamped server-side, never accepted as an argument: which revision a
      // report was written against is a fact about the deployment, not a
      // claim a caller gets to make.
      templateVersion:
        args.template === 'custom' ? 1 : getTemplate(args.template).version,
      createdAt: Date.now(),
    })
  },
})

export const saveDraft = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    data: v.any(),
    templateVersion: v.optional(v.number()),
  },
  handler: async (ctx, { businessId, reportId, data, templateVersion }) => {
    // The whole point of finalising is that the document stops changing. A
    // signed compliance record that can be edited afterwards is worthless.
    const { report } = await requireEditableReport(ctx, businessId, reportId)
    requireSameVersion(report, templateVersion)

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
    templateVersion: v.optional(v.number()),
  },
  handler: async (ctx, { businessId, reportId, data, templateVersion }) => {
    const { membership, report } = await requireEditableReport(
      ctx,
      businessId,
      reportId,
    )
    requireSameVersion(report, templateVersion)

    // Frozen the instant this becomes a signed document — editing the live
    // custom template afterward must never change what was already finalised.
    // Undefined for a built-in template, whose 4 `.ts` files never change.
    //
    // SUPERSEDED by `templateSnapshotId` below, which covers every kind. Still
    // written for now so a rollback to the previous release finds what it
    // expects; it stops being written in the contract deploy.
    let customTemplateSnapshot:
      | {
          name: string
          shortName: string
          legalBasis: string
          blurb: string
          sections: unknown
          boilerplate: string
          terms?: unknown
          print?: Doc<'customReportTemplates'>['print']
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
          // A clone of a verbatim form prints its warranty pages from here;
          // leaving them out froze a signed report without them.
          terms: live.terms,
          print: live.print,
        }
      }
    }

    const templateSnapshotId = await freezeTemplate(ctx, report, {
      custom: customTemplateSnapshot,
    })

    // The client, site, business and technician exactly as this report prints
    // them, frozen with its wording. Built from the answers being signed, so
    // the technician a member field names is the one frozen. Protection, not
    // a precondition: a failure leaves the report reading live records, which
    // is what every report did before this existed.
    let contextSnapshot: ReportContextSnapshot | undefined
    try {
      contextSnapshot = (
        await buildReportContext(
          ctx,
          report,
          (data ?? {}) as Record<string, unknown>,
        )
      ).snapshot
    } catch (error) {
      console.error(`context snapshot failed for report ${reportId}`, error)
    }

    const now = Date.now()
    await ctx.db.patch(reportId, {
      data,
      status: 'finalised',
      finalisedAt: now,
      ...(templateSnapshotId ? { templateSnapshotId } : {}),
      ...(contextSnapshot ? { contextSnapshot } : {}),
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

/**
 * Carry a v1 Service Report draft across to the verbatim form.
 *
 * Server-side and atomic because three things must happen together or not at
 * all: the answers are re-worded, the drawn signatures (given against the old
 * wording) are cleared, and the revision flips — the last of which is what
 * makes a stale tab's next autosave bounce off `requireSameVersion` instead of
 * writing v1 answers back into a v2 draft.
 *
 * Idempotent: a draft already on the current revision is left alone.
 */
export const switchTemplateVersion = mutation({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const { membership, report } = await requireEditableReport(
      ctx,
      businessId,
      reportId,
    )
    if (report.template === 'custom') throw new ConvexError('NOT_FOUND')
    const current = getTemplate(report.template).version
    const from = report.templateVersion ?? 1
    if (from >= current) {
      return { switched: false, unmapped: [], clearedSignatures: false }
    }
    if (upgradeFor(report) !== 'switch') {
      throw new ConvexError('TEMPLATE_NOT_SWITCHABLE')
    }

    const photo = await ctx.db
      .query('reportPhotos')
      .withIndex('by_report_field', (q) =>
        q.eq('reportId', reportId).eq('fieldKey', 'photos'),
      )
      .first()

    const migrated = migrateServiceReportV1(
      (report.data ?? {}) as Record<string, unknown>,
      { hasReportPhotos: photo !== null },
    )
    const { unmapped } = migrated
    // The migration speaks the verbatim defaults. A business that has renamed
    // an option since must see its own word, not the default it replaced.
    const data = await applyBusinessRenames(
      ctx,
      businessId,
      sectionsOf(getTemplate(report.template)),
      migrated.data,
    )
    // Withdrawn whether the signature was recorded in the answers or only as a
    // drawn image, so the audit row says what actually happened.
    const clearedSignatures =
      migrated.clearedSignatures ||
      Object.keys(report.signatureSlots ?? {}).length > 0

    await ctx.db.patch(reportId, {
      data,
      templateVersion: current,
      legalBasis: getTemplate(report.template).legalBasis,
      // The drawn images stay in storage; only the report's claim that it was
      // signed is withdrawn.
      signatureSlots: undefined,
    })
    await ctx.db.insert('auditLog', {
      businessId,
      actorMembershipId: membership._id,
      action: 'report.switchVersion',
      entityType: 'reports',
      entityId: reportId,
      meta: { from, to: current, unmapped, clearedSignatures },
      at: Date.now(),
    })
    return { switched: true, unmapped, clearedSignatures }
  },
})

/**
 * Start a superseded Timber or Certificate draft again on the verbatim form.
 *
 * Those forms were rebuilt question by question, so the old answers have
 * nowhere to go. The new draft keeps the property, job and author; the old one
 * is soft-deleted rather than destroyed, because its photos are evidence and
 * permanent removal is a decision for a purge, not a side effect of a button.
 */
export const restartDraft = mutation({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const { membership, report } = await requireEditableReport(
      ctx,
      businessId,
      reportId,
    )
    if (upgradeFor(report) !== 'restart' || report.template === 'custom') {
      throw new ConvexError('TEMPLATE_NOT_RESTARTABLE')
    }
    const template = getTemplate(report.template)
    const now = Date.now()

    const newReportId = await ctx.db.insert('reports', {
      businessId,
      propertyId: report.propertyId,
      jobId: report.jobId,
      authorMembershipId: report.authorMembershipId,
      template: report.template,
      legalBasis: template.legalBasis,
      status: 'draft',
      data: {},
      photoIds: [],
      templateVersion: template.version,
      createdAt: now,
    })
    await ctx.db.patch(reportId, { deletedAt: now })
    await ctx.db.insert('auditLog', {
      businessId,
      actorMembershipId: membership._id,
      action: 'report.restart',
      entityType: 'reports',
      entityId: reportId,
      meta: {
        toReportId: newReportId,
        fromVersion: report.templateVersion ?? 1,
        toVersion: template.version,
      },
      at: now,
    })
    return newReportId
  },
})
