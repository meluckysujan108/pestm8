import { ConvexError, v } from 'convex/values'
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { requireMembership } from './lib/access'
import { requireActor, requireWriteActor } from './lib/actor'
import { forSelf, recordAudit } from './lib/audit'
import type { AuditAttribution } from './lib/audit'
import { clientScope, writeAttribution } from './lib/capabilities'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { emailConfigured } from './lib/emailConfig'
import { EMAIL_BUDGET_BYTES } from './lib/emailFit'
import { isValidEmail } from './lib/email'
import { addressedTo } from './lib/reportEmail'
import { assertWithinSendLimit } from './lib/sendLimit'
import type { ActorEnvelope } from './lib/actor'
import { memberName } from './lib/reportContext'
import {
  businessCopyAddress,
  knownRecipients as knownFor,
  normaliseAddresses,
} from './lib/recipients'
import { blindCopy } from '../src/lib/reportTemplates/delivery'
import { printedGalleryKeys, sectionsOf } from '../src/lib/reportTemplates'
import { resolveReportTemplate } from '../src/lib/reportTemplates/resolve'
import { documentIdentity } from '../src/lib/reportTemplates/documentModel'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { reportReadableHere } from './lib/jobPeople'

/**
 * Sending a report, as a record rather than an event.
 *
 * A send used to be a fire-and-forget action: it called Resend, wrote an audit
 * line and set `emailedAt`. That answers "was this emailed?" and nothing else
 * — not who to, not which file, not whether the one that failed was ever
 * retried. A finalised report is a legal record and the thing a client argues
 * about is usually the delivery, so every attempt is a row here, written
 * BEFORE the provider is called, naming the `reportPdfs` row it attached.
 *
 * The row is also what keeps sending honest, now that nothing gates it.
 * Anyone who may send a report may send it to any address that can receive
 * email. Until 29 Sept 2026 a technician's email to an address that was not on
 * the client's record waited here as `pendingApproval` for an owner — and no
 * screen anywhere could give that approval, so it waited forever while the
 * Send sheet said it would go. So instead of a gate there is a record: every
 * row names who asked, from whose account, and which of its addresses were
 * not on the client's record (`newAddresses`); the report's Email and Logs
 * tabs show all of it; and the business's own copy goes, blind, on every
 * email (`lib/recipients.businessCopyAddress`).
 */

export type DeliveryStatus = Doc<'reportDeliveries'>['status']

/**
 * Opens a delivery. Nothing is sent yet: the caller schedules that, and the
 * row is what it works from.
 */
export const queue = internalMutation({
  args: {
    reportId: v.id('reports'),
    to: v.array(v.string()),
    cc: v.array(v.string()),
    bcc: v.optional(v.array(v.string())),
    subject: v.string(),
    trigger: v.union(v.literal('finalise'), v.literal('manual')),
    status: v.literal('queued'),
    sentByMembershipId: v.optional(v.id('memberships')),
  },
  handler: async (ctx, { reportId, ...rest }) => {
    const report = await ctx.db.get(reportId)
    if (!report) throw new ConvexError('NOT_FOUND')
    return ctx.db.insert('reportDeliveries', {
      businessId: report.businessId,
      reportId,
      ...rest,
      createdAt: Date.now(),
    })
  },
})

/**
 * Records what the provider said.
 *
 * `sent` here means accepted by Resend, which is not the same as landed in an
 * inbox — a webhook moves it to `bounced` later, and the list copy says
 * "Sent" because that is genuinely all we know until it does.
 */
export const settle = internalMutation({
  args: {
    deliveryId: v.id('reportDeliveries'),
    status: v.union(v.literal('sent'), v.literal('failed')),
    pdfId: v.optional(v.id('reportPdfs')),
    providerMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { deliveryId, status, pdfId, providerMessageId, error },
  ) => {
    const delivery = await ctx.db.get(deliveryId)
    if (!delivery) return
    await ctx.db.patch(deliveryId, {
      status,
      ...(pdfId ? { pdfId } : {}),
      ...(providerMessageId ? { providerMessageId } : {}),
      ...(error ? { error: error.slice(0, 500) } : {}),
      // Accepted clears an earlier word to the contrary: a report deleted
      // while its email was already on the way marks the row not sent
      // (reports.softDelete), and then it went.
      ...(status === 'sent' ? { sentAt: Date.now(), error: undefined } : {}),
    })

    if (status === 'sent') {
      // Kept for the list's own bucket, which reads one field rather than
      // every delivery of every report.
      await ctx.db.patch(delivery.reportId, { emailedAt: Date.now() })
    }
  },
})

