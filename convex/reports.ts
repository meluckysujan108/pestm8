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
import { settingsFor } from './templateSettings'
import { reportSearchText } from './lib/reportSearch'
import {
  MAX_MEMBERS,
  buildReportContext,
  memberFieldKeys,
  namedMembers,
  technicianSignatureSlots,
  toPresentContext,
} from './lib/reportContext'
import type {
  ReportContextSnapshot,
  RosterEntry,
} from './lib/reportContext'
import type { ActorEnvelope, WriteEnvelope } from './lib/actor'
import { printedMemberName } from '../src/lib/reportTemplates/memberName'
import { applyBusinessRenames, loadOverrides } from './lib/optionSets'
import { canCarryFrom, carryOverFrom } from '../src/lib/reportTemplates/lastVisit'
import { migrateServiceReportV1 } from '../src/lib/reportTemplates/legacy/serviceReport.migrate'
import type { DataModel, Doc, Id } from './_generated/dataModel'
import {
  canEditReport,
  canFinaliseReport,
  mergeDraft,
  reportReadable,
  writeAttribution,
} from './lib/capabilities'
import type { RowScope } from './lib/capabilities'
import { reportFactsFrom } from './lib/reportFacts'
import { factsFromMembership } from './lib/membershipFacts'
import type { TemplateId } from '../src/lib/reportTemplates'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { recordAudit, recordOnBehalf, recordOnce } from './lib/audit'
import { hasCapability, requireActor, requireWriteActor } from './lib/actor'

/**
 * The guard every report-mutating mutation repeats: resolve the writer, load
 * the report, confirm it belongs to this business, and refuse a write once the
 * report is finalised or the writer may not edit it (`canEditReport`).
 *
 * Centralised because this file was about to carry it a tenth time — photos,
 * signatures, drafts and finalise already had five independent copies, and the
 * gallery mutations below would have made it ten. A single source means the
 * next photo-like field kind gets this for free instead of getting it wrong.
 *
 * Through the WRITE actor, on the account being worked in. It used to demand
 * that the REAL person wrote the draft, which could not be squared with
 * working in someone else's account: an owner inside Kevin's account could not
 * touch Kevin's drafts, and a report he started there was his own, invisible
 * to Kevin. It also never read a switch at all, so one past its twelve hours
 * still wrote. `create` and this gate moved together — either alone makes a
 * report its own writer cannot edit.
 */
async function requireEditableReport(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  reportId: Id<'reports'>,
): Promise<{ env: WriteEnvelope; report: Doc<'reports'> }> {
  const env = await requireWriteActor(ctx, businessId)

  const report = await ctx.db.get(reportId)
  if (!report || report.businessId !== businessId) {
    throw new ConvexError('NOT_FOUND')
  }
  if (report.deletedAt !== undefined) throw new ConvexError('NOT_FOUND')
  if (report.status === 'finalised') throw new ConvexError('REPORT_FINALISED')
  if (!canEditReport(env.actor, reportFactsFrom(report))) {
    throw new ConvexError('NO_ACCESS')
  }

  await recordEditByAnother(ctx, env, report)
  return { env, report }
}

/** How long one row stands for an owner's edits to someone else's draft: a
 * working day, the length of a switch. */
const OWNER_EDIT_WINDOW_MS = 12 * 60 * 60 * 1000

/**
 * Who else was in this draft, on the draft's own history.
 *
 * `canEditReport` lets two people change a draft that is not theirs: someone
 * working inside the author's account, and the owner from his own. Either way
 * the author goes on to finalise answers they did not all write, and the
 * report is the only place that could say so — nothing on the row records who
 * typed what. Once per sitting rather than per autosave (`recordOnce`): per
 * switch while switched, per working day for the owner.
 *
 * Here, in the gate, so every edit path records it without remembering to. It
 * writes inside the caller's transaction, so an edit that is then refused
 * leaves no row claiming it happened.
 */
async function recordEditByAnother(
  ctx: MutationCtx,
  env: WriteEnvelope,
  report: Doc<'reports'>,
) {
  const by = writeAttribution(env.actor)
  const entry = {
    businessId: report.businessId,
    entityType: 'reports',
    entityId: report._id,
  }
  if (by.onBehalfOfMembershipId !== undefined && env.actor.session) {
    await recordOnce(ctx, by, {
      ...entry,
      action: 'report.edit',
      since: env.actor.session.startedAt,
    })
  } else if (report.authorMembershipId !== env.actor.real._id) {
    await recordOnce(ctx, by, {
      ...entry,
      action: 'report.edit.byOwner',
      since: Date.now() - OWNER_EDIT_WINDOW_MS,
    })
  }
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
    const { actor, scope } = await requireActor(ctx, businessId)

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
          reportReadable(scope, actor.real._id, r),
      ),
    )
  },
})

/** As many as belong in a sheet section, and no more. */
export const INLINE_LIMIT = 20

