import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { createReport, finaliseReport } from './fixtures/reportPayloads'
import { getTemplate } from '../src/lib/reportTemplates'
import type { Page, WebSocketRoute } from '@playwright/test'

/**
 * Who the Convex socket speaks for while a signed-in page is loading, and
 * what the business guard makes of an answer given for nobody.
 *
 * reportsList.spec.ts sometimes ended on "Not found" at a tab tap. The chain,
 * captured frame by frame on a slow run:
 *
 * 1. The socket opened while the server-rendered page was still hydrating
 *    and asked for every query the server render had handed over, before
 *    ConvexBetterAuthProvider had mounted to send the token.
 * 2. The server answered them as nobody. `businesses.getBySlug` answers
 *    nobody with null, and that null replaced the server render's business
 *    in the cache.
 * 3. A tap in the moment before the signed-in answers arrived ran
 *    `$businessSlug`'s guard, which read the null, asked whether the person
 *    was still signed in (they were), and called it a business that does not
 *    exist.
 *
 * The socket now says nothing until it knows who the page load is for
 * (`holdForSignIn` in lib/convexClient.ts), and the guard asks a null again
 * over HTTP before it believes it ($businessSlug/route.tsx). The first test pins the one, the
 * third the other, and the second is the tap itself, which either keeps
 * working. The last is the page that has to work with nobody signed in.
 *
 * It took a slow phone, or a machine loaded enough to hydrate like one:
 * hydration outlasting the socket's handshake. The reports page is loaded
 * here with its route chunk held back (`hydrateLate`), which makes that
 * every run rather than one in thirty.
 */

// Held chunks have to come from the network: the service worker answers
// from its own cache, where `page.route` never sees the request.
test.use({ serviceWorkers: 'block' })

const CONVEX_HOST = new URL(process.env.VITE_CONVEX_URL!).host
const TIMBER = getTemplate('timberPestInspection').name
const SERVICE = getTemplate('serviceReport').name
const exact = { exact: true } as const

type ClientMessage = {
  type: string
  tokenType?: string
  modifications?: Array<{ type: string; queryId: number; udfPath?: string }>
}
type ServerMessage = {
  type: string
  modifications?: Array<{ type: string; queryId: number; value?: unknown }>
}

function parse<T>(message: string | Buffer): T | null {
  try {
    return JSON.parse(message.toString()) as T
  } catch {
    return null
  }
}

const asksForQueries = (message: ClientMessage) =>
  message.type === 'ModifyQuerySet' &&
  (message.modifications ?? []).some((change) => change.type === 'Add')

/** A business with one draft and one finalised report, and its owner. */
async function seed(label: string) {
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
    'timberPestInspection',
  )
  const finalised = await createReport(
    owner.client,
    { businessId, propertyId },
    'serviceReport',
  )
  await finaliseReport(owner.client, { businessId }, finalised, 'serviceReport')
  return { email, slug }
}

/** Every Convex socket this page opens, passed through `wire`. */
async function routeConvex(
  page: Page,
  wire: (page: WebSocketRoute, server: WebSocketRoute) => void,
) {
  await page.routeWebSocket(
    (url) => url.host === CONVEX_HOST,
    (ws) => wire(ws, ws.connectToServer()),
  )
}

/**
 * Loads the reports page with its route chunk held back until the page's
 * Convex socket is open. Hydration waits on that chunk; the socket, opened by
 * the entry chunk, does not — so the socket is up while the page is still
 * hydrating, as on a slow phone. By then the queries the server render
 * handed over are in the cache, and a client that asks before its token has
 * asked.
 */
async function hydrateLate(
  page: Page,
  url: string,
  ready: () => Promise<void>,
) {
  // After routeConvex, so it wraps the socket Playwright routes.
  await page.addInitScript((host) => {
    const Socket = window.WebSocket
    window.WebSocket = class extends Socket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args)
        if (String(args[0]).includes(host))
          this.addEventListener('open', () => {
            ;(window as { convexOpen?: boolean }).convexOpen = true
          })
      }
    }
  }, CONVEX_HOST)

  const chunk = /\/assets\/reports-[\w-]+\.js$/
  let held = 0
  await page.route(chunk, async (route) => {
    held++
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as { convexOpen?: boolean }).convexOpen === true,
          ),
        { timeout: 20_000 },
      )
      .toBe(true)
    await route.continue()
  })
  try {
    await page.goto(url)
    await ready()
  } finally {
    await page.unroute(chunk)
  }
  // A renamed chunk would quietly stop holding anything back.
  expect(held).toBeGreaterThan(0)
}

/**
 * The Draft list, and nothing else. Its tab selected is what tells it from
 * the All list still on screen while a tap is being resolved — which shows
 * the same draft — and from "Not found", which has no tabs at all.
 */
