import { ConvexError, v } from 'convex/values'
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { requireMembership } from './lib/access'
import {
  hasCapability,
  requireActor,
  requireCapability,
  requireWriteActor,
} from './lib/actor'
import { forSelf, recordAudit } from './lib/audit'
import { clientScope, reportScope } from './lib/capabilities'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { emailConfigured } from './lib/emailConfig'
import type { ActorEnvelope } from './lib/actor'
import { memberName } from './lib/reportContext'
import {
  knownRecipients as knownFor,
  normaliseAddresses,
} from './lib/recipients'
import { resolveReportTemplate } from '../src/lib/reportTemplates/resolve'
import { documentIdentity } from '../src/lib/reportTemplates/documentModel'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'

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
 * The row is also where the recipient rule lives. A technician may send to the
 * addresses already on the client's record; anywhere else is `pendingApproval`
 * until an owner says yes — a decision about a request that exists, rather
 * than one retyped from memory.
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
    subject: v.string(),
    trigger: v.union(v.literal('finalise'), v.literal('manual')),
    status: v.union(v.literal('queued'), v.literal('pendingApproval')),
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
      ...(status === 'sent' ? { sentAt: Date.now() } : {}),
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
    }
  },
})

/** The newest `reportPdfs` row, so a delivery records the file it attached. */
export const currentPdfId = internalQuery({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const rows = await ctx.db
      .query('reportPdfs')
      .withIndex('by_report', (q) => q.eq('reportId', reportId))
      .collect()
    return rows.sort((a, b) => b.createdAt - a.createdAt)[0]?._id ?? null
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
 * The recipient rule: a technician may send a report to the people the
 * business already corresponds with, and anywhere else waits for an owner.
 * That is not distrust of technicians — it is that a compliance document
 * emailed to a typo is gone, and the person best placed to notice a wrong
 * address is the one who owns the client relationship.
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
  const snapshot = report.templateSnapshotId
    ? await ctx.db.get(report.templateSnapshotId)
    : null
  const property = await ctx.db.get(report.propertyId)
  const business = await ctx.db.get(report.businessId)
  const template = resolveReportTemplate({
    template: report.template,
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplateSnapshot ?? null,
    templateSnapshot: snapshot,
  })
  return documentIdentity({
    template,
    property,
    businessName: business?.name ?? '',
    finalisedAt: report.finalisedAt,
  }).title
}

/**
 * The on-file addresses this caller may be told about.
 *
 * A client's contacts — the strata manager, the agent — are part of the
 * client book, and the client book has its own gate: `clients.directory`, or
 * the clients behind your own jobs. Being able to see a report (everyone's,
 * with "see everyone's schedule") is not that gate, so without this the
 * send sheet read out every contact's address for every client in the
 * business, one report id at a time.
 *
 * The person who wrote the report stood at that property, so their own
 * reports always count. Anyone else outside the client's scope still gets the
 * client's own address and the business's — both already on the report they
 * are looking at — and every other address is treated as new, which only
 * means an owner approves it. `request` applies the same rule, so its
 * queued-or-held answer cannot be used to test a guessed address either.
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
 * The addresses this business already corresponds with about this report.
 *
 * Public so the send sheet can say "this one needs the owner's approval"
 * BEFORE someone presses Send, rather than after. Nothing here is new to the
 * caller: they can already open the client record it comes from.
 */
export const known = query({
  args: { businessId: v.id('businesses'), reportId: v.id('reports') },
  handler: async (ctx, { businessId, reportId }) => {
    const env = await requireActor(ctx, businessId)
    const report = await ctx.db.get(reportId)
    if (!report || report.businessId !== businessId)
      return { addresses: [], unrestricted: false }
    if (!reportScope(env.scope, report))
      return { addresses: [], unrestricted: false }

    const business = await ctx.db.get(businessId)
    return {
      addresses: await knownToCaller(ctx, env, report),
      unrestricted:
        hasCapability(env, 'business.manage') ||
        business?.allowTechnicianRecipients === true,
    }
  },
})

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
      forSelf(
        delivery.sentByMembershipId ??
          delivery.approvedByMembershipId ??
          (await anyOwner(ctx, delivery.businessId)),
      ),
      {
        businessId: delivery.businessId,
        action: 'report.email.bounced',
        entityType: 'reports',
        entityId: delivery.reportId,
        meta: { to: delivery.to, event, detail },
        at: Date.now(),
      },
    )
  },
})

/**
 * An audit row needs an actor and a bounce has none — the provider is not a
 * member. Attributed to whoever asked for the send, and to an owner when the
 * form itself did.
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
    if (!reportScope(env.scope, report)) return []

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
    return described.map((row) => ({
      ...row,
      waitingForEmailSetup: row.status === 'queued' && !canSend,
    }))
  },
})

/**
 * The owner's approval queue: recipients a technician typed that are on
 * nobody's record.
 */
export const pendingApproval = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    // An empty list rather than an error, because the badge that reads this
    // renders for everyone. `business.manage` rather than a role: approving a
    // send is the owner's call, and not from inside somebody else's account.
    if (!hasCapability(env, 'business.manage')) return []

    const rows = await ctx.db
      .query('reportDeliveries')
      .withIndex('by_business_status', (q) =>
        q.eq('businessId', businessId).eq('status', 'pendingApproval'),
      )
      .take(50)

    return withActors(
      ctx,
      rows.sort((a, b) => b.createdAt - a.createdAt),
    )
  },
})

