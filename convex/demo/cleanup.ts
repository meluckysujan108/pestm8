import { ConvexError, v } from 'convex/values'
import { components, internal } from '../_generated/api'
import { internalMutation, internalQuery } from '../_generated/server'
import { authComponent } from '../auth'
import { purgeNote } from '../notes'
import { DEMO_PLAN, PLACEHOLDER_EMAIL_DOMAIN } from './shared'
import type { Doc, Id, TableNames } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * Removes a demo business (convex/demo/seed.ts) and everything in it: the
 * rows, the files, the note bodies in the prosemirror-sync component, and the
 * placeholder logins nothing else needs. Run as seed.ts's header shows.
 *
 * It refuses anything that is not a demo, by two separate facts: the marker
 * the seed's first write put on the business (`plan`), and the slug typed by
 * whoever runs it. An id pasted from the wrong line of `seed:list` is caught
 * by the second; a real business's slug by the first.
 *
 * Each call deletes a bounded batch, first things first, and schedules itself
 * until nothing is left. Every step reads what is still there rather than
 * remembering where it got to, so a call can stop anywhere and the next picks
 * up, and running it twice at once only costs a retry.
 *
 * What it leaves alone, on purpose:
 *  - reportTemplateSnapshots. Content-addressed and shared across businesses:
 *    a demo report finalised on an unchanged built-in points at the same row
 *    as a real business's signed document.
 *  - weatherCache, suburbGeocache, geocodeMisses: keyed by suburb, global.
 *  - The three real people's logins. Only a placeholder login (the
 *    `demo.pestm8.invalid` domain) is removed, and only when no other
 *    business has a membership for it: a second demo reuses the same two.
 *  - Every file it did not make. It deletes only the files the seed stored
 *    (listed in the 'demo.seed' audit row) and the PDFs the server rendered
 *    for demo reports. A photo or signature someone uploaded while trying the
 *    demo is left in storage — a few kilobytes, and never a guess: a demo row
 *    can be pointed at any storage id by hand, including a real business's,
 *    and a file deleted on a guess cannot be brought back. Even a seed file
 *    is kept if a real business is found using it (see `spared`). A
 *    product's photo and PDF are always someone's upload, so its rows go and
 *    its files stay, exactly as `products.remove` leaves them.
 *
 * A PDF render still in flight when its report goes (the seed queues one per
 * finalised report) deletes its own file: reports.setPdf finds no report.
 */

/** Deletes per call, files and component documents included. Well inside a
 * mutation's write limit, and small enough that the heaviest rows (a report's
 * answers, a template's sections) stay far below the read limit too. */
const BATCH = 300

/** Each note is a component call that deletes its body and schedules the
 * removal of its edit history: purgeExpired's batch. */
const NOTES_PER_CALL = 25

/** A report row carries its whole answer blob and the records it froze. */
const REPORTS_PER_CALL = 25

/** A timber-pest clone is ~50 KB, and so is every issue of it. */
const TEMPLATES_PER_CALL = 10

/** How far the sweep for stray template versions may read; see
 * `strayVersions`. */
const VERSION_SCAN = 100
/** Bytes left unread when the stray-version scan stops, for the rest of the
 * call. */
const STRAY_READ_RESERVE = 6 * 1024 * 1024

type Run = {
  ctx: MutationCtx
  business: Doc<'businesses'>
  /** Deletes left in this call. */
  left: number
  deleted: Record<string, number>
  /** This call's memberships of the demo, read once. */
  members: Array<Doc<'memberships'>> | null
  /** Files already dealt with in this call, deleted or spared. */
  filesSeen: Set<Id<'_storage'>>
  /** The files the seed stored, from its audit row, read once per call. */
  seedMade: Set<Id<'_storage'>> | null
  /** Files the demo's people hold in their other businesses; see `spared`. */
  theirs: Set<Id<'_storage'>> | null
  /** Which business each report looked at by `spared` belongs to. */
  reportBusiness: Map<Id<'reports'>, Id<'businesses'> | null>
}

/** One step of the order. True when it has nothing left to delete. */
type Step = (run: Run) => Promise<boolean>