export const listForBusiness = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const { actor, listScope } = await requireActor(ctx, businessId)

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .collect()

    const visible = reports.filter(
      (r) => r.deletedAt === undefined && reportReadable(listScope, actor.real._id, r),
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
    const { actor, listScope } = await requireActor(ctx, businessId)

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
    const visible = page.page.filter((r) => reportReadable(listScope, actor.real._id, r))

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
    const { actor, listScope } = await requireActor(ctx, businessId)

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

    return decorate(ctx, rows.filter((r) => reportReadable(listScope, actor.real._id, r)))
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
    const { actor, listScope } = await requireActor(ctx, businessId)
    const rows = await ctx.db
      .query('reports')
      .withIndex('by_business_updated', (q) => q.eq('businessId', businessId))
      .order('desc')
      .take(COUNT_LIMIT)

    const counted = { all: 0, draft: 0, finalised: 0, sent: 0, trash: 0 }
    for (const r of rows) {
      if (!reportReadable(listScope, actor.real._id, r)) continue
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

/**
 * Drafts old enough to be a compliance problem rather than a work in progress.
 *
 * WA's Pesticides Regulations give an operator two business days to make the
 * record; a report still sitting unfinished a week later is one nobody is
 * going to remember the detail of. There is no notification channel in this
 * app to nudge through — no push, no email to a member — so the nudge is
 * simply that the library says so, where somebody is already looking.
 */
export const staleDrafts = query({
  args: {
    businessId: v.id('businesses'),
    /**
     * How old counts as stale. Part of the contract rather than a constant,
     * so "drafts older than a day" is askable — and so the rule can be
     * exercised without waiting four days for it to be true.
     */
    olderThanMs: v.optional(v.number()),
  },
  handler: async (ctx, { businessId, olderThanMs }) => {
    const { actor, listScope } = await requireActor(ctx, businessId)
    const cutoff = Date.now() - (olderThanMs ?? STALE_AFTER_MS)

    const rows = await ctx.db
      .query('reports')
      .withIndex('by_business_updated', (q) =>
        q.eq('businessId', businessId).lt('updatedAt', cutoff),
      )
      .filter((q) =>
        q.and(
          q.eq(q.field('status'), 'draft'),
          q.eq(q.field('deletedAt'), undefined),
        ),
      )
      .take(COUNT_LIMIT)

    const mine = rows.filter((r) => reportReadable(listScope, actor.real._id, r))
    return {
      count: mine.length,
      /** The one to open, which is the oldest — it is the most forgotten. */
      oldest: mine.sort(
        (a, b) => (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt),
      )[0]?._id,
    }
  },
})

/** Two business days, rounded to the week's worth of slack a trade needs. */
const STALE_AFTER_MS = 4 * 24 * 60 * 60 * 1000

/**
 * Which settings row a report reads: the built-in's id, or the custom
 * template's. One function so the gate and the builder cannot look in
 * different places.
 */
export function templateRefOf(report: Doc<'reports'>): string {
  return report.template === 'custom'
    ? (report.customTemplateId ?? 'custom')
    : report.template
}

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

/**
 * The draft's team picker, told only what this caller may know.
 *
 * Each roster entry carries the member's licence and phone, so that choosing a
 * technician resolves their details on the form at once. Those are the same
 * details `memberships.listForBusiness` keeps to the people who manage the
 * team — and every member opens drafts, so without this the owner's licence
 * and mobile reached every phone in the business through the report screen
 * instead of the roster.
 *
 * Kept whole for a manager, for the caller's own entry, and for anyone the
 * report already names: their details print on the document, so they are no
 * secret from the person writing it. Everyone else is a name. The frozen
 * snapshot `finalise` writes is built separately and is untouched by this.
 */
function rosterFor<T extends RosterEntry & { facts?: Record<string, string | undefined> }>(
  env: ActorEnvelope,
  snapshot: ReportContextSnapshot,
  roster: Array<T>,
): Array<T> {
  if (hasCapability(env, 'team.manage')) return roster
  const named = new Set(Object.keys(snapshot.members ?? {}))
  return roster.map((m) =>
    m._id === env.actor.real._id || named.has(m._id)
      ? m
      : {
          ...m,
          printed: printedMemberName(m.name),
          licence: undefined,
          phone: undefined,
          facts: { name: m.facts?.name, address: m.facts?.address },
        },
  )
}

export const get = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const env = await requireActor(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return null
    if (!reportReadable(env.scope, env.actor.real._id, report)) return null
    // Soft-deleted: gone from every list, and not openable by a stale link.
    if (report.deletedAt !== undefined) return null

    // Correcting is offered on the current issue of a document, to the account
    // it was written in or the owner — the same rule `amend` enforces, so the
    // button is never an invitation to a refusal. A correction already under
    // way is linked instead of offered twice.
    const correctable =
      report.status === 'finalised' && report.supersededByReportId === undefined
    const openAmendment = correctable ? await openAmendmentOf(ctx, report) : null

    return {
      ...(await projectReport(ctx, report, env)),
      // A finalised report is immutable; a draft is editable by exactly whom
      // `requireEditableReport` admits — asked of the actor, so the legacy
      // view-as (which is not in `actor`) never makes a draft editable.
      canEdit: canEditReport(env.actor, reportFactsFrom(report)),
      canAmend:
        correctable &&
        openAmendment === null &&
        (report.authorMembershipId === env.actor.acting._id ||
          hasCapability(env, 'business.manage')),
      openAmendmentId: openAmendment?._id ?? null,
      // The caller's own membership — `reportPdf`/`email` actions need this
      // to attribute an audit-log entry, and cannot resolve an actor
      // themselves (actions have no `ctx.db`).
      callerMembershipId: env.actor.real._id,
    }
  },
})

/**
 * A business-authored template as everyone filling it in sees it: the
 * published columns, and not the owner's unissued draft riding along beside
 * them. A report is filled against what the business issues, and a draft that
 * reached every technician through the report they opened would be the
 * unissued edit handed out after all, by the side door.
 */