/** Everything the sender needs, with no caller to check — see `getForRender`. */
export const forSending = internalQuery({
  args: { deliveryId: v.id('reportDeliveries') },
  handler: async (ctx, { deliveryId }) => {
    const delivery = await ctx.db.get(deliveryId)
    if (!delivery) return null
    const report = await ctx.db.get(delivery.reportId)
    if (!report || report.deletedAt !== undefined) return null
    return {
      delivery,
      reportId: delivery.reportId,
      businessId: delivery.businessId,
      // Every way a row is opened already requires a finalised report; the
      // sender checks again, so no future path can email a draft.
      finalised: report.status === 'finalised',
    }
  },
})

/**
 * Deliveries waiting to be sent for a report that has just been rendered.
 * Scheduled sends go through here so the pipeline does not have to remember
 * what `finalise` decided.
 */
export const readyForReport = internalQuery({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const rows = await ctx.db
      .query('reportDeliveries')
      .withIndex('by_report', (q) => q.eq('reportId', reportId))
      .collect()
    return rows.filter((row) => row.status === 'queued').map((row) => row._id)
  },
})

/**
 * The addresses already on this client's record.
 *
 * Nothing waits on this any more. It is what a send records as new
 * (`newAddresses`): a compliance document emailed to a typo is simply gone,
 * so an address the business has never corresponded with is worth a second
 * look, by the person sending it and by an owner reading the history.
 */
export const knownRecipients = internalQuery({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get(reportId)
    return report ? knownFor(ctx, report) : []
  },
})

/**
 * What the email says it is, which is what the document says it is.
 *
 * Resolved from the report's FROZEN wording: a report emailed after the form
 * was reworded must not arrive named for a form it is not.
 */
async function subjectFor(
  ctx: QueryCtx | MutationCtx,
  report: Doc<'reports'>,
): Promise<string> {
  const property = await ctx.db.get(report.propertyId)
  const business = await ctx.db.get(report.businessId)
  return documentIdentity({
    template: await templateOf(ctx, report),
    property,
    businessName: business?.name ?? '',
    finalisedAt: report.finalisedAt,
  }).title
}

/**
 * The form a report is on: its FROZEN wording once finalised, else the form
 * as it stands. Only a custom report finalised before snapshots existed has
 * no frozen wording, and reads as its form. A draft reads as its builder
 * shows it, without a client's part that is left out.
 */
async function templateOf(ctx: QueryCtx | MutationCtx, report: Doc<'reports'>) {
  const snapshot = report.templateSnapshotId
    ? await ctx.db.get(report.templateSnapshotId)
    : null
  const live =
    !snapshot && report.template === 'custom' && report.customTemplateId
      ? await ctx.db.get(report.customTemplateId)
      : null
  return resolveReportTemplate({
    template: report.template,
    templateVersion: report.templateVersion,
    customTemplate: live,
    templateSnapshot: snapshot,
    status: report.status,
    signedSlots: Object.keys(report.signatureSlots ?? {}),
  })
}

/**
 * The on-file addresses this caller may be told about.
 *
 * A client's contacts — the strata manager, the agent — are part of the
 * client book, and the client book has its own gate: `clients.directory`, or
 * the clients behind your own jobs. Every role holds `clients.directory` now
 * (the book is open to everyone in the business), so today this always
 * includes the contacts; the narrower branch is the path back if a business
 * ever restricts it again. Being able to see a report (everyone's,
 * with "see everyone's schedule") is not that gate, so without this the
 * send sheet read out every contact's address for every client in the
 * business, one report id at a time.
 *
 * The person who wrote the report stood at that property, so their own
 * reports always count. Anyone else outside the client's scope still gets the
 * client's own address and the business's — both already on the report they
 * are looking at — and every other address is treated as new, which only
 * means the send records it as new. `request` applies the same rule, so what
 * a row records cannot be used to test whether a guessed address is one of
 * the client's contacts either.
 */