export const remove = internalMutation({
  args: { businessId: v.id('businesses'), confirmSlug: v.string() },
  returns: v.object({
    done: v.boolean(),
    deleted: v.record(v.string(), v.number()),
  }),
  handler: async (
    ctx,
    { businessId, confirmSlug },
  ): Promise<{ done: boolean; deleted: Record<string, number> }> => {
    const business = await ctx.db.get(businessId)
    if (
      !business ||
      business.plan !== DEMO_PLAN ||
      business.slug !== confirmSlug
    ) {
      throw new ConvexError('NOT_A_DEMO')
    }

    const run: Run = {
      ctx,
      business,
      left: BATCH,
      deleted: {},
      members: null,
      filesSeen: new Set(),
      seedMade: null,
      theirs: null,
      reportBusiness: new Map(),
    }
    let done = true
    for (const step of STEPS) {
      if (!(await step(run))) {
        done = false
        break
      }
    }
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.demo.cleanup.remove, {
        businessId,
        confirmSlug,
      })
    }
    return { done, deleted: run.deleted }
  },
})

// ───────────────────────────────────────────────────────────── the order

/**
 * The series go first: the nightly cron books visits for every active one,
 * and would keep adding jobs (and bumping the job counter) between batches.
 */
const clearRecurrences: Step = (run) =>
  sweep(run, 'recurrences', (n) =>
    run.ctx.db
      .query('recurrences')
      .withIndex('by_business', (q) => q.eq('businessId', run.business._id))
      .take(n),
  )

/**
 * Notes, trash included, through the app's own purge: mentions, attachments
 * and their files, the body in the component, the row. Before the jobs and
 * properties they point at, so no half-joined note is ever listed.
 */
const clearNotes: Step = async (run) => {
  const { ctx, business } = run
  const finished = await sweep(
    run,
    'notes',
    (n) =>
      ctx.db
        .query('notes')
        .withIndex('by_business_updated', (q) =>
          q.eq('businessId', business._id),
        )
        .take(n),
    {
      cap: NOTES_PER_CALL,
      drop: async (note) => {
        // Counted before purgeNote deletes them, for the report back.
        const mentions = await ctx.db
          .query('noteMentions')
          .withIndex('by_note', (q) => q.eq('noteId', note._id))
          .collect()
        const attachments = await ctx.db
          .query('noteAttachments')
          .withIndex('by_note', (q) => q.eq('noteId', note._id))
          .collect()
        await purgeNote(ctx, note)
        tally(run, 'noteMentions', mentions.length)
        tally(run, 'noteAttachments', attachments.length)
        tally(run, 'noteBodies')
        tally(run, 'notes')
        return true
      },
    },
  )
  if (!finished) return false
  // Mentions only ever link a note to a member of its own business, so none
  // should be left; this is the check that there are none.
  for (const member of await membersOf(run)) {
    const swept = await sweep(run, 'noteMentions', (n) =>
      ctx.db
        .query('noteMentions')
        .withIndex('by_membership_read', (q) =>
          q.eq('membershipId', member._id),
        )
        .take(n),
    )
    if (!swept) return false
  }
  return true
}

/**
 * Reports, trash included, each after its deliveries, annotations, rendered
 * files and gallery photos. Custom templates must not outlive the reports
 * that use them (the report page cannot resolve its form), so these go first.
 */
const clearReports: Step = async (run) => {
  const { ctx, business } = run
  const finished = await sweep(
    run,
    'reports',
    (n) =>
      ctx.db
        .query('reports')
        .withIndex('by_business', (q) => q.eq('businessId', business._id))
        .take(n),
    { cap: REPORTS_PER_CALL, drop: (report) => dropReport(run, report) },
  )
  if (!finished) return false
  // Deliveries are indexed by business too, so one read confirms that none
  // outlived its report.
  return sweep(run, 'reportDeliveries', (n) =>
    ctx.db
      .query('reportDeliveries')
      .withIndex('by_business_status', (q) => q.eq('businessId', business._id))
      .take(n),
  )
}