function publishedOnly(
  template: Doc<'customReportTemplates'> | null,
): Omit<Doc<'customReportTemplates'>, 'draft'> | null {
  if (!template) return null
  const { draft: _unissued, ...published } = template
  return published
}

/**
 * Everything the document is built from, with no access check of its own.
 *
 * `reports.get` runs the checks and calls this; `getForRender` calls it with
 * none, because a scheduled render has no caller to check — a Convex action
 * runs without an identity. Keeping it one function is the point: two
 * projections of the same report would let the PDF a client is emailed differ
 * from the one on screen, and only in the fields someone forgot to copy.
 */
async function projectReport(
  ctx: QueryCtx,
  report: Doc<'reports'>,
  /** The person reading it, when there is one. The renderer has none, and
   * needs every detail the document can print. */
  viewer?: ActorEnvelope,
) {
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
            ? publishedOnly(await ctx.db.get(report.customTemplateId))
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
    const roster = viewer
      ? rosterFor(viewer, contextSnapshot, live?.roster ?? [])
      : (live?.roster ?? [])

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
      signatureSlots: withoutImages(report.signatureSlots),
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
       * The business's own cover wording and signing rule. `null` once
       * signed: a finalised report's chrome was frozen with its wording, and
       * an owner renaming the form next year must not relabel a document
       * someone already received.
       */
      settings: finalised
        ? null
        : await settingsFor(ctx, businessId, templateRefOf(report)),
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

export function upgradeFor(
  report: Pick<Doc<'reports'>, 'template' | 'templateVersion' | 'supersedesReportId'>,
): 'switch' | 'restart' | null {
  if (report.template === 'custom') return null
  // A correction stays on the form its original was signed on: it says the
  // same things in the same words, minus the mistake. Offering to move it to a
  // newer form — and "Start again" in particular, which makes a brand-new
  // report — would issue the correction as an unrelated document with its own
  // number, and leave the original current.
  if (report.supersedesReportId !== undefined) return null
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
    await requireWriteActor(ctx, businessId)
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
    const { env, report } = await requireEditableReport(ctx, businessId, reportId)
    // The HUMAN, not the account being worked in: a saved signature is the
    // hand of whoever holds the pen, and so is the record of who captured one.
    const membership = await ctx.db.get(env.actor.real._id)
    if (!membership) throw new ConvexError('NO_ACCESS')

    // A saved signature is applied by the person it belongs to, and by nobody
    // else — that is the whole of what `method: 'saved'` claims on the record.
    // Nor may a colleague's saved signature arrive dressed as a fresh drawing.
    if (method === 'saved' && storageId !== membership.savedSignatureStorageId) {
      throw new ConvexError('NOT_YOUR_SIGNATURE')
    }
    if (storageId !== membership.savedSignatureStorageId) {
      const team = await ctx.db
        .query('memberships')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .take(MAX_MEMBERS)
      if (team.some((m) => m.savedSignatureStorageId === storageId)) {
        throw new ConvexError('NOT_YOUR_SIGNATURE')
      }
    }

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
    const env = await requireActor(ctx, businessId)
    const membership = await ctx.db.get(env.actor.real._id)
    if (!membership?.savedSignatureStorageId) return null
    const url = await ctx.storage.getUrl(membership.savedSignatureStorageId)
    return url ? { storageId: membership.savedSignatureStorageId, url } : null
  },
})

/**
 * What was signed, and how — without the stored image's id.
 *
 * The id is a capability: `attachSignature` takes one, so handing out the id
 * under a colleague's signature handed out the means to put it on a document
 * of your own. The image is still drawn from `context.signatureUrls`; nothing
 * that reads a report needs the id itself.
 */
