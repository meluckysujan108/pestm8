import { ConvexError, v } from 'convex/values'
import { paginationOptsValidator } from 'convex/server'
import type { FilterBuilder } from 'convex/server'
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
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
import { seedFromContext } from '../src/lib/reportTemplates/seed'
import { validateReport } from '../src/lib/reportTemplates/validate'
import { dayKeyOf, timeKeyOf, todayKeyInZone } from './lib/dates'
import { suburbKeyOf, withinForecastWindow } from './lib/forecastWindow'
import { resolveReportTemplate } from '../src/lib/reportTemplates/resolve'
import { deliveryRecipients } from '../src/lib/reportTemplates/delivery'
import { documentIdentity } from '../src/lib/reportTemplates/documentModel'
import { knownRecipients } from './lib/recipients'
import { reportSearchText } from './lib/reportSearch'
import { buildReportContext, toPresentContext } from './lib/reportContext'
import type { ReportContextSnapshot } from './lib/reportContext'
import { applyBusinessRenames, loadOverrides } from './lib/optionSets'
import { migrateServiceReportV1 } from '../src/lib/reportTemplates/legacy/serviceReport.migrate'
import type { DataModel, Doc, Id } from './_generated/dataModel'
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
      // Bounded: this is a section inside a sheet, not the library. A
      // property with years of history gets its newest, and the library is
      // one tap away for the rest.
      .take(INLINE_LIMIT)

    return decorate(
      ctx,
      reports.filter(
        (r) =>
          r.businessId === businessId &&
          r.deletedAt === undefined &&
          canSeeReport(membership, r),
      ),
    )
  },
})

/** As many as belong in a sheet section, and no more. */
export const INLINE_LIMIT = 20

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

/**
 * Rewrites a report's denormalised search string from the records it points
 * at. Cheap — three reads — and called only where a report's identity can
 * actually change: when it is created, when it gains a job, and when it locks.
 */
export async function refreshSearchText(ctx: MutationCtx, reportId: Id<'reports'>) {
  const report = await ctx.db.get(reportId)
  if (!report) return
  const { templateName } = await templateDisplay(ctx, report)
  await ctx.db.patch(reportId, {
    searchText: await reportSearchText(ctx, report, templateName),
  })
}

/**
 * The library, a page at a time.
 *
 * `listForBusiness` collects every report a business has ever made and does
 * two document reads per row — fine at thirty reports, not at three thousand,
 * and there is no point building a rail and a search box on top of a query
 * that has to read everything before it can show anything.
 *
 * Ordered by `updatedAt`, because "the one I was filling in" means the one
 * last touched rather than the one started first.
 */
