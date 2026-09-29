/**
 * The emails PestM8 sends about someone's own account, as the subject, an
 * HTML body and a plain-text one (a text part keeps them out of spam folders,
 * and is what a watch or a screen reader shows).
 *
 * Styled like the report email (lib/reportEmail.ts): a table, inline styles,
 * nothing clever. From `noreply@`, so each one says replies aren't read. And
 * like the report email, none asks anyone to write in: until 29 Sept 2026
 * they ended "Need help? Email info@pestm8.com.au". Each says what to do
 * next itself.
 */

const INK = '#1C1C1E'
const MUTED = '#6B6B70'
const RED = '#FF3B30'
const HAIRLINE = '#E5E5EA'

const FOOTER = 'This email was sent by PestM8 and replies to it aren’t read.'

/** How long a reset link works, in seconds (Better Auth's
 * `resetPasswordTokenExpiresIn`), and as the email says it. */
export const RESET_LINK_SECONDS = 60 * 60
const RESET_LINK_WORDS = '1 hour'

export type AccountEmail = { subject: string; html: string; text: string }

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** "Hi Jo," from a name, or "Hi," without one. */
function greeting(name: string | undefined): string {
  const first = name?.trim().split(/\s+/)[0]
  return first ? `Hi ${first},` : 'Hi,'
}

function layout({
  heading,
  paragraphs,
  button,
}: {
  heading: string
  paragraphs: Array<string>
  button?: { label: string; url: string }
}): string {
  const body = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 12px 0;color:${INK};font-size:15px;line-height:1.5;">${p}</p>`,
    )
    .join('')
  const action = button
    ? `<p style="margin:8px 0 20px 0;"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:${RED};color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:12px;">${escapeHtml(button.label)}</a></p>
       <p style="margin:0 0 12px 0;color:${MUTED};font-size:13px;line-height:1.5;word-break:break-all;">Or copy this link into your browser:<br>${escapeHtml(button.url)}</p>`
    : ''
  return `<!doctype html>
<html lang="en-AU">
  <body style="margin:0;padding:24px;background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:16px;border:1px solid ${HAIRLINE};">
      <tr>
        <td style="padding:24px;">
          <div style="height:3px;width:44px;background:${RED};margin-bottom:16px;"></div>
          <h1 style="margin:0 0 16px 0;font-size:20px;line-height:1.3;color:${INK};font-weight:600;">${escapeHtml(heading)}</h1>
          ${body}
          ${action}
          <p style="margin:16px 0 0 0;padding-top:16px;border-top:1px solid ${HAIRLINE};color:${MUTED};font-size:13px;line-height:1.5;">
            ${escapeHtml(FOOTER)}
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

export function passwordResetEmail({
  name,
  url,
}: {
  name?: string
  url: string
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
    }),
    text: [hi, '', lines[0], '', url, '', lines[1], lines[2], '', FOOTER].join(
      '\n',
    ),
  }
}

export function passwordChangedEmail({
  name,
  signInUrl,
}: {
  name?: string
  signInUrl: string
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
    }),
    text: [hi, '', lines[0], '', signInUrl, '', lines[1], '', FOOTER].join(
      '\n',
    ),
  }
}
