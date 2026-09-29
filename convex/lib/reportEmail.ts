import type { Doc } from '../_generated/dataModel'

/**
 * The email a client opens.
 *
 * Hand-written inline-styled HTML, not a template library: every mail client
 * that matters strips `<style>` blocks, ignores flexbox and disagrees about
 * margins, so the reliable subset is a table, inline styles and nothing
 * clever. A dependency would add a build step to produce the same string.
 *
 * It says what the attachment is, where it is for, and the two or three facts
 * a client actually wants — when the visit was, who did it, when the next one
 * is due — so nobody has to open a PDF on a phone to learn a date.
 */

export type EmailFact = { label: string; value: string }

const INK = '#1C1C1E'
const MUTED = '#6B6B70'
const RED = '#FF3B30'
const HAIRLINE = '#E5E5EA'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function reportEmailHtml({
  businessName,
  formName,
  address,
  facts,
  logoUrl,
}: {
  businessName: string
  formName: string
  address?: string
  facts: Array<EmailFact>
  logoUrl?: string
}): string {
  const rows = facts
    .map(
      (fact) => `
        <tr>
          <td style="padding:6px 0;color:${MUTED};font-size:14px;">${escapeHtml(fact.label)}</td>
          <td style="padding:6px 0;color:${INK};font-size:14px;text-align:right;">${escapeHtml(fact.value)}</td>
        </tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en-AU">
  <body style="margin:0;padding:24px;background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:16px;border:1px solid ${HAIRLINE};">
      <tr>
        <td style="padding:24px 24px 0 24px;">
          ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" style="height:32px;display:block;margin-bottom:16px;" />` : ''}
          <div style="height:3px;width:44px;background:${RED};margin-bottom:16px;"></div>
          <h1 style="margin:0;font-size:20px;line-height:1.3;color:${INK};font-weight:600;">
            Your ${escapeHtml(formName)}${address ? ` for ${escapeHtml(address)}` : ''}
          </h1>
        </td>
      </tr>
      ${
        rows
          ? `<tr><td style="padding:16px 24px 0 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>
      </td></tr>`
          : ''
      }
      <tr>
        <td style="padding:16px 24px 24px 24px;color:${MUTED};font-size:14px;line-height:1.5;">
          The full report is attached as a PDF. Reply to this email if anything
          in it needs checking.
          <div style="margin-top:16px;color:${INK};font-size:14px;">${escapeHtml(businessName)}</div>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

/**
 * Who one delivery goes to, as Resend's API spells it.
 *
 * The business's own copy is `bcc`, so the client never sees another address
 * on their email and a Reply All never reaches it. A row written before blind
 * copies (29 Sept 2026) carries that copy in `cc` instead, and is sent as it
 * was recorded: a delivery row is the record of what was asked for.
 */
export function deliveryAddressing(delivery: {
  to: Array<string>
  cc: Array<string>
  bcc?: Array<string>
}): { to: Array<string>; cc?: Array<string>; bcc?: Array<string> } {
  return {
    to: delivery.to,
    ...(delivery.cc.length > 0 ? { cc: delivery.cc } : {}),
    ...(delivery.bcc && delivery.bcc.length > 0 ? { bcc: delivery.bcc } : {}),
  }
}

/**
 * Everyone an email went to, as the report's Logs show it: who it was for,
 * the business's blind copy, and which of them were new to this client. Only
 * what the row has — a row from before 29 Sept 2026 has no `bcc`, and one from
 * before this change shipped (29 Sept 2026) no `newAddresses`.
 */
export function addressedTo(
  delivery: Pick<
    Doc<'reportDeliveries'>,
    'to' | 'cc' | 'bcc' | 'trigger' | 'newAddresses'
  >,
) {
  return {
    to: delivery.to,
    ...(delivery.cc.length > 0 ? { cc: delivery.cc } : {}),
    ...(delivery.bcc && delivery.bcc.length > 0 ? { bcc: delivery.bcc } : {}),
    ...(delivery.newAddresses && delivery.newAddresses.length > 0
      ? { newAddresses: delivery.newAddresses }
      : {}),
    trigger: delivery.trigger,
  }
}
