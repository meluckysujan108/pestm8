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