async function dropReport(run: Run, report: Doc<'reports'>): Promise<boolean> {
  const { ctx } = run
  const reportId = report._id
  const children: Array<() => Promise<boolean>> = [
    () =>
      sweep(run, 'reportDeliveries', (n) =>
        ctx.db
          .query('reportDeliveries')
          .withIndex('by_report', (q) => q.eq('reportId', reportId))
          .take(n),
      ),
    () =>
      sweep(run, 'reportPdfAnnotations', (n) =>
        ctx.db
          .query('reportPdfAnnotations')
          .withIndex('by_report_page', (q) => q.eq('reportId', reportId))
          .take(n),
      ),
    () =>
      sweep(
        run,
        'reportPdfs',
        (n) =>
          ctx.db
            .query('reportPdfs')
            .withIndex('by_report', (q) => q.eq('reportId', reportId))
            .take(n),
        {
          drop: (pdf) =>
            dropWithFile(run, 'reportPdfs', pdf._id, pdf.storageId, true),
        },
      ),
    () =>
      sweep(
        run,
        'reportPhotos',
        (n) =>
          ctx.db
            .query('reportPhotos')
            .withIndex('by_report_field', (q) => q.eq('reportId', reportId))
            .take(n),
        {
          drop: (photo) =>
            dropWithFile(run, 'reportPhotos', photo._id, photo.storageId),
        },
      ),
  ]
  for (const child of children) {
    if (!(await child())) return false
  }
  if (run.left <= 0) return false
  for (const file of filesOfReport(report)) await dropFile(run, file)
  // Made by the server for this report (reports.setPdf / setPreview), never
  // from an id a person supplied.
  for (const file of [report.pdfStorageId, report.previewStorageId]) {
    if (file) await dropFile(run, file, true)
  }
  return dropRow(run, 'reports', reportId)
}

/**
 * Every file the report row points at that a person could have supplied. An
 * amendment shares its original's photos and a saved signature is one file on
 * many reports, hence `dropFile`'s de-duplication. The frozen logo is the
 * business's own, or one it has since replaced.
 */
function filesOfReport(report: Doc<'reports'>): Array<Id<'_storage'>> {
  return [
    ...report.photoIds,
    ...Object.values(report.photoSlots ?? {}),
    ...Object.values(report.signatureSlots ?? {}).map((slot) => slot.storageId),
    ...(report.contextSnapshot?.business?.logoStorageId
      ? [report.contextSnapshot.business.logoStorageId]
      : []),
  ]
}

/**
 * The business's own forms, each after every issue of it, then the issues
 * of forms deleted from the templates screen (customTemplates.remove leaves
 * those behind, and there is no index to find them by business).
 */
const clearCustomTemplates: Step = async (run) => {
  const { ctx, business } = run
  const finished = await sweep(
    run,
    'customReportTemplates',
    (n) =>
      ctx.db
        .query('customReportTemplates')
        .withIndex('by_business', (q) => q.eq('businessId', business._id))
        .take(n),
    {
      cap: TEMPLATES_PER_CALL,
      drop: async (template) => {
        const versions = await sweep(
          run,
          'customReportTemplateVersions',
          (n) =>
            ctx.db
              .query('customReportTemplateVersions')
              .withIndex('by_template', (q) => q.eq('templateId', template._id))
              .take(n),
          { cap: TEMPLATES_PER_CALL },
        )
        if (!versions || run.left <= 0) return false
        return dropRow(run, 'customReportTemplates', template._id)
      },
    },
  )
  return finished && strayVersions(run)
}

/**
 * Nothing of the demo's is older than the demo, so an issue of a deleted
 * form is among the rows written since the business was: read from there,
 * and only so far. A deployment that published more than VERSION_SCAN issues
 * of forms (every business's) after this demo was made would hide a stray
 * one beyond that — a row nobody reads, left rather than looped over forever.
 */
async function strayVersions(run: Run): Promise<boolean> {
  const { ctx, business } = run
  let scanned = 0
  for await (const row of ctx.db
    .query('customReportTemplateVersions')
    .withIndex('by_creation_time', (q) =>
      q.gte('_creationTime', business._creationTime),
    )) {
    if (row.businessId === business._id) {
      if (run.left <= 0) return false
      await dropRow(run, 'customReportTemplateVersions', row._id)
    }
    if (++scanned >= VERSION_SCAN) break
    // These are other businesses' forms, each up to a megabyte: stop well
    // before the read limit rather than fail every retry at the same row.
    const { bytesRead } = await ctx.meta.getTransactionMetrics()
    if (bytesRead.remaining < STRAY_READ_RESERVE) break
  }
  return true
}

