'use node'

import { ConvexError, v } from 'convex/values'
import { action } from './_generated/server'
import { api, internal } from './_generated/api'

/**
 * A plain `fetch` to Resend's REST API rather than their SDK — the payload
 * is one JSON body with a base64 attachment, and `fetch` already works in
 * every Convex runtime, so a dependency buys nothing here. `"use node"` is
 * for `Buffer`, used to base64-encode the PDF.
 *
 * Requires `RESEND_API_KEY` (and optionally `RESEND_FROM_EMAIL` — Resend
 * only sends from a domain verified on the account, so a customer's own
 * business email can't be the `from` address; it goes in `reply-to`
 * instead) set via `npx convex env set`. Until then this throws
 * `EMAIL_NOT_CONFIGURED` rather than silently doing nothing.
 */
export const sendReportPdf = action({
  args: {
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    to: v.string(),
  },
  handler: async (ctx, { businessId, reportId, to }) => {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) throw new ConvexError('EMAIL_NOT_CONFIGURED')

    const report = await ctx.runQuery(api.reports.get, { businessId, reportId })
    if (!report) throw new ConvexError('NOT_FOUND')
    if (report.status !== 'finalised') {
      throw new ConvexError('REPORT_NOT_FINALISED')
    }

    const pdfUrl =
      report.pdfUrl ??
      (
        await ctx.runAction(api.reportPdf.generate, { businessId, reportId })
      ).url
    if (!pdfUrl) throw new ConvexError('PDF_UNAVAILABLE')

    const { resolveReportTemplate } = await import('../src/lib/reportTemplates/resolve')
    const template = resolveReportTemplate({
      template: report.template,
      customTemplate: report.customTemplate,
    })

    const pdfRes = await fetch(pdfUrl)
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer())

    const fromEmail = process.env.RESEND_FROM_EMAIL
    const subject = `${template.name} — ${report.property?.addressLine ?? report.businessName}`

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail ? `${report.businessName} <${fromEmail}>` : report.businessName,
        to: [to],
        reply_to: report.business?.email || undefined,
        subject,
        html: `<p>Please find attached your ${template.name.toLowerCase()} from ${report.businessName}.</p>`,
        attachments: [
          {
            filename: `${template.shortName.toLowerCase()}.pdf`,
            content: pdfBuffer.toString('base64'),
          },
        ],
      }),
    })

    const ok = emailRes.ok
    const detail = ok ? undefined : (await emailRes.text()).slice(0, 500)

    await ctx.runMutation(internal.auditLog.log, {
      businessId,
      actorMembershipId: report.callerMembershipId,
      action: ok ? 'report.email.sent' : 'report.email.failed',
      entityType: 'reports',
      entityId: reportId,
      meta: { to, subject, detail },
    })
    if (ok) {
      await ctx.runMutation(internal.reports.markEmailed, { reportId })
    }

    if (!ok) throw new ConvexError('EMAIL_SEND_FAILED')
    return { ok: true }
  },
})
