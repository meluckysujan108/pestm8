import { EMAIL_COLOURS, EMAIL_FONT, emailHead, escapeHtml } from './emailTheme'

/**
 * The emails PestM8 sends about someone's own account, as the subject, an
 * HTML body and a plain-text one (a text part keeps them out of spam folders,
 * and is what a watch or a screen reader shows).
 *
 * Styled like the report email (lib/reportEmail.ts): a table, inline styles,
 * nothing clever, dark where the mail app allows it (lib/emailTheme.ts). From
 * `noreply@`, so each one says replies aren't read. And like the report
 * email, none asks anyone to write in: until 29 Sept 2026 they ended "Need
 * help? Email info@pestm8.com.au". Each says what to do next itself.
 *
 * Headed with PestM8's own mark, not a business's logo: the app sends these,
 * and one login can belong to more than one business.
 */

/**
 * The app's icon (public/, drawn by `pnpm icons`), which heads these emails:
 * the ant on its own dark square, so it reads the same in light and in dark
 * and needs no card. Served from the app's own address (`SITE_URL`).
 */
export const APP_MARK_PATH = '/icon-192.png'

const C = EMAIL_COLOURS

const FOOTER = 'This email was sent by PestM8 and replies to it aren’t read.'

/** How long a reset link works, in seconds (Better Auth's
 * `resetPasswordTokenExpiresIn`), and as the email says it. */
export const RESET_LINK_SECONDS = 60 * 60
const RESET_LINK_WORDS = '1 hour'

export type AccountEmail = { subject: string; html: string; text: string }

/** "Hi Jo," from a name, or "Hi," without one. */
function greeting(name: string | undefined): string {
  const first = name?.trim().split(/\s+/)[0]
  return first ? `Hi ${first},` : 'Hi,'
}

function layout({
  heading,
  paragraphs,
  button,
  markUrl,
}: {
  heading: string
  paragraphs: Array<string>
  button?: { label: string; url: string }
  /** The app's mark, as an absolute address; left out without one. */
  markUrl?: string
}): string {
  const body = paragraphs
    .map(
      (p) =>
        `<p class="pm-ink" style="margin:0 0 12px 0;color:${C.ink};font-size:15px;line-height:1.5;">${p}</p>`,
    )
    .join('')
  const action = button
    ? `<p style="margin:8px 0 20px 0;"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:${C.red};color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:12px;">${escapeHtml(button.label)}</a></p>
       <p class="pm-muted" style="margin:0 0 12px 0;color:${C.muted};font-size:13px;line-height:1.5;word-break:break-all;">Or copy this link into your browser:<br>${escapeHtml(button.url)}</p>`
    : ''
  const mark = markUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
                  <tr>
                    <td style="padding:0 10px 0 0;vertical-align:middle;"><img src="${escapeHtml(markUrl)}" width="36" height="36" alt="" style="display:block;border:0;outline:none;width:36px;height:36px;border-radius:8px;" /></td>
                    <td class="pm-ink" style="vertical-align:middle;color:${C.ink};font-size:17px;font-weight:600;">PestM8</td>
                  </tr>
                </table>`
    : ''
  return `<!doctype html>
<html lang="en-AU">
  <head>${emailHead({ swapsLogo: false })}
    <title>${escapeHtml(heading)}</title>
  </head>
  <body class="pm-page" style="margin:0;padding:0;background:${C.page};">
    <table role="presentation" class="pm-page" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};">
      <tr>
        <td style="padding:24px 12px;">
          <table role="presentation" class="pm-card" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;margin:0 auto;background:${C.card};border-radius:16px;border:1px solid ${C.hairline};font-family:${EMAIL_FONT};">
            <tr>
              <td style="padding:24px;">
                ${mark}
                <div class="pm-accent" style="height:3px;width:44px;background:${C.red};margin-bottom:16px;"></div>
                <h1 class="pm-ink" style="margin:0 0 16px 0;font-size:20px;line-height:1.3;color:${C.ink};font-weight:600;">${escapeHtml(heading)}</h1>
                ${body}
                ${action}
                <p class="pm-muted pm-rule" style="margin:16px 0 0 0;padding-top:16px;border-top:1px solid ${C.hairline};color:${C.muted};font-size:13px;line-height:1.5;">
                  ${escapeHtml(FOOTER)}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

export function passwordResetEmail({
  name,
  url,
  markUrl,
}: {
  name?: string
  url: string
  markUrl?: string
}): AccountEmail {
  const hi = greeting(name)
  const lines = [
    'Someone asked to reset the password for your PestM8 account. If it was you, choose a new password with the link below.',
    `The link works once, for ${RESET_LINK_WORDS}.`,
    'If you didn’t ask, you can ignore this email — your password stays as it is.',
  ]
  return {
    subject: 'Reset your PestM8 password',
    html: layout({
      heading: 'Reset your password',
      paragraphs: [escapeHtml(hi), ...lines.map(escapeHtml)],
      button: { label: 'Choose a new password', url },
      markUrl,
    }),
    text: [hi, '', lines[0], '', url, '', lines[1], lines[2], '', FOOTER].join(
      '\n',
    ),
  }
}

export function passwordChangedEmail({
  name,
  signInUrl,
  markUrl,
}: {
  name?: string
  signInUrl: string
  markUrl?: string
}): AccountEmail {
  const hi = greeting(name)
  const lines = [
    'The password for your PestM8 account has just been changed, and every device was signed out. Sign in again with the new password.',
    // What to do, not who to write to: a new password signs every device
    // out again, whoever was on them.
    'If you didn’t change it, choose a new password straight away with “Forgot password?” on the sign-in page.',
  ]
  return {
    subject: 'Your PestM8 password was changed',
    html: layout({
      heading: 'Your password was changed',
      paragraphs: [escapeHtml(hi), ...lines.map(escapeHtml)],
      button: { label: 'Sign in', url: signInUrl },
      markUrl,
    }),
    text: [hi, '', lines[0], '', signInUrl, '', lines[1], '', FOOTER].join(
      '\n',
    ),
  }
}