/** The rest of the Reports settings: overrides, option lists, phrases. */
const clearReportSettings: Step = async (run) => {
  const { ctx, business } = run
  const businessId = business._id
  return (
    (await sweep(run, 'templateSettings', (n) =>
      ctx.db
        .query('templateSettings')
        .withIndex('by_business_template', (q) =>
          q.eq('businessId', businessId),
        )
        .take(n),
    )) &&
    (await sweep(run, 'optionSets', (n) =>
      ctx.db
        .query('optionSets')
        .withIndex('by_business_key', (q) => q.eq('businessId', businessId))
        .take(n),
    )) &&
    (await sweep(run, 'reportSnippets', (n) =>
      ctx.db
        .query('reportSnippets')
        .withIndex('by_business_field', (q) => q.eq('businessId', businessId))
        .take(n),
    ))
  )
}

/**
 * The Products page's rows. Only the rows: every photo and PDF on them was
 * uploaded by a person, never stored by the seed, so none is this call's to
 * delete — and products.ts explains why nothing may delete a file a product
 * points at.
 */
const clearProducts: Step = (run) =>
  sweep(run, 'products', (n) =>
    run.ctx.db
      .query('products')
      .withIndex('by_businessId_and_nameKey', (q) =>
        q.eq('businessId', run.business._id),
      )
      .take(n),
  )

/** Jobs, every status, each after its photos and their files
 * (jobs.removePhoto never deleted a file, so nothing else will). */
const clearJobs: Step = (run) =>
  sweep(
    run,
    'jobs',
    (n) =>
      run.ctx.db
        .query('jobs')
        .withIndex('by_business', (q) => q.eq('businessId', run.business._id))
        .take(n),
    {
      drop: async (job) => {
        const photos = await sweep(
          run,
          'jobPhotos',
          (n) =>
            run.ctx.db
              .query('jobPhotos')
              .withIndex('by_job', (q) => q.eq('jobId', job._id))
              .take(n),
          {
            drop: (photo) =>
              dropWithFile(run, 'jobPhotos', photo._id, photo.storageId),
          },
        )
        if (!photos || run.left <= 0) return false
        return dropRow(run, 'jobs', job._id)
      },
    },
  )

/** Properties, then each client after its contacts (which have no index by
 * business, so are found through their client). */
const clearClients: Step = async (run) => {
  const { ctx, business } = run
  const properties = await sweep(run, 'properties', (n) =>
    ctx.db
      .query('properties')
      .withIndex('by_business', (q) => q.eq('businessId', business._id))
      .take(n),
  )
  if (!properties) return false
  return sweep(
    run,
    'clients',
    (n) =>
      ctx.db
        .query('clients')
        .withIndex('by_business', (q) => q.eq('businessId', business._id))
        .take(n),
    {
      drop: async (client) => {
        const contacts = await sweep(run, 'clientContacts', (n) =>
          ctx.db
            .query('clientContacts')
            .withIndex('by_client', (q) => q.eq('clientId', client._id))
            .take(n),
        )
        if (!contacts || run.left <= 0) return false
        return dropRow(run, 'clients', client._id)
      },
    },
  )
}

/**
 * Anyone working in someone else's account, or on "just my jobs", while
 * trying the demo out. Keyed by session, so found through the memberships
 * (both ends of a switch).
 */
const clearSessions: Step = async (run) => {
  const { ctx } = run
  for (const member of await membersOf(run)) {
    const swept =
      (await sweep(run, 'accountSwitches', (n) =>
        ctx.db
          .query('accountSwitches')
          .withIndex('by_real', (q) => q.eq('realMembershipId', member._id))
          .take(n),
      )) &&
      (await sweep(run, 'accountSwitches', (n) =>
        ctx.db
          .query('accountSwitches')
          .withIndex('by_target', (q) => q.eq('targetMembershipId', member._id))
          .take(n),
      )) &&
      (await sweep(run, 'sessionViews', (n) =>
        ctx.db
          .query('sessionViews')
          .withIndex('by_real', (q) => q.eq('realMembershipId', member._id))
          .take(n),
      ))
    if (!swept) return false
  }
  return true
}