async function knownToCaller(
  ctx: QueryCtx,
  env: ActorEnvelope,
  report: Doc<'reports'>,
): Promise<Array<string>> {
  const own =
    report.authorMembershipId === env.actor.real._id ||
    report.authorMembershipId === env.actor.acting._id
  let withContacts = own || clientScope(env.caps) === 'directory'
  if (!withContacts) {
    const property = await ctx.db.get(report.propertyId)
    withContacts =
      property !== null &&
      inClientScope(await visibleClientIds(ctx, env), property.clientId)
  }
  return knownFor(ctx, report, { withContacts })
}

/**
 * The addresses this business already corresponds with about this report,
 * and what happens to an email of it.
 *
 * Public so the send sheet can mark an address that is new to this client
 * BEFORE someone presses Send, rather than after — and so it, and the sheet
 * that locks a draft, can say where the business's own copy goes before
 * anything is sent. Nothing here is new to the caller: they can already open
 * the client record the addresses come from, and the business's email is on
 * every report it prints.
 */
export const known = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const env = await requireActor(ctx, businessId)
    const none = {
      addresses: [],
      copy: null,
      emailReady: false,
      largeForEmail: false,
    }
    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return none
    if (
      !(await reportReadableHere(ctx, env.scope, env.actor.real._id, report))
    ) {
      return none
    }

    const business = await ctx.db.get(businessId)
    return {
      addresses: await knownToCaller(ctx, env, report),
      /** The blind copy every email of this report carries, if any. */
      copy: businessCopyAddress(business),
      /** Whether this deployment can send at all (`lib/emailConfig`). */
      emailReady: emailConfigured(),
      /**
       * Whether an email of it goes as the lighter copy, with smaller photos
       * (convex/emailCopy.ts) — so the sheets can say so before it is sent.
       */
      largeForEmail: await largeForEmail(ctx, report),
    }
  },
})

/** A guard on how many of a report's photos are weighed; a big job has fifty. */
const PHOTO_ROWS = 1000

/**
 * Whether this report is more than an email carries.
 *
 * Once it has a PDF, that file's size says. Before — on the sheet that locks
 * it — the photos it will print do: a report's PDF is its photos and a few
 * pages besides (33.5 of 33.7 MiB on 30 Sept 2026). Only the sets that print
 * count (`printedGalleryKeys`, as the painter decides): photos in a set whose
 * question was answered No add nothing to the PDF.
 */
async function largeForEmail(
  ctx: QueryCtx,
  report: Doc<'reports'>,
): Promise<boolean> {
  if (report.pdfStorageId) {
    const file = await ctx.db.system.get('_storage', report.pdfStorageId)
    if (file) return file.size > EMAIL_BUDGET_BYTES
  }
  const printed = printedGalleryKeys(
    sectionsOf(await templateOf(ctx, report)),
    (report.data ?? {}) as Record<string, unknown>,
  )
  // Its size as recorded at upload, where it was; the file's own, where not.
  const sizeOf = async (storageId: Id<'_storage'>, recorded?: number) =>
    recorded ?? (await ctx.db.system.get('_storage', storageId))?.size ?? 0

  let total = 0
  for (const storageId of Object.values(report.photoSlots ?? {})) {
    total += await sizeOf(storageId)
    if (total > EMAIL_BUDGET_BYTES) return true
  }
  const photos = await ctx.db
    .query('reportPhotos')
    .withIndex('by_report_field', (q) => q.eq('reportId', report._id))
    .take(PHOTO_ROWS)
  for (const photo of photos) {
    if (!printed.has(photo.fieldKey)) continue
    total += await sizeOf(photo.storageId, photo.bytes)
    if (total > EMAIL_BUDGET_BYTES) return true
  }
  return false
}

/**
 * What the provider told us later.
 *
 * "Sent" means Resend accepted it, which is not the same as it landing in an
 * inbox — and on a compliance record the difference matters, because a report
 * a client never received is a report that was not delivered however green the
 * row looks. A bounce arrives minutes later and moves the row.
 *
 * Matched by the provider's own message id, which is the only thing a webhook
 * knows about us. Unknown ids are ignored rather than erroring: a webhook for
 * a message this deployment never sent is noise, not a failure.
 */
