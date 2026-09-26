import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Page } from '@playwright/test'

/**
 * What moving around the app costs, and what it looks like while it waits.
 *
 * Every client navigation used to begin with an HTTP call to the
 * `getInitialState` server function — a Vercel function in US-East that
 * itself fetched a token from Convex — before anything else could load
 * (src/lib/rootState.ts has the numbers). And no route had a pending
 * component, so the only Suspense boundary was the root Outlet's, whose
 * fallback is nothing: a page waiting on its data blanked the header and the
 * dock along with it. These pin both fixes.
 */

async function setup(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  return { owner, slug }
}

/**
 * The one nav visible at this width: the dock on a phone, the sidebar on a
 * desktop. Only the four primary destinations are in both — the rest sit
 * behind the phone's burger (src/components/shell/navItems.ts).
 */
const tab = (page: Page, name: string) =>
  page.getByRole('navigation').getByRole('link', { name, exact: true })

async function openSchedule(page: Page, slug: string) {
  await page.goto(`/${slug}/schedule`)
  // Enabled once hydrated — clicking a link before then is a full page load.
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
}

test('signed in, moving between tabs never waits on the server function', async ({
  page,
}) => {
  const s = await setup('nav-no-serverfn')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)

  const serverFnCalls: Array<string> = []
  page.on('request', (request) => {
    if (request.url().includes('/_serverFn/')) serverFnCalls.push(request.url())
  })

  for (const [name, heading] of [
    ['Client', 'Client'],
    ['Reports', 'Reports'],
    ['Notes', 'Notes'],
    ['Schedule', 'Schedule'],
    // A tab already visited: served from cache, still no call.
    ['Client', 'Client'],
  ] as const) {
    await tab(page, name).click()
    await expect(
      page.getByRole('heading', { name: heading, level: 1 }),
    ).toBeVisible()
  }

  expect(serverFnCalls).toEqual([])

  // Into a Settings page and back out re-runs every beforeLoad too. Settings
  // is behind the phone's burger, so it is opened by URL rather than by tap;
  // the document load is SSR's to answer and makes no call of its own.
  await page.goto(`/${s.slug}/settings`)
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1 }),
  ).toBeVisible()
  // Enabled once hydrated. A row is a plain link, so a tap before then would
  // be a full page load rather than the client navigation this is about.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeEnabled()
  serverFnCalls.length = 0

  // The page's own links, not the sidebar's: "Settings" is in both.
  const main = page.getByRole('main')
  await main.getByRole('link', { name: /^Team/ }).click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings/team$`))
  await main.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings$`))
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1 }),
  ).toBeVisible()

  expect(serverFnCalls).toEqual([])
})

test('an old Settings tab address opens the page that took its place', async ({
  page,
}) => {
  const s = await setup('nav-old-seg')
  await signInViaUi(page, s.owner.email)

  // Bookmarks and the home-screen app's last address still carry the old
  // tabs. Each lands on its own page now.
  await page.goto(`/${s.slug}/settings?seg=team`)
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings/team$`))
  await expect(
    page.getByRole('heading', { name: 'Team', level: 1 }),
  ).toBeVisible()

  // Profile was the old default tab, and the hub is what replaced it — not
  // My details, which has no licence on it. The stale tab leaves the address.
  await page.goto(`/${s.slug}/settings?seg=profile`)
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings$`))
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1 }),
  ).toBeVisible()
  await expect(
    page.getByRole('main').getByRole('link', { name: /^Licence/ }),
  ).toBeVisible()

  // A tab that never existed opens the hub, not an error page.
  await page.goto(`/${s.slug}/settings?seg=nonsense`)
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings(\\?.*)?$`))
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1 }),
  ).toBeVisible()
})

test('a slow page loads inside the shell instead of blanking the app', async ({
  page,
}) => {
  const s = await setup('nav-pending')

  // Hold every Convex message to the browser once armed, so the page's own
  // queries are still out when the navigation commits.
  let delayMs = 0
  const convexHost = new URL(process.env.VITE_CONVEX_URL!).host
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => {
        if (delayMs === 0) ws.send(message)
        else setTimeout(() => ws.send(message), delayMs)
      })
    },
  )

  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)
  delayMs = 1_500

  await tab(page, 'Client').click()

  // The page's placeholder, inside the shell — and the shell still there.
  const placeholder = page.getByRole('main').getByRole('status')
  await expect(placeholder).toBeVisible()
  await expect(page.getByRole('navigation')).toBeVisible()
  await expect(tab(page, 'Client')).toBeVisible()

  await expect(
    page.getByRole('heading', { name: 'Client', level: 1 }),
  ).toBeVisible()
  await expect(placeholder).toHaveCount(0)
})

test('signing out in another tab sends this one to sign-in', async ({
  context,
}) => {
  const s = await setup('nav-signout')
  const page = await context.newPage()
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)

  const other = await context.newPage()
  await other.goto(`/${s.slug}/settings`)
  await clickUntil(other.getByRole('button', { name: 'Sign out' }), () =>
    expect(other).toHaveURL(/\/login/, { timeout: 5_000 }),
  )

  // No navigation of its own: the session ending is enough.
  await expect(page).toHaveURL(/\/login/)
})

test('an offboarded technician is sent to sign-in, not left on a page or "Not found"', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('nav-offboard')
  await signInViaUi(page, s.sub.email)
  await openSchedule(page, s.slug)
  await tab(page, 'Client').click()
  await expect(
    page.getByRole('heading', { name: 'Client', level: 1 }),
  ).toBeVisible()

  // Removal deletes their sessions. The sign-in the browser caches knows
  // nothing of it; the live access query does, because it fails, and that is
  // what has to send them on — with no tap of their own, since a tap that
  // came first would read the business from cache and a later one would find
  // the lookup emptied, which on its own reads as a business that does not
  // exist.
  await s.owner.client.mutation(api.team.remove, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
  })

  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('heading', { name: 'Not found' })).toHaveCount(0)
})
