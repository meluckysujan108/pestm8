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
 * A line that dies without either end hearing (src/lib/socketWatch.ts): what
 * iOS does to a Home Screen app's connection while it sits in the background
 * during a phone call. The socket still says it is open; the Convex client
 * alone noticed only after a minute of silence, and every tap waited that
 * long (25 Oct 2026: "if a client calls and I go to book them in it hangs").
 *
 * The line is killed here by routing the page's Convex socket and, on cue,
 * passing nothing either way — no close, no error, just silence.
 */

const convexHost = new URL(process.env.VITE_CONVEX_URL!).host

async function ownerWithBusiness(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { slug, businessId } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )
  return { owner, slug, businessId }
}

/** The page's Convex sockets, each of which can be made to go silent. */
async function lines(page: Page) {
  const opened: Array<{ route: WebSocketRoute; silent: boolean }> = []
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws) => {
      const line = { route: ws, silent: false }
      opened.push(line)
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        if (!line.silent) server.send(message)
      })
      server.onMessage((message) => {
        if (!line.silent) ws.send(message)
      })
    },
  )
  return {
    count: () => opened.length,
    /** The current line dies, as far as both ends can tell: it carries
     * nothing, and closes nothing. */
    kill() {
      const line = opened.at(-1)
      if (line) line.silent = true
    },
  }
}

/** The app going to the background, and coming back: what a phone call does. */
async function setOnScreen(page: Page, onScreen: boolean) {
  await page.evaluate((visible) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (visible ? 'visible' : 'hidden'),
    })
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => !visible,
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }, onScreen)
}

test('a line that died while the app was away is given up moments after it comes back', async ({
  page,
}) => {
  const s = await ownerWithBusiness('dead-line')
  const line = await lines(page)
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  const before = line.count()

  await setOnScreen(page, false)
  line.kill()
  // Long enough that the server would have said something on a live line.
  await page.waitForTimeout(22_000)
  await setOnScreen(page, true)

  // A new line within seconds, not the minute the Convex client waits.
  await expect.poll(() => line.count(), { timeout: 6_000 }).toBe(before + 1)
  await page.getByRole('button', { name: 'New job' }).click()
  await expect(page.getByRole('button', { name: 'Book job' })).toBeVisible()
  await expect(page.locator('[data-reach-notice="banner"]')).toHaveCount(0)
})

test('New Job opens at once on a page just opened, though the line has died', async ({
  page,
}) => {
  const s = await ownerWithBusiness('dead-line-booking')
  // A client already on the books: the caller rings to book again.
  const [owner] = await s.owner.client.query(api.memberships.listForBusiness, {
    businessId: s.businessId,
  })
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    newClient: {
      kind: 'person',
      clientName: 'Arthur Wellard',
      addressLine: '12 Wattle Street',
      suburb: 'Wellard',
      state: 'WA',
      postcode: '6170',
    },
    assignedMembershipId: owner._id,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: Date.now() + 24 * 60 * 60 * 1000,
    durationMinutes: 60,
  })
  const line = await lines(page)
  await signInViaUi(page, s.owner.email)
  // Opened afresh — as from the Home Screen — not reached by a tap in the app.
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  // The clients, team and job types New Job is made of come in the background.
  await page.waitForTimeout(3_000)

  line.kill()
  await page.getByRole('button', { name: 'New job' }).click()
  await expect(page.getByRole('button', { name: 'Book job' })).toBeVisible({
    timeout: 2_000,
  })
  // On the existing clients, which it can only offer with the client list
  // already on the phone: it starts on New client when it has none.
  await expect(page.getByText('Choose a client and address')).toBeVisible()
})