export const list = query({
  args: {
    businessId: v.id('businesses'),
    filter: v.union(
      v.literal('all'),
      v.literal('draft'),
      v.literal('finalised'),
      v.literal('sent'),
      v.literal('trash'),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { businessId, filter, paginationOpts }) => {
    const membership = await resolveViewScope(ctx, businessId)

    const page = await ctx.db
      .query('reports')
      .withIndex('by_business_updated', (q) => q.eq('businessId', businessId))
      .order('desc')
      .filter((q) =>
        filter === 'trash'
          ? q.neq(q.field('deletedAt'), undefined)
          : q.eq(q.field('deletedAt'), undefined),
      )
      .filter((q) => segmentPredicate(q, filter))
      .paginate(paginationOpts)

    // Visibility is applied after the page is drawn, as it is for notes: a
    // subcontractor's page can come back short, which the paginator handles,
    // and the alternative is an index per membership.
    const visible = page.page.filter((r) => canSeeReport(membership, r))

    return { ...page, page: await decorate(ctx, visible) }
  },
})

/**
 * Finding a report by the only things anyone remembers about it: the client,
 * the street, the form, or the number they were given on the phone.
 *
 * Matches `reports.searchText`, which is denormalised precisely because none
 * of those live on the report itself.
 */
export const search = query({
  args: {
    businessId: v.id('businesses'),
    term: v.string(),
    /** The same segments as `list`: searching inside Drafts means drafts. */
    filter: v.union(
      v.literal('all'),
      v.literal('draft'),
      v.literal('finalised'),
      v.literal('sent'),
      v.literal('trash'),
    ),
  },
  handler: async (ctx, { businessId, term, filter }) => {
    if (term.trim() === '') return []
    const membership = await resolveViewScope(ctx, businessId)

    const rows = await ctx.db
      .query('reports')
      .withSearchIndex('search', (q) =>
        q.search('searchText', term).eq('businessId', businessId),
      )
      // Filtered before the take, so rows the segment excludes cannot crowd
      // real matches out of the results.
      .filter((q) =>
        filter === 'trash'
          ? q.neq(q.field('deletedAt'), undefined)
          : q.eq(q.field('deletedAt'), undefined),
      )
      .filter((q) => segmentPredicate(q, filter))
      .take(SEARCH_LIMIT)

    return decorate(ctx, rows.filter((r) => canSeeReport(membership, r)))
  },
})

/** More than fits a phone screen, far less than a scan of the business. */
const SEARCH_LIMIT = 40

/**
 * What each segment means, in one place so the paginated list and the search
 * cannot disagree — searching inside Drafts has to mean drafts, or a search
 * silently changes which tab you are on.
 *
 * "Sent" is finalised-and-emailed and "Finalised" is finalised-and-not-yet:
 * mutually exclusive buckets rather than a third status value, because a
 * finalised report can be emailed zero, one or many times.
 */
function segmentPredicate(
  q: FilterBuilder<DataModel['reports']>,
  filter: 'all' | 'draft' | 'finalised' | 'sent' | 'trash',
) {
  if (filter === 'draft') return q.eq(q.field('status'), 'draft')
  if (filter === 'finalised') {
    return q.and(
      q.eq(q.field('status'), 'finalised'),
      q.eq(q.field('emailedAt'), undefined),
    )
  }
  if (filter === 'sent') return q.neq(q.field('emailedAt'), undefined)
  return true
}

/**
 * Turns report rows into list rows: the client, the suburb and the form's
 * name, each read from the freeze once the report is signed so the list says
 * what the document says.
 */
export async function decorate(ctx: QueryCtx, rows: Array<Doc<'reports'>>) {
  // Resolved BEFORE the fan-out, not lazily inside it. Snapshots dedupe by
  // content hash, so many finalised reports share a handful of rows — but
  // `Promise.all` starts every handler before any of them can populate a
  // shared cache, so a check-then-read inside the map would miss on almost
  // every row and reintroduce the read-per-report it was meant to avoid.
  const snapshotIds = [
    ...new Set(
      rows
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
    rows.map(async (r) => {
      const property = await ctx.db.get(r.propertyId)
      const { templateName } = await templateDisplay(ctx, r, snapshotNames)
      // A signed report is listed as it was signed, matching the document it
      // opens — not under a client's later name.
      const frozen = r.status === 'finalised' ? r.contextSnapshot : undefined
      return {
        ...summarise(r),
        clientName: frozen?.client?.name ?? (await clientNameOf(ctx, property)),
        suburb: frozen?.property?.suburb ?? property?.suburb ?? '',
        templateName,
      }
    }),
  )
}

/**
 * How many of each there are, for the rail.
 *
 * Counted rather than paginated, because a badge that says "12" has to have
 * looked at all twelve. Bounded by `COUNT_LIMIT`: past that the rail says
 * "99+" rather than reading a business's whole history to draw a number.
 */
export const counts = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const membership = await resolveViewScope(ctx, businessId)
    const rows = await ctx.db
      .query('reports')
      .withIndex('by_business_updated', (q) => q.eq('businessId', businessId))
      .order('desc')
      .take(COUNT_LIMIT)

    const counted = { all: 0, draft: 0, finalised: 0, sent: 0, trash: 0 }
    for (const r of rows) {
      if (!canSeeReport(membership, r)) continue
      if (r.deletedAt !== undefined) {
        counted.trash += 1
        continue
      }
      counted.all += 1
      if (r.status === 'draft') counted.draft += 1
      else if (r.emailedAt !== undefined) counted.sent += 1
      else counted.finalised += 1
    }
    return { ...counted, capped: rows.length === COUNT_LIMIT }
  },
})

const COUNT_LIMIT = 200

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

    return {
      ...(await projectReport(ctx, report)),
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
 * Everything the document is built from, with no access check of its own.
 *
 * `reports.get` runs the checks and calls this; `getForRender` calls it with
 * none, because a scheduled render has no caller to check — a Convex action
 * runs without an identity. Keeping it one function is the point: two
 * projections of the same report would let the PDF a client is emailed differ
 * from the one on screen, and only in the fields someone forgot to copy.
 */
async function projectReport(ctx: QueryCtx, report: Doc<'reports'>) {
    const businessId = report.businessId

    const rawProperty = await ctx.db.get(report.propertyId)
    const liveProperty = rawProperty && (await withClient(ctx, rawProperty))
    const author = await ctx.db.get(report.authorMembershipId)
    const business = await ctx.db.get(businessId)
    // Only a file the CURRENT painter drew.
    //
    // Every caller treats a non-null `pdfUrl` as "no render needed" and skips
    // the pipeline entirely, so returning a stale one here made
    // `RENDER_VERSION` dead on arrival: a report that already had a file could
    // never be redrawn, and a report finalised before the document was
    // rewritten would show the new document on screen while its PDF tab,
    // download and email attachment all served the old one — permanently.
    // Withholding the URL is what sends the caller through `claimPdf`.
    const pdfUrl =
      report.pdfStorageId !== undefined &&
      (report.pdfRenderVersion ?? 0) >= RENDER_VERSION
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
      context: {
        ...toPresentContext(contextSnapshot, finalised ? undefined : roster),
        // The images themselves, so the document draws the signature rather
        // than describing it. Resolved here rather than in a second query
        // because both painters read this one context.
        signatureUrls: await resolveSignatureUrls(ctx, report),
      },
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
      // Present only while the stored file is one the current painter drew;
      // null sends the caller to `reportPdf.generate`, which claims the work
      // and redraws it. See `RENDER_VERSION`.
      pdfUrl,
      author: author && {
        _id: author._id,
        // The name the document's footer prints, frozen at finalise.
        name: contextSnapshot.author.name,
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
        // Frozen with the rest of the context: a business that rebrands next
        // year must not rewrite the header of a document it issued this one.
        tradingName: businessFacts.tradingName,
        brandName: businessFacts.brandName,
        website: businessFacts.website,
        logoUrl,
        addressLine: businessFacts.addressLine,
        suburb: businessFacts.suburb,
        postcode: businessFacts.postcode,
        phone: businessFacts.phone,
        email: businessFacts.email,
        licenceNumber: businessFacts.licenceNumber,
      },
    }
}