const clearInvitations: Step = (run) =>
  sweep(run, 'invitations', (n) =>
    run.ctx.db
      .query('invitations')
      .withIndex('by_business', (q) => q.eq('businessId', run.business._id))
      .take(n),
  )

/**
 * The files the seed stored, as its 'demo.seed' audit row lists them — read
 * here, before the audit trail goes — plus the members' saved signatures and
 * the logo, either of which someone may have replaced while trying the demo.
 * Most are gone already, with the rows that used them.
 */
const clearFiles: Step = async (run) => {
  const { ctx, business } = run
  const candidates = [
    ...(await seedFiles(ctx, business._id)),
    ...(await membersOf(run)).flatMap((m) =>
      m.savedSignatureStorageId ? [m.savedSignatureStorageId] : [],
    ),
    ...(business.logoStorageId ? [business.logoStorageId] : []),
  ]
  for (const file of candidates) {
    if (run.left <= 0) return false
    await dropFile(run, file)
  }
  return true
}

/**
 * The files the business's 'demo.seed' audit row lists, as storage ids:
 * `meta` is whatever its writer put there, so each is checked as one.
 */
async function seedFiles(
  ctx: QueryCtx,
  businessId: Id<'businesses'>,
): Promise<Array<Id<'_storage'>>> {
  const rows = await ctx.db
    .query('auditLog')
    .withIndex('by_entity', (q) =>
      q.eq('entityType', 'businesses').eq('entityId', businessId),
    )
    .take(100)
  const ids = new Set<Id<'_storage'>>()
  for (const row of rows) {
    if (row.action !== 'demo.seed' || row.businessId !== businessId) continue
    const images: unknown = (row.meta as { images?: unknown } | undefined)
      ?.images
    if (!Array.isArray(images)) continue
    for (const value of images as Array<unknown>) {
      const id =
        typeof value === 'string'
          ? ctx.db.system.normalizeId('_storage', value)
          : null
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

const clearAuditLog: Step = (run) =>
  sweep(run, 'auditLog', (n) =>
    run.ctx.db
      .query('auditLog')
      .withIndex('by_business', (q) => q.eq('businessId', run.business._id))
      .take(n),
  )

/**
 * The people the seed made up: a Better Auth user on the placeholder domain,
 * with no membership anywhere but here. A second demo reuses the same two, so
 * one still on another demo's roster stays. Its sessions and accounts go
 * first: there should be none, but sign-up never checks that an address can
 * receive mail, so somebody could have made one.
 *
 * The real people are never candidates: their logins are not on that domain.
 */
const clearPlaceholders: Step = async (run) => {
  const { ctx, business } = run
  const domain = `@${PLACEHOLDER_EMAIL_DOMAIN}`
  for (const member of await membersOf(run)) {
    if (run.left <= 0) return false
    const user = await authComponent.getAnyUserById(ctx, member.userId)
    if (!user || !user.email.toLowerCase().endsWith(domain)) continue
    const elsewhere = (
      await ctx.db
        .query('memberships')
        .withIndex('by_user', (q) => q.eq('userId', member.userId))
        .take(100)
    ).some((m) => m.businessId !== business._id)
    if (elsewhere) continue

    for (const model of ['session', 'account'] as const) {
      const result: { count?: number } | null = await ctx.runMutation(
        components.betterAuth.adapter.deleteMany,
        {
          input: { model, where: [{ field: 'userId', value: user._id }] },
          paginationOpts: { numItems: 200, cursor: null },
        },
      )
      const count = result?.count ?? 0
      if (count > 0)
        tally(run, model === 'session' ? 'authSessions' : 'authAccounts', count)
    }
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'user', where: [{ field: '_id', value: user._id }] },
    })
    tally(run, 'authUsers')
  }
  return true
}

const clearMemberships: Step = (run) =>
  sweep(run, 'memberships', (n) =>
    run.ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', run.business._id))
      .take(n),
  )

/** Last, so a call that stops early leaves the marker `remove` checks. */
const clearBusiness: Step = async (run) => {
  if (run.left <= 0) return false
  return dropRow(run, 'businesses', run.business._id)
}

