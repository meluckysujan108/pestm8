'use node'

import { ConvexError, v } from 'convex/values'
import { action, internalAction } from './_generated/server'
import { api, internal } from './_generated/api'
import { renderIfNeeded } from './reportPipeline'
import { emailConfigured } from './lib/emailConfig'
import {
  addressedTo,
  deliveryAddressing,
  reportEmailHtml,
} from './lib/reportEmail'
import type { ActionCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'

/**
 * Sending a finished report to the people it is for.
 *
 * A plain `fetch` to Resend's REST API rather than their SDK — the payload is
 * one JSON body with a base64 attachment, and `fetch` already works in every
 * Convex runtime, so a dependency buys nothing. `"use node"` is for `Buffer`,
 * used to base64-encode the PDF.
 *
 * Requires `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (see `lib/emailConfig`).
 * Resend only sends from a domain verified on the account, so a customer's own
 * business email cannot be the `from` address; it goes in `reply-to` instead.
 * Until both exist this fails with `EMAIL_NOT_CONFIGURED` rather than silently
 * doing nothing.
 *
 * Every send goes through a `reportDeliveries` row, written before the
 * provider is called. See `convex/deliveries.ts` for why.
 */

/**
 * Sends one queued delivery.
 *
 * Internal and scheduled, so it can run after a finalise with no caller and
 * no identity: the row it works from already carries every decision a caller
 * would have made.
 */
export const deliver = internalAction({
  args: { deliveryId: v.id('reportDeliveries') },
  handler: async (
    ctx,
    { deliveryId },
  ): Promise<{ ok: boolean; reason?: string }> => {
    const loaded = await ctx.runQuery(internal.deliveries.forSending, { deliveryId })
    if (!loaded) return { ok: false, reason: 'gone' }
    const { delivery, reportId, businessId } = loaded
    if (delivery.status !== 'queued') {
      return { ok: false, reason: delivery.status }
    }
    // Only a finished report is ever emailed. Every way a row is opened
    // already insists on it; this is the last door, so a path added later
    // cannot send a draft by forgetting to ask.
    if (!loaded.finalised) {
      const detail =
        'Not sent: the report wasn’t finalised. Finalise it, then send it again.'
      await ctx.runMutation(internal.deliveries.settle, {
        deliveryId,
        status: 'failed',
        error: detail,
      })
      await audit(ctx, businessId, reportId, delivery, {
        action: 'report.email.failed',
        meta: { ...addressedTo(delivery), detail },
      })
      return { ok: false, reason: 'notFinalised' }
    }

    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey || !emailConfigured()) {
      // Not a failure of this delivery — nothing was attempted, and marking
      // it failed would put a red row in a history that records real sends.
      // The row stays queued, and the history says why (`deliveries.forReport`).
      throw new ConvexError('EMAIL_NOT_CONFIGURED')
    }

    try {
      const storageId = await renderIfNeeded(ctx, reportId)
      if (!storageId) throw new ConvexError('PDF_UNAVAILABLE')

      const report = await ctx.runQuery(internal.reports.getForRender, { reportId })
      if (!report) throw new ConvexError('NOT_FOUND')

      const { resolveReportTemplate } = await import(
        '../src/lib/reportTemplates/resolve'
      )
      const template = resolveReportTemplate({
        template: report.template,
        customTemplate: report.customTemplate,
        // Without this, a report emailed after a wording change is named for
        // the NEW template, for a document whose contents are the old one.
        templateSnapshot: report.templateSnapshot,
        templateVersion: report.templateVersion,
      })

      const { documentIdentity } = await import(
        '../src/lib/reportTemplates/documentModel'
      )
      const { reportSummary } = await import('../src/lib/reportTemplates/summary')
      const identity = documentIdentity({
        template,
        property: report.property,
        businessName: report.businessName,
        finalisedAt: report.finalisedAt,
      })

      const url = await ctx.storage.getUrl(storageId)
      if (!url) throw new ConvexError('PDF_UNAVAILABLE')
      // Checked, because an unchecked fetch base64-encodes whatever came back
      // — a storage error page attaches perfectly happily, and the client
      // receives a "PDF" that is an XML error document.
      const fetched = await fetch(url)
      if (!fetched.ok) throw new ConvexError('PDF_UNAVAILABLE')
      const pdf = Buffer.from(await fetched.arrayBuffer())
      if (pdf.length > MAX_ATTACHMENT_BYTES) {
        throw new ConvexError('PDF_TOO_LARGE')
      }

      const fromEmail = process.env.RESEND_FROM_EMAIL
      if (!fromEmail) throw new ConvexError('EMAIL_NOT_CONFIGURED')
      const sender = report.sender?.name ?? report.businessName
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // One send per delivery row, however many times this is retried.
          'Idempotency-Key': `delivery-${deliveryId}`,
        },
        body: JSON.stringify({
          // The business as it is NOW, not as it was when the report was
          // signed: a from-name and a reply-to are delivery settings, not
          // content. A reply to a mailbox they closed is not a reply.
          from: `${sender} <${fromEmail}>`,
          ...deliveryAddressing(delivery),
          reply_to: report.sender?.email || report.business?.email || undefined,
          subject: delivery.subject,
          html: reportEmailHtml({
            businessName: report.businessName,
            formName: template.print?.formName ?? template.name,
            address: report.property
              ? `${report.property.addressLine}, ${report.property.suburb}`
              : undefined,
            // The same handful the finalise sheet reads back, for the same
            // reason: nobody should have to open a PDF on a phone to find out
            // when the next visit is due.
            facts: reportSummary(
              template,
              (report.data ?? {}) as Record<string, unknown>,
              report.context,
            ).map((line) => ({ label: line.label, value: line.text })),
            logoUrl: report.business?.logoUrl ?? undefined,
          }),
          attachments: [
            { filename: identity.fileName, content: pdf.toString('base64') },
          ],
        }),
      })

      if (!response.ok) {
        // Resend's own words are for whoever fixes it, not for the history a
        // technician reads: they go to the deployment's logs, and ride on the
        // Logs line out of sight, while the row says what to do next.
        const reply = (await response.text()).slice(0, 500)
        console.error('email.deliver: refused', deliveryId, response.status, reply)
        const detail = refusalWords(response.status)
        const pdfId = await ctx.runQuery(internal.deliveries.currentPdfId, {
          reportId,
        })
        await ctx.runMutation(internal.deliveries.settle, {
          deliveryId,
          status: 'failed',
          error: detail,
          ...(pdfId ? { pdfId } : {}),
        })
        await audit(ctx, businessId, reportId, delivery, {
          action: 'report.email.failed',
          meta: { ...addressedTo(delivery), detail, reply },
        })
        return { ok: false, reason: 'provider' }
      }

      // Resend has it: the email is out. `recordSent` never throws, so
      // nothing past this point can mark it failed.
      await recordSent(ctx, { deliveryId, delivery, businessId, reportId }, response)
      return { ok: true }
    } catch (error) {
      // Only ever before Resend took it, so nothing went out.
      const reply = error instanceof Error ? error.message : String(error)
      console.error('email.deliver: not sent', deliveryId, reply)
      const detail = failureWords(error)
      await ctx.runMutation(internal.deliveries.settle, {
        deliveryId,
        status: 'failed',
        error: detail,
      })
      // Logged as well as recorded on the row, like a refusal from the
      // provider: a report whose PDF could not be drawn or attached was not
      // emailed either, and the report's Logs are where an owner looks to
      // see what went out and what did not.
      await audit(ctx, businessId, reportId, delivery, {
        action: 'report.email.failed',
        meta: { ...addressedTo(delivery), detail, reply },
      })
      throw error
    }
  },
})