export const recordProviderEvent = internalMutation({
  args: {
    providerMessageId: v.string(),
    event: v.union(
      v.literal('delivered'),
      v.literal('bounced'),
      v.literal('complained'),
    ),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { providerMessageId, event, detail }) => {
    const delivery = await ctx.db
      .query('reportDeliveries')
      .withIndex('by_provider_message', (q) =>
        q.eq('providerMessageId', providerMessageId),
      )
      .unique()
    if (!delivery) return

    if (event === 'delivered') {
      // Already 'sent'; a delivery confirmation adds nothing the row does not
      // say, and demoting a bounced row back to sent would lose the fact.
      return
    }

    await ctx.db.patch(delivery._id, {
      status: 'bounced',
      error:
        detail ??
        (event === 'complained'
          ? 'Marked as spam by the recipient'
          : 'The address bounced'),
    })

    // The report's own "Sent" bucket has to stop claiming it: that flag is
    // what the library reads, and a bounced report is not a sent one.
    const report = await ctx.db.get(delivery.reportId)
    if (report?.emailedAt !== undefined) {
      const others = await ctx.db
        .query('reportDeliveries')
        .withIndex('by_report', (q) => q.eq('reportId', delivery.reportId))
        .collect()
      const stillSent = others.some(
        (row) => row._id !== delivery._id && row.status === 'sent',
      )
      if (!stillSent)
        await ctx.db.patch(delivery.reportId, { emailedAt: undefined })
    }

    await recordAudit(
      ctx,
      delivery.sentByMembershipId
        ? sendAttribution(delivery.sentByMembershipId, delivery)
        : forSelf(
            delivery.approvedByMembershipId ??
              (await anyOwner(ctx, delivery.businessId)),
          ),
      {
        businessId: delivery.businessId,
        action: 'report.email.bounced',
        entityType: 'reports',
        entityId: delivery.reportId,
        // Everyone that email was addressed to, as the sent line had it.
        meta: { ...addressedTo(delivery), event, detail },
        at: Date.now(),
      },
    )
  },
})

/**
 * Who a delivery's outcome is written down against: whoever asked for it,
 * and the account they asked from when it was not their own — so the report's
 * Logs read "Terence, in Kevin's account" for a send made there, as they do
 * for an edit.
 */
function sendAttribution(
  sentByMembershipId: Id<'memberships'>,
  delivery: Pick<Doc<'reportDeliveries'>, 'onBehalfOfMembershipId'>,
): AuditAttribution {
  return {
    actorMembershipId: sentByMembershipId,
    onBehalfOfMembershipId: delivery.onBehalfOfMembershipId,
  }
}

/**
 * An audit row needs an actor and a bounce has none — the provider is not a
 * member. Attributed to whoever asked for the send, and to an owner on a row
 * from before every delivery named who asked.
 */
async function anyOwner(ctx: MutationCtx, businessId: Id<'businesses'>) {
  const owner = await ctx.db
    .query('memberships')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .filter((q) => q.eq(q.field('role'), 'owner'))
    .first()
  if (!owner) throw new ConvexError('NOT_FOUND')
  return owner._id
}

/** Who this report has been sent to, and how each attempt went. */
export const forReport = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const env = await requireActor(ctx, businessId)
    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId) return []
    if (
      !(await reportReadableHere(ctx, env.scope, env.actor.real._id, report))
    ) {
      return []
    }

    const rows = await ctx.db
      .query('reportDeliveries')
      .withIndex('by_report', (q) => q.eq('reportId', reportId))
      .collect()

    // A queued row is only "on its way" if something can send it. Without
    // email set up it will sit there, and the history has to say why rather
    // than let "Queued" read as a promise.
    const canSend = emailConfigured()
    const described = await withActors(
      ctx,
      rows.sort((a, b) => b.createdAt - a.createdAt),
    )
    return Promise.all(
      described.map(async (row) => ({
        ...row,
        waitingForEmailSetup: row.status === 'queued' && !canSend,
        // It went as the lighter copy, with smaller photos, because the
        // report's own PDF was more than an email carries (convex/emailCopy.ts).
        lighterCopy: row.pdfId
          ? (await ctx.db.get(row.pdfId))?.variant === 'email'
          : false,
      })),
    )
  },
})

