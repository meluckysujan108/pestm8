/**
 * What every email PestM8 sends looks like, in light and in dark: the
 * palette, and the one `<style>` block that turns an email dark in the mail
 * apps that let it.
 *
 * Every colour is also written inline, in light, on the element itself: that
 * is what the email looks like everywhere, and all some mail apps ever read.
 * The block below only ever overrides it, so a mail app that drops the block
 * (or the whole `<head>`) still shows a complete light email.
 *
 * Mail apps darken an email in one of three ways, and this is written for all
 * of them:
 *
 * - **Following the email's own dark styling.** Apple Mail on the iPhone and
 *   the Mac, Outlook for Mac and phones: they read `prefers-color-scheme`
 *   below. Outlook.com marks each element whose background it recolours with
 *   `data-ogsb` — the card always, since its white is written on it — which
 *   the second block reads.
 * - **Inverting its colours.** The Gmail app and Outlook for Windows ignore
 *   the styling and invert whatever colours they find, but never an image —
 *   which is why a logo travels on its own white card (lib/businessLogo.ts).
 * - **Never darkening it.** Gmail on the web, Yahoo: light, as written.
 *
 * The dark values mirror the app's dark tokens (src/styles.css), as the PDF's
 * palette mirrors its light ones (pdf/theme.ts).
 */

export const EMAIL_COLOURS = {
  page: '#F2F2F7',
  card: '#FFFFFF',
  ink: '#1C1C1E',
  muted: '#6B6B70',
  hairline: '#E5E5EA',
  red: '#FF3B30',
} as const

const DARK = {
  page: '#000000',
  card: '#1C1C1E',
  ink: '#FFFFFF',
  muted: '#98989F',
  hairline: '#38383A',
  red: '#FF453A',
} as const

export const EMAIL_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

/**
 * The classes an element takes to be recoloured in dark: `pm-page` the
 * canvas, `pm-card` the card, `pm-ink` and `pm-muted` text, `pm-rule` a
 * hairline, `pm-accent` the red rule. `pm-on-light` is shown only in light
 * and `pm-on-dark` only in dark — a logo and its light-lettered version.
 */
export function emailHead({
  swapsLogo,
}: {
  /** Whether there is a `pm-on-dark` logo to swap in. */
  swapsLogo: boolean
}): string {
  const swap = swapsLogo
    ? `
        .pm-on-light { display: none !important; }
        .pm-on-dark { display: block !important; }`
    : ''
  const outlookSwap = swapsLogo
    ? `
    <style>
      [data-ogsb] .pm-on-light { display: none !important; }
      [data-ogsb] .pm-on-dark { display: block !important; }
    </style>`
    : ''
  return `
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <style>
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
      @media (prefers-color-scheme: dark) {
        .pm-page { background: ${DARK.page} !important; }
        .pm-card { background: ${DARK.card} !important; border-color: ${DARK.hairline} !important; }
        .pm-ink { color: ${DARK.ink} !important; }
        .pm-muted { color: ${DARK.muted} !important; }
        .pm-rule { border-color: ${DARK.hairline} !important; }
        .pm-accent { background: ${DARK.red} !important; }${swap}
      }
    </style>${outlookSwap}`
}

/**
 * The page and its card, around the card's rows (`<tr>…</tr>`).
 *
 * `max-width` keeps the card to 520px everywhere but Outlook for Windows,
 * which ignores it and would stretch the card across the reading pane: it
 * alone reads the table in the conditional comment. `preheader` is what an
 * inbox shows beside the subject, hidden from the email itself.
 */
export function emailBody({
  preheader,
  rows,
}: {
  preheader?: string
  rows: string
}): string {
  const C = EMAIL_COLOURS
  const hidden = preheader
    ? `
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${escapeHtml(preheader)}</div>`
    : ''
  return `
  <body class="pm-page" style="margin:0;padding:0;background:${C.page};">${hidden}
    <table role="presentation" class="pm-page" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <!--[if mso]><table role="presentation" width="520" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
          <table role="presentation" class="pm-card" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;margin:0 auto;background:${C.card};border-radius:16px;border:1px solid ${C.hairline};font-family:${EMAIL_FONT};">${rows}
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>`
}

/**
 * The short red rule above a heading, as a table cell: Outlook for Windows
 * gives a `<div>` no width of its own and paints its background across the
 * page.
 */
export function accentRule(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td class="pm-accent" width="44" height="3" style="width:44px;height:3px;background:${EMAIL_COLOURS.red};font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td></tr></table>`
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