/**
 * The same projection, for work that runs with no caller: the PDF render
 * `finalise` schedules. Internal, so it is unreachable from a client.
 */
export const getForRender = internalQuery({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get(reportId)
    if (!report || report.deletedAt !== undefined) return null
    return projectReport(ctx, report)
  },
})

/** Where a report's render is up to — small enough to poll while one runs. */
export const pdfPointer = internalQuery({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get(reportId)
    if (!report) return null
    return {
      status: report.pdfStatus,
      storageId: report.pdfStorageId,
      renderVersion: report.pdfRenderVersion ?? 0,
    }
  },
})

/**
 * The report's evidence, for the same caller-less render.
 *
 * The public `galleryPhotos` and `photoUrls` both start with a membership
 * check, and a scheduled action has no identity to check — it would be
 * refused, and the document would print without its photos while looking
 * perfectly fine.
 */
export const photosForRender = internalQuery({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get(reportId)
    if (!report) return { gallery: [], slots: {} }

    const rows = await ctx.db
      .query('reportPhotos')
      .withIndex('by_report_field', (q) => q.eq('reportId', reportId))
      .collect()

    const gallery = (
      await Promise.all(
        rows
          .sort((a, b) => a.order - b.order)
          .map(async (photo) => ({
            fieldKey: photo.fieldKey,
            caption: photo.caption,
            order: photo.order,
            isCover: photo.isCover,
            width: photo.width,
            height: photo.height,
            url: await ctx.storage.getUrl(photo.storageId),
          })),
      )
    ).filter((photo) => photo.url !== null)

    const slotEntries = await Promise.all(
      Object.entries(report.photoSlots ?? {}).map(async ([slot, storageId]) => {
        const url = await ctx.storage.getUrl(storageId)
        return [slot, url] as const
      }),
    )

    return {
      gallery,
      slots: Object.fromEntries(
        slotEntries.filter((entry): entry is [string, string] => entry[1] !== null),
      ),
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
    /** Typed by whoever signed, where the form asks for their name. */
    signedBy: v.optional(v.string()),
    /** The words printed above the pad, frozen with the signature. */
    statement: v.optional(v.string()),
    /** Set when reusing this member's own saved signature. */
    method: v.optional(v.union(v.literal('drawn'), v.literal('saved'))),
    /** Also keep this drawing as the signer's own, for their next report. */
    saveForMember: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { businessId, reportId, storageId, slot, signedBy, statement, method, saveForMember },
  ) => {
    // A signature attests to a document's contents at a moment in time. Once
    // locked, it must not be possible to attach a different one.
    const { membership, report } = await requireEditableReport(ctx, businessId, reportId)

    await ctx.db.patch(reportId, {
      signatureSlots: {
        ...(report.signatureSlots ?? {}),
        [slot]: {
          storageId,
          signedAt: Date.now(),
          method: method ?? 'drawn',
          ...(signedBy ? { signedBy } : {}),
          // Frozen with the signature: what a business prints can be edited
          // afterwards, and what somebody agreed to cannot.
          ...(statement ? { statement } : {}),
          templateVersion: report.templateVersion,
          capturedByMembershipId: membership._id,
        },
      },
    })

    // Their own signature, kept for their own next report — and only ever the
    // caller's own membership.
    if (saveForMember) {
      await ctx.db.patch(membership._id, { savedSignatureStorageId: storageId })
    }
  },
})

/**
 * The caller's saved signature, if they have one.
 *
 * Scoped to the real caller rather than to whoever they may be viewing as, and
 * returning a storage id the client hands straight back to `attachSignature`:
 * a member may only ever apply their own.
 */
export const mySavedSignature = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const membership = await requireMembership(ctx, businessId)
    if (!membership.savedSignatureStorageId) return null
    const url = await ctx.storage.getUrl(membership.savedSignatureStorageId)
    return url ? { storageId: membership.savedSignatureStorageId, url } : null
  },
})

