import { describe, expect, test } from 'vitest'
import { reportEmailHtml, reportEmailText } from './reportEmail'
import type { EmailLogo } from './reportEmail'

/**
 * The email a client opens says what is attached and who it is from, and
 * stops there. Until 29 Sept 2026 it ended "Reply to this email if anything
 * in it needs checking" — an invitation to write back, and every reply is
 * one the business has to answer.
 */

const content = {
  businessName: 'Pest M8 Pest Control',
  formName: 'Service Report',
  address: '27 Gemstone Parade, Wellard',
  facts: [
    { label: 'Treatment', value: 'General Pest Control' },
    { label: 'Your Next Pest Control Visit is due in', value: '6-12 Months' },
  ],
}

/** The logo on its card, as `setLogo` stores it, and its light-lettered copy. */
const CARD: EmailLogo = {
  url: 'https://rare-retriever-156.convex.cloud/api/storage/card?a=1&b=2',
  width: 220,
  height: 72,
  carded: true,
}
const ON_DARK: EmailLogo = {
  url: 'https://rare-retriever-156.convex.cloud/api/storage/dark',
  width: 220,
  height: 72,
  carded: true,
}

const html = reportEmailHtml(content)
const lettered = reportEmailHtml({
  ...content,
  logo: CARD,
  logoOnDark: ON_DARK,
})
const text = reportEmailText(content)

/** What only the mail apps that follow the email's own dark styling read. */
function darkRules(page: string): string {
  const start = page.indexOf('@media (prefers-color-scheme: dark)')
  expect(start).toBeGreaterThan(-1)
  return page.slice(start, page.indexOf('</style>', start))
}

describe('the report email', () => {
  test('says the report is attached, and who it is from', () => {
    for (const page of [html, lettered]) {
      expect(page).toContain(
        'Your Service Report for 27 Gemstone Parade, Wellard',
      )
      expect(page).toContain('The full report is attached as a PDF.')
      expect(page).toContain('Pest M8 Pest Control')
    }
  })

  test('never asks the client to reply or get in touch', () => {
    for (const page of [html, lettered, text]) {
      expect(page).not.toMatch(
        /reply|needs checking|get in touch|contact us|let us know|questions/i,
      )
    }
  })
})

describe('its letterhead', () => {
  test('is the logo on its card, sized for Outlook for Windows too', () => {
    const light = reportEmailHtml({ ...content, logo: CARD })
    // Width and height as attributes, which is all Outlook for Windows
    // reads, and the business's name as the words a blocked image shows.
    expect(light).toContain(
      '<img class="pm-ink" src="https://rare-retriever-156.convex.cloud/api/storage/card?a=1&amp;b=2" width="220" height="72" alt="Pest M8 Pest Control" style="display:block;',
    )
  })

  test('with no logo, is the business’s name, in words that darken', () => {
    expect(html).not.toContain('<img')
    expect(html).toContain(
      '<div class="pm-ink" style="font-size:17px;line-height:1.3;font-weight:600;color:#1C1C1E;">Pest M8 Pest Control</div>',
    )
  })

  test('swaps to the light-lettered logo in dark mode, and Outlook for Windows never sees it', () => {
    // The card shows until dark styling hides it…
    expect(lettered).toContain('<img class="pm-ink pm-on-light" src=')
    // …and the other is hidden until the same styling shows it, behind a
    // comment Outlook for Windows reads as "skip this".
    expect(lettered).toMatch(
      /<!--\[if !mso\]><!--><img class="pm-ink pm-on-dark" src="https:\/\/rare-retriever-156\.convex\.cloud\/api\/storage\/dark" width="220" height="72" alt="" style="display:none;mso-hide:all;/,
    )
    expect(lettered).toContain('<!--<![endif]-->')
    const dark = darkRules(lettered)
    expect(dark).toContain('.pm-on-light { display: none !important; }')
    expect(dark).toContain('.pm-on-dark { display: block !important; }')
    // Outlook.com marks what it recolours instead.
    expect(lettered).toContain(
      '[data-ogsc] .pm-on-dark { display: block !important; }',
    )
  })

  test('without a light-lettered logo, the card stays in dark mode and nothing swaps', () => {
    const light = reportEmailHtml({ ...content, logo: CARD })
    expect(light).not.toContain('pm-on-dark')
    expect(light).not.toContain('pm-on-light')
    expect(light).not.toContain('data-ogsc')
  })

  test('a logo stored before cards existed is given the card’s margin', () => {
    const old = reportEmailHtml({
      ...content,
      logo: { ...CARD, url: 'https://x.test/logo.jpg', carded: false },
    })
    expect(old).toContain(
      '<div style="display:block;padding:10px;"><img class="pm-ink" src="https://x.test/logo.jpg"',
    )
  })
})

describe('in dark mode', () => {
  test('it says it has a dark version, and only the dark styling changes a colour', () => {
    for (const page of [html, lettered]) {
      expect(page).toContain(
        '<meta name="color-scheme" content="light dark" />',
      )
      // Light, written on the element itself: what every mail app shows
      // until something darkens it.
      expect(page).toContain('background:#FFFFFF;border-radius:16px')
      const dark = darkRules(page)
      expect(dark).toContain(
        '.pm-card { background: #1C1C1E !important; border-color: #38383A !important; }',
      )
      expect(dark).toContain('.pm-ink { color: #FFFFFF !important; }')
    }
  })
})

describe('the plain-text copy beside it', () => {
  test('carries the same words', () => {
    expect(text).toBe(
      [
        'Your Service Report for 27 Gemstone Parade, Wellard',
        '',
        'Treatment: General Pest Control',
        'Your Next Pest Control Visit is due in: 6-12 Months',
        '',
        'The full report is attached as a PDF.',
        '',
        'Pest M8 Pest Control',
      ].join('\n'),
    )
  })
})
