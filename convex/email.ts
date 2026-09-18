'use node'

import { ConvexError, v } from 'convex/values'
import { action, internalAction } from './_generated/server'
import { api, internal } from './_generated/api'
import { renderIfNeeded } from './reportPipeline'
import { reportEmailHtml } from './lib/reportEmail'
import type { ActionCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'

/**
 * Sending a finished report to the people it is for.
 *
 * A plain `fetch` to Resend's REST API rather than their SDK — the payload is
 * one JSON body with a base64 attachment, and `fetch` already works in every
 * Convex runtime, so a dependency buys nothing. `"use node"` is for `Buffer`,
 * used to base64-encode the PDF.
 *
 * Requires `RESEND_API_KEY` (and optionally `RESEND_FROM_EMAIL` — Resend only
 * sends from a domain verified on the account, so a customer's own business
 * email cannot be the `from` address; it goes in `reply-to` instead). Until
 * one exists this fails with `EMAIL_NOT_CONFIGURED` rather than silently doing
 * nothing.
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

    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      // Not a failure of this delivery — nothing was attempted, and marking
      // it failed would put a red row in a history that records real sends.
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
          to: delivery.to,
          ...(delivery.cc.length > 0 ? { cc: delivery.cc } : {}),
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

      const pdfId = await ctx.runQuery(internal.deliveries.currentPdfId, { reportId })

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500)
        await ctx.runMutation(internal.deliveries.settle, {
          deliveryId,
          status: 'failed',
          error: detail,
          ...(pdfId ? { pdfId } : {}),
        })
        await audit(ctx, businessId, reportId, delivery.sentByMembershipId, {
          action: 'report.email.failed',
          meta: { to: delivery.to, detail },
        })
        return { ok: false, reason: 'provider' }
      }

      const body = (await response.json()) as { id?: string }
      await ctx.runMutation(internal.deliveries.settle, {
        deliveryId,
        status: 'sent',
        ...(pdfId ? { pdfId } : {}),
        ...(body.id ? { providerMessageId: body.id } : {}),
      })
      await audit(ctx, businessId, reportId, delivery.sentByMembershipId, {
        action: 'report.email.sent',
        meta: { to: delivery.to, subject: delivery.subject },
      })
      return { ok: true }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await ctx.runMutation(internal.deliveries.settle, {
        deliveryId,
        status: 'failed',
        error: detail,
      })
      throw error
    }
  },
})

/**
 * Sends a finished report to one address, on someone's say-so.
 *
 * Keeps its argument shape: the report action bar and the e2e suite both call
 * it this way. What changed is underneath — the send is a delivery row, and a
 * recipient nobody has on file waits for an owner.
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
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
      throw new ConvexError('EMAIL_NOT_CONFIGURED')
    }

    const { deliveryId, status } = await ctx.runMutation(api.deliveries.request, {
      businessId,
      reportId,
      to: [to],
    })

    if (status === 'pendingApproval') {
      // The request is recorded and an owner can let it go; the person who
      // asked needs to know it has not been sent.
      throw new ConvexError('RECIPIENT_NEEDS_APPROVAL')
    }

    // Run it here rather than scheduling it: whoever pressed Send is watching,
    // and "it went" or "it did not" is the answer they asked for.
    const result = await ctx.runAction(internal.email.deliver, { deliveryId })
    if (!result.ok) throw new ConvexError('EMAIL_SEND_FAILED')
    return { ok: true, deliveryId }
  },
})

/** Resend's own ceiling is 40 MB for the whole message; this is the safe half. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

async function audit(
  ctx: ActionCtx,
  businessId: Id<'businesses'>,
  reportId: Id<'reports'>,
  actorMembershipId: Id<'memberships'> | undefined,
  entry: { action: string; meta: unknown },
) {
  // Every delivery written now names who asked for it (see the schema). A
  // row without one has nobody to attribute the outcome to, and the delivery
  // row is its record — an audit line attributed to nobody would be worse.
  if (!actorMembershipId) return
  await ctx.runMutation(internal.auditLog.log, {
    businessId,
    actorMembershipId,
    action: entry.action,
    entityType: 'reports',
    entityId: reportId,
    meta: entry.meta,
  })
}