/**
 * Sends a finished report to one address, on someone's say-so.
 *
 * Keeps its argument shape: the report action bar and the e2e suite both call
 * it this way. What changed is underneath — the send is a delivery row, which
 * records whether the address was new to this client. Nothing waits for an
 * owner (`deliveries.ts`).
 */
export const sendReportPdf = action({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    to: v.string(),
  },
  handler: async (
    ctx,
    { businessId, reportId, to },
  ): Promise<{ ok: boolean; deliveryId: Id<'reportDeliveries'> }> => {
    // Access first, configuration second. The other order answers a stranger's
    // probe with EMAIL_NOT_CONFIGURED, which confirms the report exists.
    const report = await ctx.runQuery(api.reports.get, { businessId, reportId })
    if (!report) throw new ConvexError('NOT_FOUND')

    // A missing key is a configuration problem, not an attempt worth
    // recording against the report's history — so it is checked before a row
    // is written. `RESEND_FROM_EMAIL` is required too, whatever the older
    // comment claimed: Resend rejects a `from` that is a bare display name.
    if (!emailConfigured()) {
      throw new ConvexError('EMAIL_NOT_CONFIGURED')
    }

    const { deliveryId } = await ctx.runMutation(api.deliveries.request, {
      businessId,
      reportId,
      to: [to],
    })

    // Run it here rather than scheduling it: whoever pressed Send is watching,
    // and "it went" or "it did not" is the answer they asked for.
    const result = await ctx.runAction(internal.email.deliver, { deliveryId })
    if (!result.ok) throw new ConvexError('EMAIL_SEND_FAILED')
    return { ok: true, deliveryId }
  },
})