/**
 * Asks for a report to be sent to someone.
 *
 * All of the deciding happens here, in a mutation with database access: who
 * the caller is, whether the address is one the business already corresponds
 * with, what the subject should say. The action that follows only sends.
 *
 * Returns the row rather than sending it, because the two callers want
 * different things — someone pressing Send is watching and wants the outcome,
 * a finalise wants it off the critical path.
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
    if (!reportScope(env.scope, report)) throw new ConvexError('NO_ACCESS')
    if (report.status !== 'finalised')
      throw new ConvexError('REPORT_NOT_FINALISED')

    const addresses = normaliseAddresses(to)
    if (addresses.length === 0) throw new ConvexError('NO_RECIPIENT')

    await assertWithinSendLimit(ctx, membership._id)

    const business = await ctx.db.get(businessId)
    const onFile = await knownToCaller(ctx, env, report)
    // An owner may send where they like; it is their client relationship.
    const unrestricted =
      hasCapability(env, 'business.manage') ||
      business?.allowTechnicianRecipients === true
    const novel = addresses.filter((address) => !onFile.includes(address))
    const status =
      unrestricted || novel.length === 0 ? 'queued' : 'pendingApproval'

    const deliveryId = await ctx.db.insert('reportDeliveries', {
      businessId,
      reportId,
      to: addresses,
      cc: normaliseAddresses(cc ?? []),
      subject: await subjectFor(ctx, report),
      trigger: 'manual',
      status,
      sentByMembershipId: membership._id,
      createdAt: Date.now(),
    })

    if (status === 'pendingApproval') {
      await recordAudit(ctx, forSelf(membership._id), {
        businessId,
        action: 'report.email.pending_approval',
        entityType: 'reports',
        entityId: reportId,
        meta: { to: addresses, novel },
        at: Date.now(),
      })
    }

    return { deliveryId, status }
  },
})

/**
 * How many reports one person may send in an hour.
 *
 * Generous for a technician finishing a day's jobs, and far below what a
 * runaway retry loop or a compromised session would manage. A compliance
 * document is an attachment with a client's address on it: the cost of
 * sending a thousand of them is not the bandwidth.
 *
 * Counted from the delivery rows rather than a rate-limiter component,
 * because those rows already ARE the record of every send, exactly and
 * auditably — a separate token bucket would be a second, less accurate
 * account of the same events, and a dependency to keep them in step.
 */
const SEND_LIMIT = 20
const SEND_WINDOW_MS = 60 * 60 * 1000

async function assertWithinSendLimit(
  ctx: MutationCtx,
  membershipId: Id<'memberships'>,
) {
  const since = Date.now() - SEND_WINDOW_MS
  const recent = await ctx.db
    .query('reportDeliveries')
    .withIndex('by_sender', (q) =>
      q.eq('sentByMembershipId', membershipId).gt('createdAt', since),
    )
    .take(SEND_LIMIT)

  // `>=`, because this call is the one after the ones counted: twenty already
  // in the window means this would be the twenty-first.
  if (recent.length >= SEND_LIMIT) throw new ConvexError('SEND_RATE_LIMITED')
}

/**
 * An owner lets a held delivery go. The row is not rewritten — the request is
 * the technician's, and who approved it is part of the record.
 */
export const approve = mutation({
  args: {
    businessId: v.id('businesses'),
    deliveryId: v.id('reportDeliveries'),
  },
  handler: async (ctx, { businessId, deliveryId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'business.manage')
    const owner = env.actor.real
    const delivery = await ctx.db.get(deliveryId)
    if (!delivery || delivery.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (delivery.status !== 'pendingApproval') return

    await ctx.db.patch(deliveryId, {
      status: 'queued',
      approvedByMembershipId: owner._id,
    })
    await recordAudit(ctx, forSelf(owner._id), {
      businessId,
      action: 'report.email.approved',
      entityType: 'reports',
      entityId: delivery.reportId,
      meta: { to: delivery.to },
      at: Date.now(),
    })
    // Approved is approved; sending waits for email to be set up, and the
    // history says so (`forReport`) rather than logging a send that can only
    // throw.
    if (emailConfigured()) {
      await ctx.scheduler.runAfter(0, internal.email.deliver, { deliveryId })
    }
  },
})

/** An owner refuses one. Kept, not deleted: a refusal is part of the record. */
export const reject = mutation({
  args: {
    businessId: v.id('businesses'),
    deliveryId: v.id('reportDeliveries'),
  },
  handler: async (ctx, { businessId, deliveryId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'business.manage')
    const owner = env.actor.real
    const delivery = await ctx.db.get(deliveryId)
    if (!delivery || delivery.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (delivery.status !== 'pendingApproval') return

    await ctx.db.patch(deliveryId, {
      status: 'failed',
      error: 'Not approved',
      approvedByMembershipId: owner._id,
    })
    await recordAudit(ctx, forSelf(owner._id), {
      businessId,
      action: 'report.email.rejected',
      entityType: 'reports',
      entityId: delivery.reportId,
      meta: { to: delivery.to },
      at: Date.now(),
    })
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
        [row.sentByMembershipId, row.approvedByMembershipId].filter(
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
    approvedBy: who(row.approvedByMembershipId),
  }))
}
