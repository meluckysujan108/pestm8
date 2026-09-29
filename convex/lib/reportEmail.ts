import { EMAIL_LOGO } from './businessLogo'
import {
  EMAIL_COLOURS,
  EMAIL_FONT,
  accentRule,
  emailBody,
  emailHead,
  escapeHtml,
} from './emailTheme'
import type { Doc } from '../_generated/dataModel'

/**
 * The email a client opens.
 *
 * Hand-written inline-styled HTML, not a template library: mail clients
 * ignore flexbox, disagree about margins and drop what they don't know, so
 * the reliable subset is a table, inline styles and nothing clever. The one
 * `<style>` block (lib/emailTheme.ts) only ever turns it dark; without it the
 * email is complete. A dependency would add a build step to produce the same
 * string.
 *
 * It opens on the business's letterhead — its logo, or its name — then says
 * what the attachment is, where it is for, and the two or three facts a client
 * actually wants — when the visit was, who did it, when the next one is due —
 * so nobody has to open a PDF on a phone to learn a date.
 *
 * And it stops there. It never asks for a reply: until 29 Sept 2026 it said
 * "Reply to this email if anything in it needs checking", and every question
 * that invites is one the business then has to answer.
 */

export type EmailFact = { label: string; value: string }

/** A logo as the email draws it (convex/lib/businessLogo.ts). */
export type EmailLogo = {
  url: string
  /** The size the email gives it, in CSS pixels — as attributes too, since
   * Outlook for Windows reads nothing else. */
  width: number
  height: number
  /**
   * Drawn with the card's margin already round it: the card, or the
   * light-lettered copy on the card's geometry. A logo stored before cards
   * existed is not, and is given the margin here.
   */
  carded: boolean
}

const C = EMAIL_COLOURS

export function reportEmailHtml({
  businessName,
  formName,
  address,
  facts,
  logo,
  logoOnDark,
}: {
  businessName: string
  formName: string
  address?: string
  facts: Array<EmailFact>
  /** The letterhead's logo on its card; without one the business's name heads the email. */
  logo?: EmailLogo
  /** Its light-lettered version, swapped in by dark mode where a mail app allows it. */
  logoOnDark?: EmailLogo
}): string {
  const title = emailTitle(formName, address)
  // Long values (an email address, a product's full name) wrap rather than
  // push the card wider than a phone.
  const wrap = 'word-break:break-word;overflow-wrap:anywhere;'
  const facts_ = facts
    .map(
      (fact) => `
                  <tr>
                    <td class="pm-muted pm-rule" style="padding:8px 12px 8px 0;border-top:1px solid ${C.hairline};color:${C.muted};font-size:14px;line-height:1.4;${wrap}">${escapeHtml(fact.label)}</td>
                    <td class="pm-ink pm-rule" style="padding:8px 0;border-top:1px solid ${C.hairline};color:${C.ink};font-size:14px;line-height:1.4;text-align:right;${wrap}">${escapeHtml(fact.value)}</td>
                  </tr>`,
    )
    .join('')

  const rows = `
            <tr>
              <td style="padding:${logo ? `${24 - EMAIL_LOGO.padding}px ${24 - EMAIL_LOGO.padding}px 0` : '24px 24px 0'};">
                ${letterhead(businessName, logo, logoOnDark)}
              </td>
            </tr>
            <tr>
              <td style="padding:${logo ? 14 : 16}px 24px 0 24px;">
                ${accentRule()}
                <h1 class="pm-ink" style="margin:16px 0 0 0;font-size:20px;line-height:1.3;color:${C.ink};font-weight:600;${wrap}">${escapeHtml(title)}</h1>
              </td>
            </tr>${
              facts_
                ? `
            <tr>
              <td style="padding:16px 24px 0 24px;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${facts_}
                </table>
              </td>
            </tr>`
                : ''
            }
            <tr>
              <td class="pm-muted" style="padding:16px 24px 24px 24px;color:${C.muted};font-size:14px;line-height:1.5;">
                The full report is attached as a PDF.
                <div class="pm-ink" style="margin-top:16px;color:${C.ink};font-size:14px;">${escapeHtml(businessName)}</div>
              </td>
            </tr>`

  return `<!doctype html>
<html lang="en-AU">
  <head>${emailHead({ swapsLogo: Boolean(logo && logoOnDark) })}
    <title>${escapeHtml(title)}</title>
  </head>${emailBody({ preheader: `${title}. The full report is attached as a PDF.`, rows })}
</html>`
}

