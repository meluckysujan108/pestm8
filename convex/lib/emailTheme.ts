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
 *   below. Outlook.com marks what it recolours with `data-ogsc`, which the
 *   second block reads.
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
      [data-ogsc] .pm-on-light { display: none !important; }
      [data-ogsc] .pm-on-dark { display: block !important; }
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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