const STEPS: Array<Step> = [
  clearRecurrences,
  clearNotes,
  clearReports,
  clearCustomTemplates,
  clearReportSettings,
  clearProducts,
  clearJobs,
  clearClients,
  clearSessions,
  clearInvitations,
  clearFiles,
  clearAuditLog,
  clearPlaceholders,
  clearMemberships,
  clearBusiness,
]

// ──────────────────────────────────────────────────────────── deleting

function tally(run: Run, what: string, n = 1) {
  if (n === 0) return
  run.deleted[what] = (run.deleted[what] ?? 0) + n
  run.left -= n
}

async function dropRow<T extends TableNames>(
  run: Run,
  table: T,
  id: Id<T>,
): Promise<boolean> {
  await run.ctx.db.delete(id)
  tally(run, table)
  return true
}

/**
 * Deletes what `read` returns, as much as this call has room for, each by
 * `drop` (its children first, say) or plainly. True when the read came back
 * short, which is the only proof that nothing is left.
 */
async function sweep<T extends TableNames>(
  run: Run,
  table: T,
  read: (n: number) => Promise<Array<Doc<T>>>,
  opts: { cap?: number; drop?: (row: Doc<T>) => Promise<boolean> } = {},
): Promise<boolean> {
  const want = Math.min(run.left, opts.cap ?? run.left)
  if (want <= 0) return false
  const rows = await read(want)
  for (const row of rows) {
    if (run.left <= 0) return false
    const dropped = opts.drop
      ? await opts.drop(row)
      : await dropRow(run, table, row._id)
    if (!dropped) return false
  }
  return rows.length < want
}

async function dropWithFile<T extends TableNames>(
  run: Run,
  table: T,
  id: Id<T>,
  file: Id<'_storage'>,
  rendered = false,
): Promise<boolean> {
  await dropFile(run, file, rendered)
  return dropRow(run, table, id)
}

/**
 * Deletes a stored file, once, if it is still there, it is the demo's own —
 * one the seed stored, or (`rendered`) a PDF the server made for a demo
 * report — and no real business is found using it.
 */
async function dropFile(
  run: Run,
  file: Id<'_storage'>,
  rendered = false,
): Promise<void> {
  if (run.filesSeen.has(file)) return
  run.filesSeen.add(file)
  if (!(await run.ctx.db.system.get('_storage', file))) return
  if (!rendered) {
    run.seedMade ??= new Set(await seedFiles(run.ctx, run.business._id))
    if (!run.seedMade.has(file)) return
  }
  if (await spared(run, file)) return
  await run.ctx.storage.delete(file)
  tally(run, 'storage')
}

/**
 * True for a file a real business still uses. The seed stores its own files
 * and points only at those, but a demo row can be pointed at any storage id
 * by hand, and deleting a real report's photo or a real member's signature
 * would be unrecoverable. So: the demo people's saved signatures and logos in
 * their other businesses, and any gallery photo, note image or product photo
 * or PDF of another business (the tables that can be asked which rows hold a
 * file).
 */
async function spared(run: Run, file: Id<'_storage'>): Promise<boolean> {
  const { ctx, business } = run
  if (!run.theirs) run.theirs = await filesElsewhere(run)
  if (run.theirs.has(file)) return true

  for await (const photo of ctx.db
    .query('reportPhotos')
    .withIndex('by_storage', (q) => q.eq('storageId', file))) {
    let owner = run.reportBusiness.get(photo.reportId)
    if (owner === undefined) {
      owner = (await ctx.db.get(photo.reportId))?.businessId ?? null
      run.reportBusiness.set(photo.reportId, owner)
    }
    if (owner !== null && owner !== business._id) return true
  }

  const attachment = await ctx.db
    .query('noteAttachments')
    .withIndex('by_storage', (q) => q.eq('storageId', file))
    .first()
  if (attachment) {
    const note = await ctx.db.get(attachment.noteId)
    if (note && note.businessId !== business._id) return true
  }

  // A product claims only an upload no product holds yet, so one row at most
  // should have it in each place; a few are read in case a hand-made row
  // broke that. The demo's own do not count — `clearProducts` has not reached
  // them yet when a report's files go.
  for (const held of [
    await ctx.db
      .query('products')
      .withIndex('by_photoStorageId', (q) => q.eq('photoStorageId', file))
      .take(10),
    await ctx.db
      .query('products')
      .withIndex('by_pdfStorageId', (q) => q.eq('pdfStorageId', file))
      .take(10),
  ]) {
    if (held.some((product) => product.businessId !== business._id)) {
      return true
    }
  }
  return false
}