function withoutImages(slots: Doc<'reports'>['signatureSlots']) {
  if (!slots) return undefined
  return Object.fromEntries(
    Object.entries(slots).map(([slot, held]) => {
      if (typeof held === 'string') return [slot, {}]
      const { storageId: _image, ...record } = held
      return [slot, record]
    }),
  ) as Record<string, Partial<Omit<Exclude<typeof slots[string], string>, 'storageId'>>>
}

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
    const { actor, scope } = await requireActor(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return {}
    if (report.deletedAt !== undefined) return {}
    if (!reportReadable(scope, actor.real._id, report)) return {}

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
    const { actor, scope } = await requireActor(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return []
    if (report.deletedAt !== undefined) return []
    if (!reportReadable(scope, actor.real._id, report)) return []

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
    const { actor, scope } = await requireActor(ctx, businessId)

    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return {}
    if (report.deletedAt !== undefined) return {}
    if (!reportReadable(scope, actor.real._id, report)) return {}

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

/**
 * Creates a draft the one way a draft is created: seeded from what the job and
 * the property already know, stamped with the revision it is written against,
 * listed and findable from its first moment.
 *
 * `create` and `restartDraft` both come through here. They used to insert
 * separately, and the restart path fell behind every time the other one
 * learned something — a restarted form came up blank, sorted below everything
 * and could not be found by search.
 */
async function insertNewDraft(
  ctx: MutationCtx,
  args: {
    businessId: Id<'businesses'>
    propertyId: Id<'properties'>
    jobId?: Id<'jobs'>
    authorMembershipId: Id<'memberships'>
    template: TemplateId | 'custom'
    customTemplateId?: Id<'customReportTemplates'>
    legalBasis: string
    given: Record<string, unknown>
    showsSuggestions: boolean
  },
): Promise<Id<'reports'>> {
  const seeded = forCaller(
    await seedNewReport(ctx, {
      businessId: args.businessId,
      propertyId: args.propertyId,
      jobId: args.jobId,
      template: args.template,
      customTemplateId: args.customTemplateId,
      authorMembershipId: args.authorMembershipId,
      given: args.given,
    }),
    args.given,
    args.showsSuggestions,
  )

  const now = Date.now()
  const reportId = await ctx.db.insert('reports', {
    businessId: args.businessId,
    propertyId: args.propertyId,
    jobId: args.jobId,
    authorMembershipId: args.authorMembershipId,
    template: args.template,
    customTemplateId: args.customTemplateId,
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
    createdAt: now,
    updatedAt: now,
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
}

/**
 * What a new report may hold, given who is asking.
 *
 * A suggestion — a start time read off the schedule, a forecast, last visit's
 * answers — has to be shown as one and confirmed before the report can be
 * finalised, because a guess must never print under a signature. That only
 * works for a client that knows what a suggestion is. An installed app still
 * running an older build does not: it would show the guess as a plain answer,
 * never confirm it, and then be refused at finalise with no way to see why —
 * on every report started from a job. So such a caller gets the facts (the
 * date, the client, the technician) and none of the guesses, which is also
 * what that build expected of the server it was written against.
 */
function forCaller(
  seeded: Awaited<ReturnType<typeof seedNewReport>>,
  given: Record<string, unknown>,
  showsSuggestions: boolean,
): Awaited<ReturnType<typeof seedNewReport>> {
  if (showsSuggestions) return seeded
  const data = { ...seeded.data }
  for (const key of Object.keys(seeded.prefill)) {
    // An answer the caller supplied is theirs, not a guess.
    if (!(key in given)) delete data[key]
  }
  return { data, prefill: {}, fetchWeather: null }
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
      settings: await settingsFor(ctx, args.businessId, args.template),
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
    /**
     * The caller can show a suggestion as one and let it be confirmed. See
     * `forCaller` — an older build that cannot is given the facts only.
     */
    suggestions: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const env = await requireWriteActor(ctx, args.businessId)
    /**
     * The account it is written in, not the human writing it. A report the
     * owner starts inside Kevin's account is Kevin's: it is in Kevin's list,
     * Kevin can finish it, and `requireEditableReport` lets the owner go on
     * editing it while he is still in there. It used to be the owner's — gone
     * from the account he made it in, and editable by nobody standing there.
     */
    const by = writeAttribution(env.actor)

    const property = await ctx.db.get(args.propertyId)
    if (!property || property.businessId !== args.businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    // The job a report is filed against is read back as "this job has its
    // report" — by the business's complete-only-when-reported policy among
    // others — so it has to be one of this business's jobs, not an id from
    // somewhere else.
    if (args.jobId) {
      const job = await ctx.db.get(args.jobId)
      if (!job || job.businessId !== args.businessId) {
        throw new ConvexError('NOT_FOUND')
      }
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
    const reportId = await insertNewDraft(ctx, {
      businessId: args.businessId,
      propertyId: args.propertyId,
      jobId: args.jobId,
      authorMembershipId: by.authorMembershipId,
      template: args.template,
      customTemplateId: args.template === 'custom' ? args.customTemplateId : undefined,
      legalBasis: args.legalBasis,
      given: (args.data ?? {}) as Record<string, unknown>,
      showsSuggestions: args.suggestions === true,
    })
    // Kevin's report, started by the owner — and the report's own history is
    // the only place that can say the second half.
    await recordOnBehalf(ctx, by, {
      businessId: args.businessId,
      action: 'report.create',
      entityType: 'reports',
      entityId: reportId,
    })
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

/**
 * How many reports back to look for the last visit to this site.
 *
 * A property with years of history is read newest-first, and the one being
 * looked for is almost always within the last handful. Bounded because this
 * runs while a technician waits on the overview, and an unbounded scan of a
 * long-standing client's history is exactly the wrong place to spend it.
 */
const LAST_VISIT_SCAN = 40

/** Adapts two report rows onto the pure rule in `lastVisit.ts`. */
function carryFrom(draft: Doc<'reports'>, candidate: Doc<'reports'>): boolean {
  return canCarryFrom(
    {
      id: draft._id,
      templateRef: templateRefOf(draft),
      templateVersion: draft.templateVersion,
    },
    {
      id: candidate._id,
      templateRef: templateRefOf(candidate),
      templateVersion: candidate.templateVersion,
      status: candidate.status,
      deleted: candidate.deletedAt !== undefined,
    },
  )
}

async function lastVisitSource(
  ctx: QueryCtx,
  scope: RowScope,
  readerId: Id<'memberships'>,
  draft: Doc<'reports'>,
) {
  const rows = await ctx.db
    .query('reports')
    .withIndex('by_property', (q) => q.eq('propertyId', draft.propertyId))
    .order('desc')
    .take(LAST_VISIT_SCAN)

  const candidates = rows.filter(
    (row) =>
      row.businessId === draft.businessId &&
      carryFrom(draft, row) &&
      reportReadable(scope, readerId, row),
  )

  // Ranked by when each was SIGNED, not when it was started. A draft left in
  // a van for a fortnight and finalised last week is the more recent visit,
  // however old its first keystroke.
  return candidates.reduce<Doc<'reports'> | null>(
    (best, row) =>
      best === null || visitAt(row) > visitAt(best) ? row : best,
    null,
  )
}

function visitAt(report: Doc<'reports'>): number {
  return report.finalisedAt ?? report._creationTime
}

async function carryOverFor(
  ctx: QueryCtx,
  draft: Doc<'reports'>,
  previous: Doc<'reports'>,
) {
  const optionSets = await loadOverrides(ctx, draft.businessId)
  const template = resolveReportTemplate({
    template: draft.template,
    templateVersion: draft.templateVersion,
    customTemplate: draft.customTemplateId
      ? ((await ctx.db.get(draft.customTemplateId)) ?? undefined)
      : undefined,
    optionSets,
  })

  return carryOverFrom(
    template,
    (previous.data ?? {}) as Record<string, unknown>,
    (draft.data ?? {}) as Record<string, unknown>,
  )
}

/**
 * The last time this business finished this form at this address, and what of
 * it is still worth offering.
 *
 * Returns nothing rather than an empty offer: an overview that says "copy 0
 * answers from 12 March" is a row to read and dismiss on every report at every
 * site that has one.
 */
export const lastAtProperty = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const { actor, scope } = await requireActor(ctx, businessId)

    const draft = await ctx.db.get(reportId)
    if (!draft || draft.businessId !== businessId) return null
    if (draft.status !== 'draft' || draft.deletedAt !== undefined) return null
    if (!reportReadable(scope, actor.real._id, draft)) return null

    const previous = await lastVisitSource(ctx, scope, actor.real._id, draft)
    if (!previous) return null

    const carried = await carryOverFor(ctx, draft, previous)
    if (carried.labels.length === 0) return null

    return {
      reportId: previous._id,
      finalisedAt: visitAt(previous),
      labels: carried.labels,
    }
  },
})

/**
 * Fills this report in from the last one at the same address.
 *
 * Everything copied lands as a suggestion, so the technician passes each
 * section and confirms it — which is what makes this safe to offer at all. A
 * quarterly service really is the same treatment as last quarter, right up
 * until the visit where it is not.
 */
export const copyFromLastVisit = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    fromReportId: v.id('reports'),
  },
  handler: async (ctx, { businessId, reportId, fromReportId }) => {
    const { env, report } = await requireEditableReport(ctx, businessId, reportId)
    // Whether the caller may reach the report being copied FROM is a question
    // for the scope — the write actor's, because this is a write, and the read
    // scope carries the legacy view-as lens that must never reach one.
    // Who may write the draft copied TO is `requireEditableReport`'s.
    const { actor, scope } = env

    const previous = await ctx.db.get(fromReportId)
    // Re-checked rather than trusted: the id came from the client, and this
    // copies one report's answers into another.
    if (
      !previous ||
      previous.businessId !== businessId ||
      previous._id === report._id ||
      previous.propertyId !== report.propertyId ||
      !carryFrom(report, previous) ||
      !reportReadable(scope, actor.real._id, previous)
    ) {
      throw new ConvexError('NOT_FOUND')
    }

    const carried = await carryOverFor(ctx, report, previous)
    if (carried.labels.length === 0) return { copied: 0, data: {} }

    const data = (report.data ?? {}) as Record<string, unknown>
    await ctx.db.patch(reportId, {
      data: { ...data, ...carried.data },
      prefill: { ...(report.prefill ?? {}), ...carried.prefill },
      updatedAt: Date.now(),
    })
    // Handed back as well as written, because the builder holds the answers in
    // its own state and autosaves them wholesale — a patch it does not know
    // about is a patch its next save erases.
    return { copied: carried.labels.length, data: carried.data }
  },
})

export const saveDraft = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    data: v.any(),
    templateVersion: v.optional(v.number()),
    /**
     * The answers as they stood when this editor loaded them.
     *
     * Optional, and that is what keeps the currently-deployed client working:
     * without it this mutation behaves exactly as it always has, replacing the
     * stored answers with whatever arrived. A client that sends it gets a
     * three-way merge instead, which is the only way two people editing one
     * report can both keep their work.
     *
     * The alternative — a version number and a refusal — is worse here. An
     * autosave fires every couple of seconds while someone types, so a stale
     * version is the normal state of affairs rather than an exceptional one,
     * and refusing would throw away a field someone had just filled in.
     */
    base: v.optional(v.any()),
  },
  handler: async (
    ctx,
    { businessId, reportId, data, templateVersion, base },
  ) => {
    // The whole point of finalising is that the document stops changing. A
    // signed compliance record that can be edited afterwards is worthless.
    const { report } = await requireEditableReport(ctx, businessId, reportId)
    requireSameVersion(report, templateVersion)

    /**
     * Two people on one draft stops being a freak event the day someone can
     * work inside another person's account: a helper fills in section 3 on the
     * office laptop while the licence holder answers section 5 on their phone,
     * and until now whichever autosave landed second silently erased the
     * other's answers. There is no error to notice, and no way back — the
     * overwritten text was never anywhere but that form.
     *
     * Merged per answer, so both survive. Only the same answer edited two
     * different ways is a conflict, and that one genuinely needs a person.
     *
     * `updatedAt` on both paths: the library orders by it, and "the one I was
     * filling in" means the one they last touched, not the one they started
     * first.
     */
    if (base === undefined) {
      await ctx.db.patch(reportId, { data, updatedAt: Date.now() })
      return
    }

    const merge = mergeDraft(
      base as Record<string, unknown>,
      (report.data ?? {}) as Record<string, unknown>,
      data as Record<string, unknown>,
    )
    if (!merge.ok) throw new ConvexError('DRAFT_CONFLICT')

    await ctx.db.patch(reportId, { data: merge.data, updatedAt: Date.now() })
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
    // Who must sign is the business's rule, so the gate that refuses an
    // unsigned report has to read the same settings the builder does.
    settings: await settingsFor(ctx, report.businessId, templateRefOf(report)),
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
    const { env, report } = await requireEditableReport(
      ctx,
      businessId,
      reportId,
    )
    requireSameVersion(report, templateVersion)

    /**
     * Whether this document may be signed, as opposed to merely edited.
     *
     * `canFinaliseReport` has existed since the access model was written down
     * and has never been called, which meant the protection it describes did
     * not exist: a regulated certificate could be signed with no licence on
     * file at all, and — once switching is reachable — from inside the licence
     * holder's account by someone who is not them.
     *
     * It runs after `requireEditableReport`, which admits the same people
     * `canEditReport` does — the owner among them, for anyone's draft — so it
     * is this check that holds a regulated document for its holder. The
     * holder is the report's author: their name and licence are what the
     * certificate prints, whoever filled the form in.
     */
    const holder = await ctx.db.get(report.authorMembershipId)
    if (!holder) throw new ConvexError('NOT_FOUND')

    // From the answers being signed, not the stored draft: they are what the
    // certificate will print.
    const named = await namedMembers(
      ctx,
      report,
      (data ?? {}) as Record<string, unknown>,
      await memberFieldKeys(ctx, report),
    )

    // The WRITE actor from the gate. The read actor falls back to the real
    // person when a switch has lapsed — which reads as "not switched", and
    // would wave a certificate straight past SWITCHED_REGULATED.
    // Who drew each technician signature on it, where that was recorded.
    const signedBy = (await technicianSignatureSlots(ctx, report)).flatMap(
      (slot) => {
        const held = report.signatureSlots?.[slot]
        return held && typeof held !== 'string' && held.capturedByMembershipId
          ? [held.capturedByMembershipId]
          : []
      },
    )

    const decision = canFinaliseReport(
      env.actor,
      reportFactsFrom(report),
      {
        holder: factsFromMembership(holder),
        named: named.map(factsFromMembership),
        signedBy,
      },
      Date.now(),
    )
    if (!decision.ok) throw new ConvexError(decision.reason)

    // Then whether it is finished. Second, because a technician can do
    // something about this one — and there is no point walking them through
    // twelve missing answers on a certificate their account cannot sign.
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
      // Which issue of that number this document is. 1 unless `amend` made
      // this report to correct an earlier one.
      version: report.version ?? 1,
      // Who pressed the button, which is not always whose licence prints.
      // Written on every finalise, so absent can only mean "before this
      // existed" and never "nobody knows".
      finalisedByMembershipId: env.actor.real._id,
      ...(templateSnapshotId ? { templateSnapshotId } : {}),
      ...(contextSnapshot ? { contextSnapshot } : {}),
      ...(customTemplateSnapshot ? { customTemplateSnapshot } : {}),
    })

    // A correction supersedes the document it corrects when it is ISSUED —
    // not when somebody starts a draft of it, which may be abandoned. Checked
    // again here rather than trusted from `amend`: in between, the original
    // could have been corrected by someone else.
    if (report.supersedesReportId) {
      const original = await ctx.db.get(report.supersedesReportId)
      if (!original || original.businessId !== businessId) {
        throw new ConvexError('NOT_FOUND')
      }
      if (
        original.supersededByReportId !== undefined &&
        original.supersededByReportId !== reportId
      ) {
        throw new ConvexError('ALREADY_SUPERSEDED')
      }
      await ctx.db.patch(original._id, {
        supersededByReportId: reportId,
        updatedAt: now,
      })
    }

    await recordAudit(ctx, writeAttribution(env.actor), {
      businessId,
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
    await queueFormDeliveries(ctx, report, data, env)

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
  env: WriteEnvelope,
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
  // The same rule as `deliveries.request`, which this mirrors for the sends
  // the form itself asked for: sending anywhere is the owner's authority, and
  // not from inside somebody else's account.
  const unrestricted =
    hasCapability(env, 'business.manage') ||
    business?.allowTechnicianRecipients === true
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
    // The human who locked it, like `finalisedByMembershipId`: it is their
    // send the approval queue and the rate limit are about.
    sentByMembershipId: env.actor.real._id,
    createdAt: Date.now(),
  })
}