/**
 * The same email as plain text, which travels beside the HTML: spam filters
 * trust a message that has both, and it is what a watch or a screen reader
 * shows.
 */
export function reportEmailText({
  businessName,
  formName,
  address,
  facts,
}: {
  businessName: string
  formName: string
  address?: string
  facts: Array<EmailFact>
}): string {
  return [
    emailTitle(formName, address),
    '',
    // "Is it safe to commence work?: Yes" reads badly; a label that ends in
    // its own punctuation keeps it.
    ...facts.map(
      (fact) =>
        `${fact.label}${/[?:]$/.test(fact.label.trim()) ? '' : ':'} ${fact.value}`,
    ),
    ...(facts.length > 0 ? [''] : []),
    'The full report is attached as a PDF.',
    '',
    businessName,
  ].join('\n')
}

function emailTitle(formName: string, address: string | undefined) {
  return `Your ${formName}${address ? ` for ${address}` : ''}`
}

/**
 * The top of the email: the logo on its card, with its light-lettered version
 * behind it for dark mode — or, with no logo, the business's name in words
 * that darken with the rest.
 *
 * The dark version is hidden until the dark styling swaps it in, and Outlook
 * for Windows, which reads neither the styling nor `display:none` reliably,
 * never sees it at all (the conditional comment and `mso-hide`). Both carry
 * the business's name, for a reader whose mail app blocks images; only one is
 * ever shown, so it is never read twice.
 */
function letterhead(
  businessName: string,
  logo: EmailLogo | undefined,
  logoOnDark: EmailLogo | undefined,
): string {
  if (!logo) {
    return `<div class="pm-ink" style="font-size:17px;line-height:1.3;font-weight:600;color:${C.ink};">${escapeHtml(businessName)}</div>`
  }
  const light = framed(logo, businessName, logoOnDark ? 'pm-on-light' : '')
  if (!logoOnDark) return light
  const dark = framed(logoOnDark, businessName, 'pm-on-dark', true)
  return `${light}
                <!--[if !mso]><!-->${dark}<!--<![endif]-->`
}

/**
 * One logo, and the class that swaps it (on its outermost element).
 *
 * A card comes with its margin drawn in. A logo stored before cards existed
 * is put on a white box here instead: without one, a see-through logo's dark
 * lettering would sit on the card after dark mode darkens it. The box has no
 * `pm-` class, so it stays white while the rest goes dark — and the logo's
 * words, for a blocked image, stay dark on it.
 */
function framed(
  logo: EmailLogo,
  alt: string,
  swap: string,
  hidden = false,
): string {
  const image = (className: string, display: string) =>
    `<img${className ? ` class="${className}"` : ''} src="${escapeHtml(logo.url)}" width="${logo.width}" height="${logo.height}" alt="${escapeHtml(alt)}" style="${display}border:0;outline:none;text-decoration:none;width:${logo.width}px;height:${logo.height}px;font-family:${EMAIL_FONT};font-size:17px;font-weight:600;color:${C.ink};" />`
  const display = hidden ? 'display:none;mso-hide:all;' : 'display:block;'
  if (logo.carded) {
    return image(['pm-ink', swap].filter(Boolean).join(' '), display)
  }
  return `<table role="presentation"${swap ? ` class="${swap}"` : ''} cellpadding="0" cellspacing="0" style="${hidden ? display : ''}background:#FFFFFF;border-radius:${EMAIL_LOGO.radius}px;"><tr><td style="padding:${EMAIL_LOGO.padding}px;">${image('', 'display:block;')}</td></tr></table>`
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