/**
 * Writes down that Resend took an email — which file it attached, Resend's
 * id for it, and a line in the report's Logs.
 *
 * Never throws. The email is out, and a failure in our own record of it must
 * not read as a failed send: "Could not email" would have someone send the
 * client a second copy, under a new delivery and so a new idempotency key.
 * What could not be written down goes to the deployment's logs instead.
 */
async function recordSent(
  ctx: ActionCtx,
  {
    deliveryId,
    delivery,
    businessId,
    reportId,
  }: {
    deliveryId: Id<'reportDeliveries'>
    delivery: Doc<'reportDeliveries'>
    businessId: Id<'businesses'>
    reportId: Id<'reports'>
  },
  response: Response,
): Promise<void> {
  try {
    // An unreadable reply is still an accepted one: only the id is lost.
    const body = (await response.json().catch(() => ({}))) as { id?: string }
    const pdfId = await ctx.runQuery(internal.deliveries.currentPdfId, {
      reportId,
    })
    await ctx.runMutation(internal.deliveries.settle, {
      deliveryId,
      status: 'sent',
      ...(pdfId ? { pdfId } : {}),
      ...(body.id ? { providerMessageId: body.id } : {}),
    })
    await audit(ctx, businessId, reportId, delivery, {
      action: 'report.email.sent',
      meta: { ...addressedTo(delivery), subject: delivery.subject },
    })
  } catch (error) {
    console.error('email.deliver: sent, but not recorded', deliveryId, error)
  }
}

/** Resend's own ceiling is 40 MB for the whole message; this is the safe half. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

async function audit(
  ctx: ActionCtx,
  businessId: Id<'businesses'>,
  reportId: Id<'reports'>,
  delivery: Pick<
    Doc<'reportDeliveries'>,
    'sentByMembershipId' | 'onBehalfOfMembershipId'
  >,
  entry: { action: string; meta: unknown },
) {
  // Every delivery written now names who asked for it (see the schema). A
  // row without one has nobody to attribute the outcome to, and the delivery
  // row is its record — an audit line attributed to nobody would be worse.
  if (!delivery.sentByMembershipId) return
  await ctx.runMutation(internal.auditLog.log, {
    businessId,
    actorMembershipId: delivery.sentByMembershipId,
    // "Terence, in Kevin's account" when that is where it was sent from.
    ...(delivery.onBehalfOfMembershipId
      ? { onBehalfOfMembershipId: delivery.onBehalfOfMembershipId }
      : {}),
    action: entry.action,
    entityType: 'reports',
    entityId: reportId,
    meta: entry.meta,
  })
}

/**
 * Why a send died before Resend took it, in words, with what to do next: the
 * Email tab's history and the report's Logs both show it, and
 * "PDF_TOO_LARGE", or a stack trace, is not something to read on a phone.
 */
const FAILURE_WORDS = new Map<unknown, string>([
  [
    'PDF_UNAVAILABLE',
    'Not sent: the PDF could not be prepared to attach. Open the PDF tab, then send it again.',
  ],
  [
    'PDF_TOO_LARGE',
    'Not sent: the PDF is too large to email. Share it from the PDF tab instead.',
  ],
  [
    'NOT_FOUND',
    'Not sent: the report could not be found. Ask the business owner.',
  ],
])

function failureWords(error: unknown): string {
  return (
    FAILURE_WORDS.get((error as { data?: unknown } | null)?.data) ??
    'Not sent: it stopped before it reached the email service. Send it again in a few minutes.'
  )
}

/** Why Resend said no, in words, from its HTTP status. */
function refusalWords(status: number): string {
  if (status === 429) {
    return 'Not sent: the email service was busy. Send it again in a few minutes.'
  }
  if (status === 401 || status === 403) {
    return 'Not sent: email isn’t set up correctly for this business. Ask the business owner.'
  }
  if (status >= 500) {
    return 'Not sent: the email service didn’t take it. Send it again in a few minutes.'
  }
  return 'Not sent: the email service refused it, usually for an address it can’t deliver to. Check the addresses, then send it again.'
}