/**
 * Asks for a report to be sent to someone.
 *
 * All of the deciding happens here, in a mutation with database access: who
 * the caller is, whether they may send this report, what the subject should
 * say, and which of the addresses the business has never corresponded with
 * about it. The action that follows only sends.
 *
 * Every address that can receive email is queued, whoever asks: there is no
 * approval step (see the top of this file). An address that is new to this
 * client goes too, and the row says it was new.
 *
 * Returns the row rather than sending it, because the two callers want
 * different things — someone pressing Send is watching and wants the outcome,
 * a finalise wants it off the critical path. `status` is always `queued` now;
 * it is still returned because callers written before this change read it.
 */
export const request = mutation({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    to: v.array(v.string()),
    cc: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { businessId, reportId, to, cc }) => {
    const membership = await requireMembership(ctx, businessId)
    // Who is sending is the membership, which is what the rate limit counts
    // and the row records. Whether they may send this report, and anywhere at
    // all, are the WRITE actor's scope and capability: a send is a write, and
    // the read scope carries the legacy read-only view-as lens, which would
    // let someone email a report from another person's account they were
    // only ever allowed to look at.
    const env = await requireWriteActor(ctx, businessId)
    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId)
      throw new ConvexError('NOT_FOUND')
    if (report.deletedAt !== undefined) throw new ConvexError('NOT_FOUND')
    if (!(await reportReadableHere(ctx, env.scope, env.actor.real._id, report)))
      throw new ConvexError('NO_ACCESS')
    if (report.status !== 'finalised')
      throw new ConvexError('REPORT_NOT_FINALISED')

    const addresses = normaliseAddresses(to)
    if (addresses.length === 0) throw new ConvexError('NO_RECIPIENT')
    const copies = normaliseAddresses(cc ?? [])
    // An address that can never be delivered to (lib/email.ts) is refused
    // outright rather than queued: it would sit in the history as a send that
    // was never going to arrive, and the technician would have left the site
    // believing it had.
    if (![...addresses, ...copies].every(isValidEmail)) {
      throw new ConvexError('INVALID_EMAIL')
    }

    await assertWithinSendLimit(
      ctx,
      membership._id,
      addresses.length + copies.length,
    )

    const business = await ctx.db.get(businessId)
    const onFile = await knownToCaller(ctx, env, report)

    const deliveryId = await ctx.db.insert('reportDeliveries', {
      businessId,
      reportId,
      to: addresses,
      cc: copies,
      // The business's own copy of every report it emails, and not only the
      // ones a form asked for: a send from this sheet is the same kind of
      // email, to the same kind of person. Blind, as at finalise.
      bcc: blindCopy(businessCopyAddress(business), [...addresses, ...copies]),
      subject: await subjectFor(ctx, report),
      trigger: 'manual',
      status: 'queued',
      // Recorded, not held: what an owner reading the history needs to see
      // that a report went somewhere new.
      newAddresses: [...addresses, ...copies].filter(
        (address) => !onFile.includes(address),
      ),
      sentByMembershipId: membership._id,
      onBehalfOfMembershipId: writeAttribution(env.actor)
        .onBehalfOfMembershipId,
      createdAt: Date.now(),
    })

    return { deliveryId, status: 'queued' as const }
  },
})

/**
 * Names, not membership ids. A delivery history that reads "sent by k57d9…"
 * tells an owner nothing about who sent it, and "who sent this to the wrong
 * address" is the question this history exists to answer.
 *
 * Everyone by their own name, the owner included: he works jobs and sends
 * reports like anyone else, and is on everyone's roster.
 */
async function withActors(
  ctx: QueryCtx | MutationCtx,
  rows: Array<Doc<'reportDeliveries'>>,
) {
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        [row.sentByMembershipId, row.onBehalfOfMembershipId].filter(
          (id): id is Id<'memberships'> => id !== undefined,
        ),
      ),
    ),
  ]
  const members = new Map(
    await Promise.all(
      ids.map(async (id) => {
        const member = await ctx.db.get(id)
        if (!member) return [id, null] as const
        return [
          id,
          {
            name: await memberName(ctx, member.userId),
            colour: member.colour,
          },
        ] as const
      }),
    ),
  )
  const who = (id?: Id<'memberships'>) =>
    id ? (members.get(id) ?? null) : null

  return rows.map((row) => ({
    ...row,
    sentBy: who(row.sentByMembershipId),
    /** The account it was sent from, when that was not the sender's own. */
    onBehalfOf: who(row.onBehalfOfMembershipId),
  }))
}