async function filesElsewhere(run: Run): Promise<Set<Id<'_storage'>>> {
  const { ctx, business } = run
  const theirs = new Set<Id<'_storage'>>()
  for (const member of await membersOf(run)) {
    const elsewhere = await ctx.db
      .query('memberships')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(100)
    for (const other of elsewhere) {
      if (other.businessId === business._id) continue
      if (other.savedSignatureStorageId) {
        theirs.add(other.savedSignatureStorageId)
      }
      const logo = (await ctx.db.get(other.businessId))?.logoStorageId
      if (logo) theirs.add(logo)
    }
  }
  return theirs
}

async function membersOf(run: Run): Promise<Array<Doc<'memberships'>>> {
  if (!run.members) {
    run.members = await run.ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', run.business._id))
      .take(200)
  }
  return run.members
}

// ────────────────────────────────────────────────────────────── status

/** A count at its cap means at least that many. */
const STATUS_CAP = 1000
/** For rows heavy enough that reading a thousand could reach the limit. */
const STATUS_CAP_HEAVY = 200

/**
 * What is left of a demo business, table by table: every table `remove`
 * clears, read the way it reads them. All zero means gone. `noteBodies`
 * counts the business's notes that still have a body in the component, and
 * `storage` the seed's own files still stored (while the audit row listing
 * them survives).
 */