/**
 * The image behind a signature slot, whichever shape the row holds.
 *
 * Rows written before signatures carried their provenance hold a bare storage
 * id. Both are read here rather than at each call site, so a reader cannot
 * quietly forget the older shape and start rendering nothing.
 */
function storageIdOf(
  held: NonNullable<Doc<'reports'>['signatureSlots']>[string],
): Id<'_storage'> {
  return typeof held === 'string' ? held : held.storageId
}

/** Signed URLs for display; storage ids are useless to the client on their own. */
export const signatureUrls = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const membership = await resolveViewScope(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return {}
    if (report.deletedAt !== undefined) return {}
    if (!canSeeReport(membership, report)) return {}

    return resolveSignatureUrls(ctx, report)
  },
})

/**
 * Slot → a URL for the image drawn there.
 *
 * Shared by the standalone query above and by `reports.get`, because the
 * document prints the signature and the builder only needs to know one exists
 * — and two readers of the same slots that resolve them differently is how a
 * PDF comes to show a signature the screen does not.
 */
async function resolveSignatureUrls(
  ctx: { storage: { getUrl: (id: Id<'_storage'>) => Promise<string | null> } },
  report: Doc<'reports'>,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(report.signatureSlots ?? {}).map(async ([slot, held]) => {
      const url = await ctx.storage.getUrl(storageIdOf(held))
      return [slot, url] as const
    }),
  )
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string] => entry[1] !== null),
  )
}

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
    /** What the image is, so the document can lay it out at its own aspect. */
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    bytes: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { businessId, reportId, fieldKey, storageId, caption, width, height, bytes },
  ) => {
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
      // Absent when the browser could not decode the image well enough to say.
      ...(width && height ? { width, height } : {}),
      ...(bytes ? { bytes } : {}),
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
        // So a document can lay the photo out at its own aspect; absent for
        // rows written before this, which fall back to a fixed box.
        width: photo.width,
        height: photo.height,
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

/**
 * The answers a new report starts with, and which of them were guesses.
 *
 * Every fact here comes from a record the business already keeps: the job's
 * day and start, who it is assigned to, whether the client has an email. The
 * only guesses are the forecast and, when work has not been started, the
 * booked time — both recorded in `prefill` so the technician confirms them
 * before the report can be finalised.
 *
 * Fails soft by design. A missing job, an unresolvable suburb or a forecast
 * that has not been fetched yet must never stop someone starting a report, so
 * anything unavailable is simply left blank for them to fill.
 */
async function seedNewReport(
  ctx: MutationCtx,
  args: {
    businessId: Id<'businesses'>
    propertyId: Id<'properties'>
    jobId?: Id<'jobs'>
    template: TemplateId | 'custom'
    customTemplateId?: Id<'customReportTemplates'>
    authorMembershipId: Id<'memberships'>
    given: Record<string, unknown>
  },
): Promise<{
  data: Record<string, unknown>
  prefill: Record<string, { source: 'forecast' | 'scheduled' | 'lastVisit' | 'history' }>
  fetchWeather: { state: string; suburb: string; postcode: string; dayKey: string } | null
}> {
  const business = await ctx.db.get(args.businessId)
  if (!business) return { data: args.given, prefill: {}, fetchWeather: null }
  const timezone = business.timezone

  // An id is only as trustworthy as the check behind it: a job from another
  // business, or at another address, seeds nothing.
  const job = args.jobId ? await ctx.db.get(args.jobId) : null
  const usableJob =
    job && job.businessId === args.businessId && job.propertyId === args.propertyId ? job : null

  const property = await ctx.db.get(args.propertyId)
  const client = property ? await ctx.db.get(property.clientId) : null

  const template = await templateForNewReport(ctx, args)
  if (!template) return { data: args.given, prefill: {}, fetchWeather: null }

  const dayKey = usableJob ? dayKeyOf(usableJob.scheduledAt, timezone) : undefined
  const forecast = property && dayKey ? await cachedForecast(ctx, property, dayKey, timezone) : null

  const { data, prefill } = seedFromContext(
    template,
    {
      today: todayKeyInZone(timezone),
      jobDate: dayKey,
      startedTime: usableJob?.startedAt ? timeKeyOf(usableJob.startedAt, timezone) : undefined,
      scheduledTime: usableJob ? timeKeyOf(usableJob.scheduledAt, timezone) : undefined,
      jobType: usableJob?.jobType,
      clientEmail: client?.email ?? null,
      jobAssigneeMembershipId: usableJob?.assignedMembershipId,
      authorMembershipId: args.authorMembershipId,
      forecast,
    },
    args.given,
  )

  // What the caller supplied wins: `restartDraft` and the e2e fixtures both
  // hand over answers that must not be second-guessed.
  return {
    data: { ...data, ...args.given },
    prefill,
    // Nothing cached for that day yet: fetch it in the background and patch it
    // in when it lands. A suggestion arriving a second late is fine — it is a
    // suggestion — and waiting on a third-party API to start a report is not.
    fetchWeather:
      property && dayKey && !forecast && withinForecastWindow(dayKey, todayKeyInZone(timezone))
        ? { state: property.state, suburb: property.suburb, postcode: property.postcode, dayKey }
        : null,
  }
}

/** The template a report about to be created will be filled against. */
async function templateForNewReport(
  ctx: MutationCtx,
  args: { businessId: Id<'businesses'>; template: TemplateId | 'custom'; customTemplateId?: Id<'customReportTemplates'> },
) {
  const optionSets = await loadOverrides(ctx, args.businessId)
  if (args.template !== 'custom') {
    return resolveReportTemplate({
      template: args.template,
      templateVersion: getTemplate(args.template).version,
      optionSets,
    })
  }
  const custom = args.customTemplateId ? await ctx.db.get(args.customTemplateId) : null
  if (!custom) return null
  return resolveReportTemplate({ template: 'custom', customTemplate: custom, optionSets })
}

/**
 * The forecast already on file for this address and day.
 *
 * Read-only: a mutation cannot call the fetching action, and a report must not
 * wait on a third-party API. When nothing is cached the weather question is
 * simply left for the technician, who was standing in it.
 */
async function cachedForecast(
  ctx: MutationCtx,
  property: Doc<'properties'>,
  dayKey: string,
  timezone: string,
) {
  if (!withinForecastWindow(dayKey, todayKeyInZone(timezone))) return null
  const row = await ctx.db
    .query('weatherCache')
    .withIndex('by_suburb_day', (q) =>
      q.eq('suburbKey', suburbKeyOf(property.suburb, property.postcode)).eq('dayKey', dayKey),
    )
    .unique()
  return row ? { rainMm: row.rainMm, windKmh: row.windKmh, code: row.code } : null
}

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

    // A report started from a job knows the day, the time, who is on it and
    // what the weather was doing. Seeded here rather than in the browser so
    // the stored row matches what the technician sees from the first moment —
    // a draft abandoned before the first keystroke used to hold nothing at all.
    const seeded = await seedNewReport(ctx, {
      businessId: args.businessId,
      propertyId: args.propertyId,
      jobId: args.jobId,
      template: args.template,
      customTemplateId: args.customTemplateId,
      authorMembershipId: membership._id,
      given: (args.data ?? {}) as Record<string, unknown>,
    })

    const reportId = await ctx.db.insert('reports', {
      businessId: args.businessId,
      propertyId: args.propertyId,
      jobId: args.jobId,
      authorMembershipId: membership._id,
      template: args.template,
      customTemplateId: args.template === 'custom' ? args.customTemplateId : undefined,
      legalBasis: args.legalBasis,
      status: 'draft',
      data: seeded.data,
      ...(Object.keys(seeded.prefill).length > 0 ? { prefill: seeded.prefill } : {}),
      photoIds: [],
      // Stamped server-side, never accepted as an argument: which revision a
      // report was written against is a fact about the deployment, not a
      // claim a caller gets to make.
      templateVersion:
        args.template === 'custom' ? 1 : getTemplate(args.template).version,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    // Written after the insert, because it reads the row it describes. A
    // report is findable by client, address and form from the moment it
    // exists, not from the moment it is first saved.
    await refreshSearchText(ctx, reportId)

    if (seeded.fetchWeather) {
      await ctx.scheduler.runAfter(0, internal.weather.fillForReport, {
        reportId,
        ...seeded.fetchWeather,
      })
    }

    return reportId
  },
})