/**
 * The correction of `original` that has been started and not yet issued.
 *
 * Read from the property's newest reports rather than an index of its own: a
 * correction is started after the document it corrects, so it sits at the top
 * of that property's history unless dozens of reports have been written there
 * since — and a bounded read that could in principle miss one costs a second
 * open correction, which the finalise-time supersede check still refuses.
 */
async function openAmendmentOf(
  ctx: QueryCtx,
  original: Doc<'reports'>,
): Promise<Doc<'reports'> | null> {
  const recent = await ctx.db
    .query('reports')
    .withIndex('by_property', (q) => q.eq('propertyId', original.propertyId))
    .order('desc')
    .take(LAST_VISIT_SCAN)
  return (
    recent.find(
      (row) =>
        row.supersedesReportId === original._id &&
        row.status === 'draft' &&
        row.deletedAt === undefined,
    ) ?? null
  )
}

/**
 * Corrects a finalised report by issuing a new one that supersedes it.
 *
 * A finalised report is never edited — that is the whole point of finalising,
 * and a compliance record that can be changed afterwards is worth nothing. So
 * a correction is a new document: same report number, next version, carrying
 * the answers forward so the correction is the edit rather than the whole
 * form again.
 *
 * Three things are deliberately NOT carried:
 *
 * - **Signatures.** A signature was applied to a specific document. Moving it
 *   to a different one is forgery with extra steps, however convenient, so the
 *   amendment is signed again. This is the same rule that stops a saved
 *   signature being applied by anyone but its owner.
 * - **The lock.** The amendment starts as a draft, so the correction is read,
 *   signed and finalised like any other report.
 * - **The deliveries.** What the client was sent stays sent; re-sending is a
 *   decision somebody makes about the new document.
 *
 * Photographs ARE carried — the gallery and the single-photo fields alike:
 * they are evidence of what was on site that day, and the day has not changed.
 * They point at the same stored files — one reason `purgeReport` never
 * deletes a draft's stored files.
 *
 * The original is marked superseded when the correction is FINALISED, not
 * here. Until then it is still the document the client holds, and a draft
 * abandoned half-way must not leave it pointing at a replacement that was
 * never issued.
 */
