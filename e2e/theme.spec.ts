import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { createReport, finaliseReport } from './fixtures/reportPayloads'
import type { Page } from '@playwright/test'

/**
 * The appearance toggle, and the three things about it that are easy to get
 * wrong and invisible when you do: the theme has to be on <html> before the
 * first paint, an explicit choice has to beat the OS, and the report preview
 * has to stay on white paper so the screen goes on matching the PDF.
 */

const COOKIE = 'pm8_theme'

async function setup(label: string) {
  const email = uniqueEmail(label)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  return { email, owner, slug }
}

function themeState(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement
    return {
      theme: root.dataset.theme,
      pref: root.dataset.themePref,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      colorScheme: getComputedStyle(root).colorScheme,
    }
  })
}

/** Opens the header account menu and returns its Appearance radios. */
async function openAppearance(page: Page) {
  // The trigger is disabled until hydrated (src/lib/useHydrated.ts), so this
  // click waits for readiness rather than landing on an inert button — which is
  // what it did under parallel load before the trigger honoured that rule.
  const trigger = page.getByRole('button', { name: 'Account menu' })
  await expect(trigger).toBeEnabled()
  await trigger.click()

  const group = page.getByRole('radiogroup', { name: 'Appearance' })
  await expect(group).toBeVisible()
  return group
}

test('defaults to following the OS, and renders light under a light OS', async ({
  page,
}) => {
  const s = await setup('theme-default')
  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()

  expect(await themeState(page)).toMatchObject({
    theme: 'light',
    pref: 'system',
    colorScheme: 'light',
  })

  const group = await openAppearance(page)
  await expect(group.getByRole('radio', { name: 'System' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
})

test('choosing Dark repaints immediately and survives a reload', async ({
  page,
}) => {
  const s = await setup('theme-dark')
  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()

  const group = await openAppearance(page)
  await group.getByRole('radio', { name: 'Dark' }).click()

  // No navigation: the handler writes the attribute itself.
  await expect.poll(async () => (await themeState(page)).theme).toBe('dark')
  expect(await themeState(page)).toMatchObject({
    theme: 'dark',
    pref: 'dark',
    bodyBg: 'rgb(0, 0, 0)',
    colorScheme: 'dark',
  })

  const cookie = (await page.context().cookies()).find((c) => c.name === COOKIE)
  expect(cookie?.value).toBe('dark')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  expect(await themeState(page)).toMatchObject({ theme: 'dark', pref: 'dark' })
})

/**
 * The structural guarantee behind "no flash". The theme is applied by an inline
 * script in <head>, so it has run before <body> is parsed and the first paint is
 * already correct.
 *
 * The second assertion is the one that keeps the service worker honest: React
 * must render no theme attribute at all, because `src/sw.ts` caches navigations
 * NetworkFirst and a cached document would otherwise carry a stale theme.
 */
test('the theme is applied from <head>, and never baked into the HTML', async ({
  page,
}) => {
  const s = await setup('theme-noflash')
  await signInViaUi(page, s.email)

  const res = await page.request.get(`/${s.slug}/schedule`)
  const html = await res.text()

  const script = html.indexOf('dataset.themePref')
  const body = html.indexOf('<body')
  expect(
    script,
    'the init script is missing from the document',
  ).toBeGreaterThan(-1)
  expect(
    script,
    'the init script must run before <body> is parsed',
  ).toBeLessThan(body)

  const openingTag = html.slice(0, html.indexOf('>', html.indexOf('<html')) + 1)
  expect(openingTag).not.toContain('data-theme')
})

test('System follows the OS, live, in both directions', async ({ page }) => {
  const s = await setup('theme-system')
  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()

  // No reload between these: this is the matchMedia listener in
  // src/lib/useTheme.ts, and nothing else covers it.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(async () => (await themeState(page)).theme).toBe('dark')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(async () => (await themeState(page)).theme).toBe('light')
})

/**
 * What the 17 vendored `dark:` variants used to get wrong: they keyed off
 * `prefers-color-scheme`, so they fired on a dark-OS device even for someone
 * who had explicitly asked for Light.
 */
test('an explicit choice beats the OS', async ({ page }) => {
  const s = await setup('theme-explicit')
  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()

  const group = await openAppearance(page)
  await group.getByRole('radio', { name: 'Light' }).click()
  await expect.poll(async () => (await themeState(page)).pref).toBe('light')

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()

  expect(await themeState(page)).toMatchObject({
    theme: 'light',
    pref: 'light',
  })
})

/**
 * A finalised report is a document, not app chrome: what is on screen has to
 * match what `reports/pdf/*` prints on white paper. The "while the page around
 * it is black" half is what stops this being a tautology.
 */
test('the report preview stays on white paper in dark mode', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('theme-report')
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

  // Signed in first so the context has an origin to hang the cookie on, and so
  // the report page is reached with dark already set rather than toggled after.
  await signInViaUi(page, s.owner.email)
  await page
    .context()
    .addCookies([
      { name: COOKIE, value: 'dark', url: new URL(page.url()).origin },
    ])

  await page.goto(`/${s.slug}/reports/${reportId}`)

  const paper = page.locator('article[data-theme="light"]')
  await expect(paper).toBeVisible()

  const seen = await page.evaluate(() => {
    const article = document.querySelector('article[data-theme="light"]')!
    return {
      page: getComputedStyle(document.body).backgroundColor,
      paper: getComputedStyle(article).backgroundColor,
      ink: getComputedStyle(article).color,
    }
  })

  expect(seen.page).toBe('rgb(0, 0, 0)')
  expect(luminance(seen.paper)).toBeGreaterThan(0.8)
  expect(luminance(seen.ink)).toBeLessThan(0.2)
})

/**
 * Asserted on rendered output rather than on the CSS, for the reason
 * `design-tokens.spec.ts` gives: a token that resolves against the wrong
 * namespace still produces valid CSS, and only the rendered result shows it.
 */
test('dark mode keeps body and secondary text readable', async ({ page }) => {
  const s = await setup('theme-contrast')
  await signInViaUi(page, s.email)
  await page.goto(`/${s.slug}/settings?seg=prefs`)

  const caption = page.getByText(/State determines your timezone/)
  await expect(caption).toBeVisible()

  const group = await openAppearance(page)
  await group.getByRole('radio', { name: 'Dark' }).click()
  await expect.poll(async () => (await themeState(page)).theme).toBe('dark')
  await page.keyboard.press('Escape')

  const pairs = await caption.evaluate((node) => {
    const el = node as HTMLElement
    // Walk up for the nearest painted background: the caption itself is
    // transparent, so reading its own background would measure nothing.
    let bg = 'rgba(0, 0, 0, 0)'
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
        bg = c
        break
      }
    }
    return { fg: getComputedStyle(el).color, bg }
  })

  expect(contrast(pairs.fg, pairs.bg)).toBeGreaterThanOrEqual(4.5)
})

function channels(colour: string): [number, number, number] {
  const [r, g, b] = colour.match(/\d+(\.\d+)?/g)!.map(Number)
  return [r, g, b]
}

function luminance(colour: string): number {
  const [r, g, b] = channels(colour).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}