/**
 * Writes a forecast that arrived after the report was created.
 *
 * Only ever fills a blank: by the time this runs the technician may already
 * have answered, and the app overwriting their own observation with a guess
 * from an API would be exactly backwards. Internal, because the caller is a
 * scheduled action with no identity — `reports.create` did the checking.
 */
export const applyWeatherSuggestion = internalMutation({
  args: {
    reportId: v.id('reports'),
    forecast: v.object({
      rainMm: v.optional(v.number()),
      windKmh: v.optional(v.number()),
      code: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { reportId, forecast }) => {
    const report = await ctx.db.get(reportId)
    if (!report || report.status !== 'draft' || report.deletedAt) return

    const optionSets = await loadOverrides(ctx, report.businessId)
    const template = resolveReportTemplate({
      template: report.template,
      templateVersion: report.templateVersion,
      customTemplate: report.customTemplateId
        ? ((await ctx.db.get(report.customTemplateId)) ?? undefined)
        : undefined,
      optionSets,
    })

    const data = (report.data ?? {}) as Record<string, unknown>
    const business = await ctx.db.get(report.businessId)
    const { data: seeded, prefill } = seedFromContext(
      template,
      { today: todayKeyInZone(business?.timezone ?? 'Australia/Perth'), forecast },
      data,
    )
    if (Object.keys(seeded).length === 0) return

    await ctx.db.patch(reportId, {
      data: { ...data, ...seeded },
      prefill: { ...(report.prefill ?? {}), ...prefill },
    })
  },
})

/**
 * Marks answers the app suggested as seen and agreed to.
 *
 * Sent as the technician passes each section, so confirming costs no extra
 * taps — but until it happens, `finalise` refuses. The confirmation is kept
 * beside the answer rather than inside it, because `data` is replaced wholesale
 * on every autosave.
 */
export const confirmPrefill = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    keys: v.array(v.string()),
  },
  handler: async (ctx, { businessId, reportId, keys }) => {
    const { report } = await requireEditableReport(ctx, businessId, reportId)
    const prefill = report.prefill
    if (!prefill) return

    const now = Date.now()
    const next = { ...prefill }
    let changed = false
    for (const key of keys) {
      // A key the app never suggested, or one already confirmed, is a no-op:
      // a client is free to send the whole section's keys every time.
      if (!(key in next)) continue
      const entry = next[key]
      if (entry.confirmedAt !== undefined) continue
      next[key] = { ...entry, confirmedAt: now }
      changed = true
    }
    if (changed) await ctx.db.patch(reportId, { prefill: next })
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

    // The library orders by this: "the one I was filling in" means the one
    // they last touched, not the one they started first.
    await ctx.db.patch(reportId, { data, updatedAt: Date.now() })
  },
})

