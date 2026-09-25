import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { createReport } from './fixtures/reportPayloads'
import { getTemplate } from '../src/lib/reportTemplates'
import type { Page } from '@playwright/test'

/**
 * A Convex token refresh that fails, for want of signal or on a server
 * hiccup, must not sign the socket out (src/lib/tokenRefresh.ts). It used to.
 * @convex-dev/better-auth answers a failed /api/auth/convex/token the same way
 * as a 401, and the Convex client signed the socket out on it until the next
 * reload. The Reports list then ended on "Not found", or on "Something went
 * wrong!".
 *
 * The Convex client refreshes ten seconds before its token expires, which is
 * 14:50 into the better-auth convex plugin's 15 minutes. These tests run the
 * page's clock past that, so the scheduled refresh fires as it does on a phone
 * waking after a quarter of an hour in a pocket.
 */

const CERTIFICATE = getTemplate('termiteManagementCert').name
const SERVICE = getTemplate('serviceReport').name
const exact = { exact: true } as const
const PAST_THE_REFRESH = '15:00'

const convexHost = new URL(process.env.VITE_CONVEX_URL!).host

// page.route has to see /api/auth/* before a service worker can answer it.
test.use({ serviceWorkers: 'block' })

test('a token refresh that fails for want of signal leaves the reports list signed in', async ({
  page,
}) => {
  const s = await ownerWithReport('refresh-failed')
  await page.clock.install()
  await watchForErrorScreen(page)
  await signInViaUi(page, s.email)
  const tokenTypes = recordAuthenticates(page)

  let failNext = false
  let failed = 0
  let fetched = 0
  await page.route('**/api/auth/convex/token', async (route) => {
    if (failNext) {
      failNext = false
      failed++
      await route.abort('internetdisconnected')
      return
    }
    fetched++
    await route.continue()
  })

  await page.goto(`/${s.slug}/reports`)
  await expect(page.getByText(CERTIFICATE, exact)).toBeVisible()
  // The page's own refreshes, after its first token and the hand-over, are
  // done, so the one that fails is the scheduled one.
  await untilQuiet(() => fetched)

  const before = fetched
  failNext = true
  await page.clock.fastForward(PAST_THE_REFRESH)
  await expect.poll(() => failed).toBe(1)

  // It fetches again, and the socket takes the new token.
  await expect.poll(() => fetched).toBeGreaterThan(before)
  await expect
    .poll(() => tokenTypes.slice(-1)[0], { timeout: 20_000 })
    .toBe('User')
  expect(tokenTypes).not.toContain('None')
  expect(await sawErrorScreen(page)).toBe(false)

  // And it is still signed in: a report added now arrives live.
  await createReport(
    s.owner.client,
    { businessId: s.businessId, propertyId: s.propertyId },
    'serviceReport',
  )
  await expect(page.getByText(SERVICE, exact)).toBeVisible()
  expect(tokenTypes).not.toContain('None')
  expect(await sawErrorScreen(page)).toBe(false)
  await expect(notFound(page)).toHaveCount(0)
})

test('a phone that wakes with no signal picks up where it left off once the signal is back', async ({
  page,
  context,
}) => {
  const s = await ownerWithReport('refresh-offline')
  await page.clock.install()
  await watchForErrorScreen(page)
  await signInViaUi(page, s.email)
  const tokenTypes = recordAuthenticates(page)

  let refreshes = 0
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/convex/token')) refreshes++
  })
  let refreshesFailed = 0
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/auth/convex/token')) refreshesFailed++
  })

  await page.goto(`/${s.slug}/reports`)
  await expect(page.getByText(CERTIFICATE, exact)).toBeVisible()
  await untilQuiet(() => refreshes)

  await context.setOffline(true)
  await page.clock.fastForward(PAST_THE_REFRESH)
  await expect.poll(() => refreshesFailed).toBeGreaterThan(0)
  // Long enough for a refresh that gave up to have signed the socket out,
  // and for the list to have thrown its refusal.
  await page.waitForTimeout(3_000)
  await expect(page.getByText(CERTIFICATE, exact)).toBeVisible()
  expect(await sawErrorScreen(page)).toBe(false)

  const beforeSignal = refreshes
  await context.setOffline(false)
  await expect.poll(() => refreshes).toBeGreaterThan(beforeSignal)

  await createReport(
    s.owner.client,
    { businessId: s.businessId, propertyId: s.propertyId },
    'serviceReport',
  )
  await expect(page.getByText(SERVICE, exact)).toBeVisible({ timeout: 30_000 })
  expect(tokenTypes).not.toContain('None')
  expect(await sawErrorScreen(page)).toBe(false)
  await expect(notFound(page)).toHaveCount(0)
})

async function ownerWithReport(label: string) {
  const email = uniqueEmail(label)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  await createReport(
    owner.client,
    { businessId, propertyId },
    'termiteManagementCert',
  )
  return { email, owner, businessId, propertyId, slug }
}

/**
 * What every Authenticate the page sends to Convex from now on tells the
 * server: "User" with a token, or "None", which is the socket signing out.
 * Watched, not routed, so the socket goes offline with the page.
 */
function recordAuthenticates(page: Page) {
  const tokenTypes: Array<string> = []
  page.on('websocket', (ws) => {
    if (new URL(ws.url()).host !== convexHost) return
    ws.on('framesent', ({ payload }) => {
      const sent = parse(payload)
      if (sent?.type === 'Authenticate') tokenTypes.push(String(sent.tokenType))
    })
  })
  return tokenTypes
}

/** Waits until `count` has not moved for two seconds. */
async function untilQuiet(count: () => number) {
  let last = -1
  let since = Date.now()
  await expect
    .poll(
      () => {
        if (count() !== last) {
          last = count()
          since = Date.now()
        }
        return Date.now() - since >= 2_000
      },
      { timeout: 30_000 },
    )
    .toBe(true)
}

/**
 * Records whether the router's error screen was EVER on screen, not just
 * whether it is at the end (as e2e/signInHandover.spec.ts does). Its exact
 * words, with the "!", which nothing else in the app uses.
 */
async function watchForErrorScreen(page: Page) {
  await page.addInitScript(() => {
    const seen = () => {
      // Null until the parser reaches <body>, whatever the DOM types say.
      const body = document.body as HTMLElement | null
      if (body?.textContent.includes('Something went wrong!')) {
        ;(window as { sawErrorScreen?: boolean }).sawErrorScreen = true
      }
    }
    new MutationObserver(seen).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  })
}

/**
 * Where a signed-out socket actually left the Reports list: the business
 * lookup answers nothing for nobody, which reads as a business that does not
 * exist.
 */
const notFound = (page: Page) =>
  page.getByRole('heading', { name: 'Not found', level: 1 })

const sawErrorScreen = (page: Page) =>
  page.evaluate(
    () => (window as { sawErrorScreen?: boolean }).sawErrorScreen === true,
  )

function parse(message: string | Buffer): Record<string, unknown> | null {
  if (typeof message !== 'string') return null
  try {
    return JSON.parse(message) as Record<string, unknown>
  } catch {
    return null
  }
}