async function expectDraftList(page: Page) {
  await expect(page.getByRole('tab', { name: 'Draft' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByText(TIMBER, exact)).toBeVisible()
  await expect(page.getByText(SERVICE, exact)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Not found' })).toHaveCount(0)
}

test('a signed-in page load sends its token before it asks for anything', async ({
  page,
}) => {
  const s = await seed('socket-order')

  const sockets: ClientMessage[][] = []
  await routeConvex(page, (ws, server) => {
    const sent: ClientMessage[] = []
    sockets.push(sent)
    ws.onMessage((message) => {
      const parsed = parse<ClientMessage>(message)
      if (parsed) sent.push(parsed)
      server.send(message)
    })
    server.onMessage((message) => ws.send(message))
  })

  await signInViaUi(page, s.email)
  const opened = sockets.length
  await hydrateLate(page, `/${s.slug}/reports`, () =>
    expect(page.getByRole('tab', { name: 'Draft' })).toBeEnabled(),
  )

  // This page load's socket, once it has asked for the page's queries.
  const socket = () =>
    sockets.slice(opened).find((sent) => sent.some(asksForQueries))
  await expect.poll(() => socket() !== undefined).toBe(true)
  const sent = socket()!

  const firstToken = sent.findIndex((m) => m.type === 'Authenticate')
  expect(firstToken).toBeGreaterThanOrEqual(0)
  expect(sent[firstToken].tokenType).toBe('User')
  expect(firstToken).toBeLessThan(sent.findIndex(asksForQueries))
})

test('a tab tapped the moment the reports page loads is never "Not found"', async ({
  page,
}) => {
  const s = await seed('socket-tap')

  // Once armed, the page's messages from its token on are held back, so no
  // signed-in answer can arrive before the tap. Anything it asked before its
  // token goes through and is answered as nobody, as it was on a slow run.
  let armed = false
  let holding = true
  const held: Array<() => void> = []
  let askedBeforeToken = false
  let answeredForNobody = false
  await routeConvex(page, (ws, server) => {
    if (!armed) {
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => ws.send(message))
      return
    }
    let tokenSent = false
    ws.onMessage((message) => {
      const parsed = parse<ClientMessage>(message)
      if (parsed?.type === 'Authenticate') tokenSent = true
      if (!tokenSent && parsed && asksForQueries(parsed))
        askedBeforeToken = true
      if (tokenSent && holding) held.push(() => server.send(message))
      else server.send(message)
    })
    server.onMessage((message) => {
      const parsed = parse<ServerMessage>(message)
      if (
        holding &&
        parsed?.type === 'Transition' &&
        parsed.modifications?.length
      )
        answeredForNobody = true
      ws.send(message)
    })
  })

  await signInViaUi(page, s.email)
  armed = true
  const draft = page.getByRole('tab', { name: 'Draft' })
  await hydrateLate(page, `/${s.slug}/reports`, () =>
    expect(draft).toBeEnabled(),
  )

  // A client that asked before its token is waited on until those answers
  // are in, so the tap reads them: that is the moment that went wrong.
  await expect
    .poll(() => !askedBeforeToken || answeredForNobody, { timeout: 15_000 })
    .toBe(true)
  await draft.click()

  holding = false
  for (const send of held.splice(0)) send()
  await expectDraftList(page)
})

test('a business the socket answers as nobody is asked again, not taken as missing', async ({
  page,
}) => {
  const s = await seed('socket-null')

  // Once armed, every answer the socket gives for the business lookup is
  // null — what it says for someone it has no token for.
  let armed = false
  let nulled = 0
  await routeConvex(page, (ws, server) => {
    const lookups = new Set<number>()
    ws.onMessage((message) => {
      for (const change of parse<ClientMessage>(message)?.modifications ?? []) {
        if (change.type === 'Add' && change.udfPath === 'businesses:getBySlug')
          lookups.add(change.queryId)
      }
      server.send(message)
    })
    server.onMessage((message) => {
      const parsed = parse<ServerMessage>(message)
      const answers = (parsed?.modifications ?? []).filter(
        (change) =>
          change.type === 'QueryUpdated' && lookups.has(change.queryId),
      )
      if (!armed || parsed?.type !== 'Transition' || !answers.length) {
        ws.send(message)
        return
      }
      for (const answer of answers) answer.value = null
      ws.send(JSON.stringify(parsed))
      nulled++
    })
  })

  await signInViaUi(page, s.email)
  armed = true
  await page.goto(`/${s.slug}/reports`)
  const draft = page.getByRole('tab', { name: 'Draft' })
  await expect(draft).toBeEnabled()
  await expect.poll(() => nulled).toBeGreaterThan(0)
  // Let the page take the null in before the tap reads it.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))

  await draft.click()
  await expectDraftList(page)
})

test('a join link opens for someone signed out, who can join from it', async ({
  page,
}) => {
  const owner = await signUpActor(
    uniqueEmail('socket-join-owner'),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const name = `Socket Join ${Date.now()}`
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name, state: 'WA', timezone: 'Australia/Perth' },
  )
  const email = uniqueEmail('socket-join-sub')
  const { url } = await owner.client.action(api.invitations.create, {
    businessId,
    email,
    role: 'subcontractor',
  })

  // The preview is asked for over the socket, which a page loaded signed out
  // has to let go without a token — it used to hang here, on "Checking your
  // invitation…".
  await page.goto(`/join/${url.split('/join/')[1]}`)
  await expect(
    page.getByRole('heading', { name: `Join ${name}` }),
  ).toBeVisible()

  // And signing up in place hands the same socket a token.
  const submit = page.getByRole('button', { name: 'Create account & join' })
  await expect(submit).toBeEnabled()
  await page.getByLabel('Your name').fill('Kevin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(FIXTURE_PASSWORD)
  await submit.click()
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule`))
})
