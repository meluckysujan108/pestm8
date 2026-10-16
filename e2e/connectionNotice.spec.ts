import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Page, WebSocketRoute } from '@playwright/test'

/**
 * When the app can't reach PestM8, it says so (components/shell/
 * ConnectionNotice.tsx), instead of every placeholder and "Saving…" waiting
 * in silence. That silence is what a technician on 5G with a VPN saw on
 * 16 Oct 2026: "Just keeps saying loading and can't do anything".
 *
 * The socket is cut here the way a dead VPN tunnel cuts it: the open one is
 * closed and every new one is refused, while HTTP still works.
 */

const convexHost = new URL(process.env.VITE_CONVEX_URL!).host

async function ownerWithBusiness(label: string) {
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

/** A switch for the page's Convex socket: on, or cut and refusing. */
async function socketSwitch(page: Page) {
  let cut = false
  const open: Array<WebSocketRoute> = []
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws) => {
      if (cut) {
        void ws.close({ code: 1006 })
        return
      }
      open.push(ws)
      const server = ws.connectToServer()
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => ws.send(message))
    },
  )
  return {
    cut() {
      cut = true
      for (const ws of open.splice(0)) void ws.close({ code: 1006 })
    },
    restore() {
      cut = false
    },
  }
}

const notice = (page: Page) => page.locator('[data-reach-notice="banner"]')

test('a socket that cannot reach PestM8 says so, and goes once it can', async ({
  page,
}) => {
  const s = await ownerWithBusiness('reach-notice')
  const socket = await socketSwitch(page)
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  // Nothing to say while everything answers.
  await page.waitForTimeout(3_000)
  await expect(notice(page)).toHaveCount(0)

  socket.cut()
  // Convex reconnects by itself for a few seconds before anyone is told.
  await expect(notice(page)).toBeVisible({ timeout: 20_000 })
  await expect(notice(page)).toContainText('Could not reach PestM8')
  // And a screen reader hears it once, from the region that was always there.
  await expect(page.getByRole('status').filter({ hasText: /./ })).toHaveText(
    'Could not reach PestM8.',
  )

  // Trying again while it still can't changes nothing, and then a reload is
  // offered instead.
  await notice(page).getByRole('button', { name: 'Try again' }).click()
  await expect(
    notice(page).getByRole('button', { name: 'Reload' }),
  ).toBeVisible({ timeout: 15_000 })

  socket.restore()
  await expect(notice(page)).toHaveCount(0, { timeout: 40_000 })
})

test('Try again reconnects at once when PestM8 is back', async ({ page }) => {
  const s = await ownerWithBusiness('reach-retry')
  const socket = await socketSwitch(page)
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  socket.cut()
  await expect(notice(page)).toBeVisible({ timeout: 20_000 })
  // Long enough for Convex's reconnect backoff to have grown.
  await page.waitForTimeout(8_000)

  socket.restore()
  await notice(page).getByRole('button', { name: 'Try again' }).click()
  await expect(notice(page)).toHaveCount(0, { timeout: 10_000 })
})

test('dismissed, it stays away until PestM8 answers again', async ({
  page,
}) => {
  const s = await ownerWithBusiness('reach-dismiss')
  const socket = await socketSwitch(page)
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  socket.cut()
  await expect(notice(page)).toBeVisible({ timeout: 20_000 })
  await notice(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice(page)).toHaveCount(0)
  await page.waitForTimeout(3_000)
  await expect(notice(page)).toHaveCount(0)

  // Back, and then cut again: a new outage is said again.
  socket.restore()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.waitForTimeout(3_000)
  socket.cut()
  await expect(notice(page)).toBeVisible({ timeout: 20_000 })
})

test('an open sheet says so too, since it covers the notice', async ({
  page,
}) => {
  const s = await ownerWithBusiness('reach-sheet')
  const socket = await socketSwitch(page)
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()

  socket.cut()
  const inSheet = sheet.locator('[data-reach-notice="sheet"]')
  await expect(inSheet).toBeVisible({ timeout: 20_000 })
  await expect(inSheet).toContainText('Could not reach PestM8')
  await expect(inSheet.getByRole('button', { name: 'Try again' })).toBeVisible()

  socket.restore()
  await inSheet.getByRole('button', { name: 'Try again' }).click()
  await expect(inSheet).toHaveCount(0, { timeout: 15_000 })
})