export const amend = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    reason: v.string(),
  },
  handler: async (ctx, { businessId, reportId, reason }) => {
    const env = await requireWriteActor(ctx, businessId)
    const by = writeAttribution(env.actor)

    const original = await ctx.db.get(reportId)
    if (!original || original.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (original.deletedAt !== undefined) throw new ConvexError('NOT_FOUND')
    if (original.status !== 'finalised') {
      throw new ConvexError('REPORT_NOT_FINALISED')
    }
    // Who may correct a signed document is not who may READ it. Being able
    // to see a certificate — the whole team's, say, because the owner granted
    // "see everyone's schedule" — must not let you supersede it and reissue it
    // under your own name. So: the account it was written in, or the owner.
    // And through the write actor, which never carries the read-only view-as
    // lens and refuses a switch that has gone stale; a read scope inside a
    // mutation is the door main's model was built to keep shut.
    if (
      original.authorMembershipId !== env.actor.acting._id &&
      !hasCapability(env, 'business.manage')
    ) {
      throw new ConvexError('NO_ACCESS')
    }
    // Amending an amendment is fine; amending something already superseded
    // would fork the number into two live documents.
    if (original.supersededByReportId !== undefined) {
      throw new ConvexError('ALREADY_SUPERSEDED')
    }
    // Nor may two corrections of one document be open at once: the first to
    // be finalised would supersede the original, and the second would then be
    // a correction of a document that is no longer current.
    if (await openAmendmentOf(ctx, original)) {
      throw new ConvexError('AMENDMENT_IN_PROGRESS')
    }

    const explanation = reason.trim()
    if (explanation.length === 0 || explanation.length > 500) {
      throw new ConvexError('AMENDMENT_REASON_REQUIRED')
    }

    const now = Date.now()
    const amendmentId = await ctx.db.insert('reports', {
      businessId,
      propertyId: original.propertyId,
      ...(original.jobId ? { jobId: original.jobId } : {}),
      // Whose account the correction is written in, as `create` decides it.
      authorMembershipId: by.authorMembershipId,
      template: original.template,
      ...(original.customTemplateId
        ? { customTemplateId: original.customTemplateId }
        : {}),
      // The revision it was WRITTEN against, not today's: a correction to a
      // document says the same things in the same words, minus the mistake.
      ...(original.templateVersion !== undefined
        ? { templateVersion: original.templateVersion }
        : {}),
      legalBasis: original.legalBasis,
      status: 'draft',
      data: original.data,
      photoIds: [],
      // The single-photo fields (the cover, a notice photo) are evidence of
      // the day like the gallery below, and come with it for the same reason.
      ...(original.photoSlots ? { photoSlots: original.photoSlots } : {}),
      // Same number, next issue.
      ...(original.reportNumber !== undefined
        ? { reportNumber: original.reportNumber }
        : {}),
      version: (original.version ?? 1) + 1,
      supersedesReportId: original._id,
      amendmentReason: explanation,
      // Everything the app guessed was already confirmed on the document being
      // corrected, so the technician is not asked to agree to it twice.
      ...(original.prefill
        ? {
            prefill: Object.fromEntries(
              Object.entries(original.prefill).map(([key, entry]) => [
                key,
                { ...entry, confirmedAt: entry.confirmedAt ?? now },
              ]),
            ),
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    })

    for (const photo of await ctx.db
      .query('reportPhotos')
      .withIndex('by_report_field', (q) => q.eq('reportId', original._id))
      // Bounded like every other photo read in this file.
      .take(200)) {
      const { _id, _creationTime, reportId: _was, ...rest } = photo
      await ctx.db.insert('reportPhotos', { ...rest, reportId: amendmentId })
    }


    await recordAudit(ctx, by, {
      businessId,
      action: 'report.amend',
      entityType: 'reports',
      entityId: amendmentId,
      meta: { supersedes: original._id, reportNumber: original.reportNumber, reason: explanation },
      at: now,
    })

    await refreshSearchText(ctx, amendmentId)
    return amendmentId
  },
})

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
    const { env, report } = await requireDeletable(ctx, businessId, reportId)
    if (report.deletedAt !== undefined) return
    await ctx.db.patch(reportId, { deletedAt: Date.now(), updatedAt: Date.now() })
    await recordRetirement(ctx, env, report, 'report.delete')
  },
})

