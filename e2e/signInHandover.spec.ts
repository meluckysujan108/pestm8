import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { createReport } from './fixtures/reportPayloads'
import { getTemplate } from '../src/lib/reportTemplates'
import { RETRY_DELAYS_MS } from '../src/lib/signInSettling'
import type { Page } from '@playwright/test'

const CERTIFICATE = getTemplate('termiteManagementCert').name
const SERVICE = getTemplate('serviceReport').name
const exact = { exact: true } as const

const convexHost = new URL(process.env.VITE_CONVEX_URL!).host

// page.route has to see /api/auth/* before a service worker can answer it.
test.use({ serviceWorkers: 'block' })

/**
 * Records whether the router's error screen was EVER on screen, not just
 * whether it is at the end: a screen that flashes and recovers is still one a
 * technician saw. Found by its `data-error-screen` marker
 * (components/shell/ErrorScreen.tsx).
 */
async function watchForErrorScreen(page: Page) {
  await page.addInitScript(() => {
    const seen = () => {
      if (document.querySelector('[data-error-screen]')) {
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

const sawErrorScreen = (page: Page) =>
  page.evaluate(
    () => (window as { sawErrorScreen?: boolean }).sawErrorScreen === true,
  )

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
 * Every page load hands the Convex socket from one sign-in to the next: the
 * first answer from /api/auth/get-session gives Better Auth's session an id,
 * @convex-dev/better-auth builds a new token getter for it, and convex/react's
 * provider re-authenticates with it. Before the fix, that hand-over was a
 * `clearAuth()` followed a moment later by `setAuth()` — so the server was
 * told "nobody" first, re-ran every live query as nobody, and a server slow
 * enough to answer before the token followed told the reports list
 * "Unauthenticated". The paginated list throws its errors, so the page ended
 * on the router's error screen (reportsList.spec.ts, on a slow shared
 * deployment).
 *
 * This makes the server slow on purpose: every token after the socket's first
 * is held for a while on its way there, as is everything the page sends after
 * it (so the server still sees the messages in order), and the token refresh
 * Convex asks for once a token is confirmed is slowed too.
 */
test('a slow re-authentication on page load leaves the reports list signed in', async ({
  page,
}) => {
  const s = await ownerWithReport('handover-slow')
  await watchForErrorScreen(page)
  await signInViaUi(page, s.email)

  const HOLD_MS = 2_500
  const tokenTypes: Array<string> = []
  let held = 0
  let heldDelivered = 0
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws) => {
      const server = ws.connectToServer()
      let hadToken = false
      let queue = Promise.resolve()
      ws.onMessage((message) => {
        let delay = 0
        const sent = parse(message)
        if (sent?.type === 'Authenticate') {
          tokenTypes.push(String(sent.tokenType))
          if (sent.tokenType === 'User') {
            if (hadToken) {
              delay = HOLD_MS
              held++
            }
            hadToken = true
          }
        }
        queue = queue
          .then(() => (delay ? sleep(delay) : undefined))
          .then(() => {
            server.send(message)
            if (delay) heldDelivered++
          })
      })
      server.onMessage((message) => ws.send(message))
    },
  )
  await page.route('**/api/auth/convex/token', async (route) => {
    await sleep(2_000)
    await route.continue()
  })
  // Better Auth's own answer comes after the socket is open and signed in,
  // as it does when the deployment is slow: /get-session runs through
  // Convex's HTTP action, the socket does not.
  await page.route('**/api/auth/get-session*', async (route) => {
    await sleep(2_000)
    await route.continue()
  })

  await page.goto(`/${s.slug}/reports`)
  await expect(page.getByText(CERTIFICATE, exact)).toBeVisible()

  // The hand-over reached an open socket. Its token went out after the
  // first, and one more followed once Convex refreshed the token it had just
  // confirmed. A hand-over made before the socket opened sends one token
  // where these are two, and would leave nothing here to test.
  const tokensSent = () => tokenTypes.filter((type) => type === 'User').length
  await expect.poll(tokensSent, { timeout: 20_000 }).toBeGreaterThanOrEqual(3)
  // And the server has had each held token, and everything behind it, long
  // enough to answer.
  await expect.poll(() => heldDelivered, { timeout: 20_000 }).toBe(held)
  await page.waitForTimeout(1_500)

  expect(await sawErrorScreen(page)).toBe(false)
  // The socket was never told "nobody" while the person was signed in.
  expect(tokenTypes).not.toContain('None')

  // And it is still signed in afterwards: a report added now arrives live.
  await createReport(
    s.owner.client,
    { businessId: s.businessId, propertyId: s.propertyId },
    'serviceReport',
  )
  await expect(page.getByText(SERVICE, exact)).toBeVisible()
  expect(await sawErrorScreen(page)).toBe(false)
})

/**
 * The hold, for a refusal that gets through anyway — from wherever it comes.
 * One answer to the reports list's paginated query is swapped for the
 * refusal the server sends a caller with no live session, while the person
 * is plainly still signed in. The page must hold, ask Better Auth, and retry,
 * and the retry is answered normally.
 */
test('an "Unauthenticated" answer while still signed in is held and retried, not shown as an error', async ({
  page,
}) => {
  const s = await ownerWithReport('handover-refused')
  await watchForErrorScreen(page)
  await signInViaUi(page, s.email)

  let armed = false
  const refusals = await refusePaginatedReports(
    page,
    (refusedSoFar) => armed && refusedSoFar === 0,
  )

  await page.goto(`/${s.slug}/reports`)
  await expect(page.getByText(CERTIFICATE, exact)).toBeVisible()
  const draft = page.getByRole('tab', { name: 'Draft' })
  await expect(draft).toBeEnabled()

  // A segment is a new paginated subscription, and its first answer is the
  // refusal.
  armed = true
  await draft.click()
  await expect(page).toHaveURL(/seg=draft/)
  await expect.poll(() => refusals.count).toBe(1)

  await expect(page.getByText(CERTIFICATE, exact)).toBeVisible()
  await expect(draft).toHaveAttribute('aria-selected', 'true')
  expect(await sawErrorScreen(page)).toBe(false)
})

/**
 * The hold is not a way to hide a page that is refused for good. With every
 * answer to the list refused, the retries run out and the router's error
 * screen shows, as it did before, instead of a placeholder forever.
 */
test('a page refused every time still ends on the error screen once its retries are spent', async ({
  page,
}) => {
  const s = await ownerWithReport('handover-refused-for-good')
  await signInViaUi(page, s.email)

  let armed = false
  const refusals = await refusePaginatedReports(page, () => armed)
  await page.goto(`/${s.slug}/reports`)
  const draft = page.getByRole('tab', { name: 'Draft' })
  await expect(draft).toBeEnabled()

  armed = true
  await draft.click()
  await expect(page.locator('[data-error-screen]')).toBeVisible({
    timeout: 30_000,
  })
  // Refused once, then once more for each retry, before giving up.
  expect(refusals.count).toBeGreaterThanOrEqual(1 + RETRY_DELAYS_MS.length)
})

/**
 * Swaps answers to the reports list's paginated query for the refusal the
 * server sends a caller with no live session, whenever `refuse` says to.
 * Only the paginated list's own subscriptions: `usePaginatedQuery` adds a
 * pagination id, which the route loader's plain first page does not.
 */
async function refusePaginatedReports(
  page: Page,
  refuse: (refusedSoFar: number) => boolean,
) {
  const refusals = { count: 0 }
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws) => {
      const server = ws.connectToServer()
      const paginated = new Set<number>()
      ws.onMessage((message) => {
        const sent = parse(message)
        if (sent?.type === 'ModifyQuerySet') {
          for (const change of sent.modifications as Array<QuerySetChange>) {
            if (
              change.type === 'Add' &&
              change.udfPath === 'reports:list' &&
              change.args[0]?.paginationOpts?.id !== undefined
            ) {
              paginated.add(change.queryId)
            }
          }
        }
        server.send(message)
      })
      server.onMessage((message) => {
        const answer = parse(message)
        if (answer?.type === 'Transition' && refuse(refusals.count)) {
          const changes = answer.modifications as Array<QueryAnswer>
          const before = refusals.count
          answer.modifications = changes.map((change) => {
            if (
              change.type !== 'QueryUpdated' ||
              !paginated.has(change.queryId) ||
              !refuse(refusals.count)
            ) {
              return change
            }
            refusals.count++
            return {
              type: 'QueryFailed',
              queryId: change.queryId,
              errorMessage:
                '[Request ID: e2e] Server Error\nUncaught ConvexError: Unauthenticated',
              errorData: 'Unauthenticated',
              logLines: [],
              journal: change.journal,
            }
          })
          if (refusals.count > before) {
            ws.send(JSON.stringify(answer))
            return
          }
        }
        ws.send(message)
      })
    },
  )
  return refusals
}

/**
 * The hold must not keep a signed-out person on the page. The navigation spec
 * covers an offboarding on the Client tab, whose queries only go stale; on
 * Reports, the paginated list throws the refusal, which is the case the hold
 * is for. The sign-in screen has to replace the placeholder, and the error
 * screen must never show in between (it used to flash there).
 */
test('an offboarded technician on the reports list is sent to sign-in, never the error screen', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('handover-offboard')
  await watchForErrorScreen(page)
  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/reports`)
  await expect(
    page.getByRole('heading', { name: 'Reports', level: 1 }),
  ).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Draft' })).toBeEnabled()

  await s.owner.client.mutation(api.team.remove, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
  })

  await expect(page).toHaveURL(/\/login/)
  expect(await sawErrorScreen(page)).toBe(false)
})

type QuerySetChange = {
  type: string
  queryId: number
  udfPath?: string
  args: Array<{ paginationOpts?: { id?: number } } | undefined>
}

type QueryAnswer = {
  type: string
  queryId: number
  journal?: unknown
  [key: string]: unknown
}

function parse(message: string | Buffer): Record<string, unknown> | null {
  if (typeof message !== 'string') return null
  try {
    return JSON.parse(message) as Record<string, unknown>
  } catch {
    return null
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