export const status = internalQuery({
  args: { businessId: v.id('businesses') },
  returns: v.record(v.string(), v.number()),
  handler: async (ctx, { businessId }) => {
    const business = await ctx.db.get(businessId)
    const recurrences = await ctx.db
      .query('recurrences')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .take(STATUS_CAP)
    const notes = await ctx.db
      .query('notes')
      .withIndex('by_business_updated', (q) => q.eq('businessId', businessId))
      .take(STATUS_CAP)
    const reports = await ctx.db
      .query('reports')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .take(STATUS_CAP_HEAVY)
    const templates = await ctx.db
      .query('customReportTemplates')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .take(STATUS_CAP_HEAVY)
    const jobs = await ctx.db
      .query('jobs')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .take(STATUS_CAP)
    const clients = await ctx.db
      .query('clients')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .take(STATUS_CAP)
    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .take(STATUS_CAP)

    const counts: Record<string, number> = {
      businesses: business ? 1 : 0,
      memberships: members.length,
      recurrences: recurrences.length,
      notes: notes.length,
      reports: reports.length,
      customReportTemplates: templates.length,
      jobs: jobs.length,
      clients: clients.length,
      properties: (
        await ctx.db
          .query('properties')
          .withIndex('by_business', (q) => q.eq('businessId', businessId))
          .take(STATUS_CAP)
      ).length,
      invitations: (
        await ctx.db
          .query('invitations')
          .withIndex('by_business', (q) => q.eq('businessId', businessId))
          .take(STATUS_CAP)
      ).length,
      auditLog: (
        await ctx.db
          .query('auditLog')
          .withIndex('by_business', (q) => q.eq('businessId', businessId))
          .take(STATUS_CAP)
      ).length,
      templateSettings: (
        await ctx.db
          .query('templateSettings')
          .withIndex('by_business_template', (q) =>
            q.eq('businessId', businessId),
          )
          .take(STATUS_CAP)
      ).length,
      optionSets: (
        await ctx.db
          .query('optionSets')
          .withIndex('by_business_key', (q) => q.eq('businessId', businessId))
          .take(STATUS_CAP)
      ).length,
      reportSnippets: (
        await ctx.db
          .query('reportSnippets')
          .withIndex('by_business_field', (q) => q.eq('businessId', businessId))
          .take(STATUS_CAP)
      ).length,
      products: (
        await ctx.db
          .query('products')
          .withIndex('by_businessId_and_nameKey', (q) =>
            q.eq('businessId', businessId),
          )
          .take(STATUS_CAP)
      ).length,
      reportDeliveries: (
        await ctx.db
          .query('reportDeliveries')
          .withIndex('by_business_status', (q) =>
            q.eq('businessId', businessId),
          )
          .take(STATUS_CAP)
      ).length,
    }

    // Found through their parents, so listed even when there are none.
    for (const child of [
      'reportPhotos',
      'reportPdfs',
      'reportPdfAnnotations',
      'customReportTemplateVersions',
      'jobPhotos',
      'clientContacts',
      'noteMentions',
      'noteAttachments',
      'noteBodies',
      'accountSwitches',
      'sessionViews',
    ]) {
      counts[child] = 0
    }
    const add = (what: string, n: number) => {
      counts[what] = (counts[what] ?? 0) + n
    }
    const countOf = async (rows: Promise<Array<unknown>>) => (await rows).length

    for (const report of reports) {
      add(
        'reportPhotos',
        await countOf(
          ctx.db
            .query('reportPhotos')
            .withIndex('by_report_field', (q) => q.eq('reportId', report._id))
            .take(STATUS_CAP),
        ),
      )
      add(
        'reportPdfs',
        await countOf(
          ctx.db
            .query('reportPdfs')
            .withIndex('by_report', (q) => q.eq('reportId', report._id))
            .take(STATUS_CAP),
        ),
      )
      add(
        'reportPdfAnnotations',
        await countOf(
          ctx.db
            .query('reportPdfAnnotations')
            .withIndex('by_report_page', (q) => q.eq('reportId', report._id))
            .take(STATUS_CAP),
        ),
      )
    }
    for (const template of templates) {
      add(
        'customReportTemplateVersions',
        await countOf(
          ctx.db
            .query('customReportTemplateVersions')
            .withIndex('by_template', (q) => q.eq('templateId', template._id))
            .take(STATUS_CAP_HEAVY),
        ),
      )
    }
    for (const job of jobs) {
      add(
        'jobPhotos',
        await countOf(
          ctx.db
            .query('jobPhotos')
            .withIndex('by_job', (q) => q.eq('jobId', job._id))
            .take(STATUS_CAP),
        ),
      )
    }
    for (const client of clients) {
      add(
        'clientContacts',
        await countOf(
          ctx.db
            .query('clientContacts')
            .withIndex('by_client', (q) => q.eq('clientId', client._id))
            .take(STATUS_CAP),
        ),
      )
    }
    for (const note of notes) {
      add(
        'noteMentions',
        await countOf(
          ctx.db
            .query('noteMentions')
            .withIndex('by_note', (q) => q.eq('noteId', note._id))
            .take(STATUS_CAP),
        ),
      )
      add(
        'noteAttachments',
        await countOf(
          ctx.db
            .query('noteAttachments')
            .withIndex('by_note', (q) => q.eq('noteId', note._id))
            .take(STATUS_CAP),
        ),
      )
      const body = await ctx.runQuery(
        components.prosemirrorSync.lib.getSnapshot,
        { id: note._id },
      )
      add('noteBodies', body.content === null ? 0 : 1)
    }
    for (const member of members) {
      add(
        'accountSwitches',
        (await countOf(
          ctx.db
            .query('accountSwitches')
            .withIndex('by_real', (q) => q.eq('realMembershipId', member._id))
            .take(STATUS_CAP),
        )) +
          (await countOf(
            ctx.db
              .query('accountSwitches')
              .withIndex('by_target', (q) =>
                q.eq('targetMembershipId', member._id),
              )
              .take(STATUS_CAP),
          )),
      )
      add(
        'sessionViews',
        await countOf(
          ctx.db
            .query('sessionViews')
            .withIndex('by_real', (q) => q.eq('realMembershipId', member._id))
            .take(STATUS_CAP),
        ),
      )
    }
    let filesLeft = 0
    for (const file of await seedFiles(ctx, businessId)) {
      if (await ctx.db.system.get('_storage', file)) filesLeft++
    }
    add('storage', filesLeft)
    return counts
  },
})