/**
 * Locks the report as a finalised, signed document.
 */
/**
 * Refuses a report that is not finished, naming what is missing.
 *
 * The issues travel with the error so the builder can mark the fields and jump
 * to them, rather than showing "something went wrong" about a document the
 * technician believes they completed.
 */
async function assertComplete(
  ctx: MutationCtx,
  report: Doc<'reports'>,
  data: Record<string, unknown>,
) {
  const optionSets = await loadOverrides(ctx, report.businessId)
  const template = resolveReportTemplate({
    template: report.template,
    // The revision this report was WRITTEN against: a v1 draft is judged by
    // the rules it was filled under, never by today's form.
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplateId
      ? ((await ctx.db.get(report.customTemplateId)) ?? undefined)
      : undefined,
    optionSets,
  })

  const photos = await ctx.db
    .query('reportPhotos')
    .withIndex('by_report_field', (q) => q.eq('reportId', report._id))
    .collect()
  const photoCounts: Record<string, number> = {}
  for (const photo of photos) {
    photoCounts[photo.fieldKey] = (photoCounts[photo.fieldKey] ?? 0) + 1
  }
  for (const slot of Object.keys(report.photoSlots ?? {})) {
    photoCounts[slot] = (photoCounts[slot] ?? 0) + 1
  }

  const result = validateReport({
    template,
    data,
    signedSlots: Object.keys(report.signatureSlots ?? {}),
    photoCounts,
    prefill: report.prefill,
  })

  if (!result.ok) {
    throw new ConvexError({ code: 'REPORT_INCOMPLETE', issues: result.issues })
  }
}

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

    // The same rules the builder applies, applied again where they are true.
    // Until now they lived only in the browser, so a stale tab or a direct API
    // call could lock an unsigned, undated document — and a compliance record
    // whose rules are advisory is not a compliance record.
    await assertComplete(ctx, report, (data ?? {}) as Record<string, unknown>)

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
    // Allocated here rather than at create: a draft that is never finished
    // should not consume a number from a sequence a client may later quote
    // back over the phone. Read-then-patch is race-safe inside a Convex
    // mutation, the same way `jobs.create` hands out job numbers.
    const business = await ctx.db.get(businessId)
    const reportNumber = report.reportNumber ?? business?.nextReportNumber ?? 1
    if (report.reportNumber === undefined) {
      await ctx.db.patch(businessId, { nextReportNumber: reportNumber + 1 })
    }

    await ctx.db.patch(reportId, {
      data,
      status: 'finalised',
      finalisedAt: now,
      updatedAt: now,
      pdfStatus: 'pending',
      reportNumber,
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

    if (report.previewStorageId) {
      // The draft's watermarked preview is a guess at a document that now
      // exists for real.
      await ctx.storage.delete(report.previewStorageId)
      await ctx.db.patch(reportId, { previewStorageId: undefined })
    }

    // The freeze changed what this report is called and gave it a number,
    // both of which someone will search for.
    await refreshSearchText(ctx, reportId)

    // What the form itself asked for. Opened as a delivery row here, in the
    // same transaction that locks the report, so "the form said send it" is
    // recorded even if the send never happens — and a recipient nobody has on
    // file waits for an owner, exactly as it would from the send sheet.
    await queueFormDeliveries(ctx, report, data, membership)

    // Render now, not when someone first asks for it. The technician who
    // locked this is standing in a driveway; the person who opens the PDF
    // should not be the one who pays for drawing it. The pipeline sends
    // whatever is queued once there is a file to attach.
    await ctx.scheduler.runAfter(0, internal.reportPipeline.afterFinalise, {
      reportId,
    })

    return reportId
  },
})