export const restore = mutation({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const { env, report } = await requireDeletable(ctx, businessId, reportId)
    if (report.deletedAt === undefined) return
    await ctx.db.patch(reportId, { deletedAt: undefined, updatedAt: Date.now() })
    await recordRetirement(ctx, env, report, 'report.restore')
  },
})

/**
 * Gone for good, with its photos and its signatures. Only from Recently
 * Deleted — the thirty-day safety net is not optional.
 */
export const remove = mutation({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const { env, report } = await requireDeletable(ctx, businessId, reportId)
    if (report.deletedAt === undefined) throw new ConvexError('NOT_IN_TRASH')
    await purgeReport(ctx, report)
    // Kept after the report is gone: it is the only trace, for the account it
    // was in, that someone else emptied it from their bin.
    await recordRetirement(ctx, env, report, 'report.purge')
  },
})

/**
 * Who may retire a draft: whoever may edit it (`canEditReport`) — the account
 * it was written in, or the owner working as himself, who has to be able to
 * clear a subcontractor's abandoned draft off the list.
 *
 * Not `requireEditableReport` itself, which refuses a draft already in the
 * bin — and restoring one from there is exactly this gate's job. Through the
 * write actor, so the view-as lens never reaches it (looking through someone's
 * eyes is a way to read, never a way to delete), and an owner working inside a
 * technician's account bins only what that account could: its own drafts.
 */
async function requireDeletable(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  reportId: Id<'reports'>,
): Promise<{ env: WriteEnvelope; report: Doc<'reports'> }> {
  const env = await requireWriteActor(ctx, businessId)
  const report = await ctx.db.get(reportId)
  if (!report || report.businessId !== businessId) throw new ConvexError('NOT_FOUND')
  if (report.status === 'finalised') throw new ConvexError('REPORT_FINALISED')
  if (!canEditReport(env.actor, reportFactsFrom(report))) {
    throw new ConvexError('NO_ACCESS')
  }
  return { env, report }
}

/** A draft binned, restored or purged inside someone else's account, on that
 * account's record — see `recordOnBehalf`. */
async function recordRetirement(
  ctx: MutationCtx,
  env: WriteEnvelope,
  report: Doc<'reports'>,
  action: 'report.delete' | 'report.restore' | 'report.purge',
) {
  await recordOnBehalf(ctx, writeAttribution(env.actor), {
    businessId: report.businessId,
    action,
    entityType: 'reports',
    entityId: report._id,
  })
}

/**
 * Removes a draft for good — its rows, and the one blob it provably owns.
 *
 * It deliberately does NOT delete the draft's photo or signature blobs, and
 * that is a correction, not an omission. Those storage ids arrive from the
 * client, and a blob can be referenced from places this function cannot see
 * cheaply: another report's photo slots, signature slots or rendered PDF are
 * not indexed by storage id. So "no other gallery row points at it" never
 * proved "nothing points at it", and the purge was destroying files that
 * other documents — finalised ones among them — still printed.
 *
 * The case that made this plain needed no attacker at all. The signing sheet
 * saves a drawn signature by default and reuses it, so one blob sits under a
 * technician's signature on many reports. Once they draw a new one, the old
 * blob is nobody's saved signature any more — and purging any abandoned draft
 * that still held it deleted the signature from every signed certificate that
 * used it. The same shape, done on purpose, let anyone who could read a
 * report attach its photo or signature id to a draft of their own, bin the
 * draft, and wipe the original's evidence.
 *
 * An orphaned image costs a few kilobytes. A signed compliance record missing
 * its signature is a destroyed legal document. Reclaiming draft storage
 * properly needs a sweep that checks every reference, and that is its own
 * piece of work; until then, nothing is deleted on a guess.
 *
 * The preview is the exception because the server made it, for this report
 * alone, and nothing else is ever pointed at it.
 */
async function purgeReport(ctx: MutationCtx, report: Doc<'reports'>) {
  const photos = await ctx.db
    .query('reportPhotos')
    .withIndex('by_report_field', (q) => q.eq('reportId', report._id))
    .collect()
  for (const photo of photos) await ctx.db.delete(photo._id)

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
      version: report.version ?? 1,
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
    const { env, report } = await requireEditableReport(
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
    await recordAudit(ctx, writeAttribution(env.actor), {
      businessId,
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
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    /** As on `create`: the caller can show and confirm a suggestion. */
    suggestions: v.optional(v.boolean()),
  },
  handler: async (ctx, { businessId, reportId, suggestions }) => {
    const { env, report } = await requireEditableReport(
      ctx,
      businessId,
      reportId,
    )
    if (upgradeFor(report) !== 'restart' || report.template === 'custom') {
      throw new ConvexError('TEMPLATE_NOT_RESTARTABLE')
    }
    const template = getTemplate(report.template)
    const now = Date.now()

    // Started again means started the way `create` starts one — through the
    // same function, so the two cannot drift apart again.
    const newReportId = await insertNewDraft(ctx, {
      businessId,
      propertyId: report.propertyId,
      jobId: report.jobId,
      authorMembershipId: report.authorMembershipId,
      template: report.template,
      legalBasis: template.legalBasis,
      given: {},
      showsSuggestions: suggestions === true,
    })
    // Into Recently Deleted exactly as `softDelete` puts it there.
    await ctx.db.patch(reportId, { deletedAt: now, updatedAt: now })
    await recordAudit(ctx, writeAttribution(env.actor), {
      businessId,
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