/**
 * Opens the deliveries the form asked for, at the moment it is locked.
 *
 * A technician who ticked "Send copy of the report to the client email above"
 * has given an instruction, and it belongs to the record whether or not the
 * provider is configured, whether or not the send succeeds. The recipient rule
 * applies here too: a novel address typed into `Email Report To` is a request
 * an owner approves, not a send that happens because a form was locked.
 */
async function queueFormDeliveries(
  ctx: MutationCtx,
  report: Doc<'reports'>,
  data: Record<string, unknown>,
  membership: Membership,
) {
  const template = resolveReportTemplate({
    template: report.template,
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplateId
      ? ((await ctx.db.get(report.customTemplateId)) ?? undefined)
      : undefined,
  })
  const property = await ctx.db.get(report.propertyId)
  const client = property ? await ctx.db.get(property.clientId) : null
  const business = await ctx.db.get(report.businessId)

  const { to, cc } = deliveryRecipients(template, data, {
    clientEmail: client?.email,
    businessCopyEmail: business?.reportCopyEmail ?? business?.email,
  })
  if (to.length === 0) return

  const known = await knownRecipients(ctx, report)
  const unrestricted =
    membership.role === 'owner' || business?.allowTechnicianRecipients === true
  const novel = to.filter((address) => !known.includes(address))

  await ctx.db.insert('reportDeliveries', {
    businessId: report.businessId,
    reportId: report._id,
    to,
    cc,
    subject: documentIdentity({
      template,
      property,
      businessName: business?.name ?? '',
      finalisedAt: Date.now(),
    }).title,
    trigger: 'finalise',
    status: unrestricted || novel.length === 0 ? 'queued' : 'pendingApproval',
    sentByMembershipId: membership._id,
    createdAt: Date.now(),
  })
}

/**
 * Deleting a draft, and only a draft.
 *
 * A finalised report is a record the business is required to keep — WA's
 * pesticide regulations say three years, ten where a termite certificate is
 * involved — so there is deliberately no way to delete one, from here or
 * anywhere. What lands in Recently Deleted is work in progress: a report
 * started on the wrong property, a duplicate, a test.
 *
 * Soft, because the photos attached to a draft are evidence somebody stood
 * somewhere and took them. Thirty days, then the nightly purge.
 */
export const softDelete = mutation({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const report = await requireDeletable(ctx, businessId, reportId)
    if (report.deletedAt !== undefined) return
    await ctx.db.patch(reportId, { deletedAt: Date.now(), updatedAt: Date.now() })
  },
})

export const restore = mutation({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const report = await requireDeletable(ctx, businessId, reportId)
    if (report.deletedAt === undefined) return
    await ctx.db.patch(reportId, { deletedAt: undefined, updatedAt: Date.now() })
  },
})

/**
 * Gone for good, with its photos and its signatures. Only from Recently
 * Deleted — the thirty-day safety net is not optional.
 */
export const remove = mutation({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const report = await requireDeletable(ctx, businessId, reportId)
    if (report.deletedAt === undefined) throw new ConvexError('NOT_IN_TRASH')
    await purgeReport(ctx, report)
  },
})

/**
 * Who may retire a draft: its author, or an owner.
 *
 * Deliberately NOT `requireEditableReport`, which is author-only — an owner
 * has to be able to clear a subcontractor's abandoned draft off the list. And
 * deliberately the REAL membership, not the view-as scope: looking through
 * someone else's eyes is a way to read, never a way to delete.
 */
async function requireDeletable(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  reportId: Id<'reports'>,
): Promise<Doc<'reports'>> {
  const membership = await requireMembership(ctx, businessId)
  const report = await ctx.db.get(reportId)
  if (!report || report.businessId !== businessId) throw new ConvexError('NOT_FOUND')
  if (report.status === 'finalised') throw new ConvexError('REPORT_FINALISED')
  if (
    membership.role !== 'owner' &&
    report.authorMembershipId !== membership._id
  ) {
    throw new ConvexError('NO_ACCESS')
  }
  return report
}

/**
 * Everything a draft owns. The storage blobs go only after a reference check,
 * because an image can be shared — a saved signature belongs to the member,
 * not to this report, and deleting it here would blank it on every other.
 */
async function purgeReport(ctx: MutationCtx, report: Doc<'reports'>) {
  const photos = await ctx.db
    .query('reportPhotos')
    .withIndex('by_report_field', (q) => q.eq('reportId', report._id))
    .collect()
  for (const photo of photos) {
    await ctx.db.delete(photo._id)
    const stillUsed = await ctx.db
      .query('reportPhotos')
      .withIndex('by_storage', (q) => q.eq('storageId', photo.storageId))
      .first()
    if (!stillUsed) await ctx.storage.delete(photo.storageId)
  }

  for (const held of Object.values(report.signatureSlots ?? {})) {
    const storageId = storageIdOf(held)
    const savedBy = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', report.businessId))
      .filter((q) => q.eq(q.field('savedSignatureStorageId'), storageId))
      .first()
    // A member's saved signature is theirs, not this report's.
    if (!savedBy) await ctx.storage.delete(storageId)
  }

  for (const slot of Object.values(report.photoSlots ?? {})) {
    await ctx.storage.delete(slot)
  }
  if (report.previewStorageId) await ctx.storage.delete(report.previewStorageId)

  await ctx.db.delete(report._id)
}

/** Long enough to notice a mistake, short enough not to be a second archive. */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TRASH_RETENTION_MS
    const batch = await ctx.db
      .query('reports')
      .withIndex('by_deletedAt', (q) => q.gt('deletedAt', 0).lt('deletedAt', cutoff))
      .take(PURGE_BATCH)
    for (const report of batch) {
      // A report that was finalised while in the trash is a record now, and
      // records are not purged. Restoring it to the list is the honest move.
      if (report.status === 'finalised') {
        await ctx.db.patch(report._id, { deletedAt: undefined })
        continue
      }
      await purgeReport(ctx, report)
    }
    if (batch.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.reports.purgeExpired, {})
    }
  },
})

const PURGE_BATCH = 25

/**
 * The version of the painter. Bumping it makes every report re-render on its
 * next open, which is how a fix to the document reaches files already drawn.
 * A superseded file is kept, never deleted: it is what someone was sent.
 */
export const RENDER_VERSION = 2

/**
 * Take the job of rendering this report, or say who already has it.
 *
 * Every caller goes through here — the pipeline after finalise, the PDF tab,
 * a download, an email — because without a claim two tabs opening at the same
 * moment both render, both store, and the loser's file is orphaned in storage
 * with nothing pointing at it and nothing to clean it up.
 *
 * Returns the existing file when one is current, so the claim doubles as the
 * cache read the callers used to do for themselves.
 */
export const claimPdf = internalMutation({
  args: { reportId: v.id('reports') },
  handler: async (
    ctx,
    { reportId },
  ): Promise<
    | { claimed: true }
    | { claimed: false; storageId?: Id<'_storage'>; reason: 'ready' | 'busy' | 'gone' }
  > => {
    const report = await ctx.db.get(reportId)
    if (!report || report.status !== 'finalised') {
      return { claimed: false, reason: 'gone' }
    }

    const current =
      report.pdfStorageId !== undefined &&
      (report.pdfRenderVersion ?? 0) >= RENDER_VERSION
    if (current) {
      return { claimed: false, storageId: report.pdfStorageId, reason: 'ready' }
    }

    // A claim that never settled — the action died mid-render — must not lock
    // the report out of ever having a PDF. Five minutes is far longer than a
    // render and far shorter than a technician's patience.
    const stale =
      report.pdfStatus !== 'generating' ||
      (report.pdfGeneratedAt ?? 0) < Date.now() - 5 * 60_000
    if (!stale) return { claimed: false, reason: 'busy' }

    await ctx.db.patch(reportId, {
      pdfStatus: 'generating',
      pdfGeneratedAt: Date.now(),
    })
    return { claimed: true }
  },
})

/**
 * Records a rendered file: a new `reportPdfs` row, and the report's pointer
 * moved to it. The old row stays — it is the file someone was sent.
 */
export const setPdf = internalMutation({
  args: {
    reportId: v.id('reports'),
    storageId: v.id('_storage'),
    bytes: v.number(),
  },
  handler: async (ctx, { reportId, storageId, bytes }) => {
    const report = await ctx.db.get(reportId)
    if (!report) return

    await ctx.db.insert('reportPdfs', {
      businessId: report.businessId,
      reportId,
      storageId,
      rendererVersion: RENDER_VERSION,
      templateVersion: report.templateVersion,
      version: 1,
      bytes,
      createdAt: Date.now(),
    })
    await ctx.db.patch(reportId, {
      pdfStorageId: storageId,
      pdfStatus: 'ready',
      pdfRenderVersion: RENDER_VERSION,
      pdfGeneratedAt: Date.now(),
    })
  },
})

/**
 * Points the report at a fresh preview and throws the last one away.
 *
 * Deleting here rather than on a schedule keeps it to one blob per draft: a
 * preview is only ever interesting until the next one is drawn.
 */
export const setPreview = internalMutation({
  args: { reportId: v.id('reports'), storageId: v.id('_storage') },
  handler: async (ctx, { reportId, storageId }) => {
    const report = await ctx.db.get(reportId)
    if (!report) return
    if (report.previewStorageId) {
      await ctx.storage.delete(report.previewStorageId)
    }
    await ctx.db.patch(reportId, { previewStorageId: storageId })
  },
})

/** Releases the claim so the next open tries again rather than waiting on it. */
export const failPdf = internalMutation({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get(reportId)
    if (report?.pdfStatus !== 'generating') return
    await ctx.db.patch(reportId, { pdfStatus: 'failed' })
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
