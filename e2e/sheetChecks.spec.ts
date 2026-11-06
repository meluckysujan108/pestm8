import { expect, test } from '@playwright/test'
import { addDaysToKey } from '../convex/lib/dates'
import { formatJobDate } from '../src/lib/format'
import {
  FIXTURE_PASSWORD,
  api,
  chooseJobTypes,
  chooseProperty,
  clickUntil,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Locator, Page, WebSocketRoute } from '@playwright/test'
import type { Actor } from './fixtures'
import type { Id } from '../convex/_generated/dataModel'

/**
 * The online sheet sends its checks (the matching plan's M7): what the
 * server finds as a booking or a new client goes, that the phone's copy
 * didn't hold yet, comes back as rows of the panel, with the phone's own
 * words and "PestM8 found this when saving.", and Book anyway (or Save
 * anyway) makes it once.
 *
 * The page's Convex socket holds every query update (`Transition`) from just
 * before a client or job is added through the backend until at least 5 s
 * later (`holdUpdates`): so the page's client list and jobs are as they were
 * when it pressed Book, while the server's are current. Saves' answers go
 * through as they come. A refused save writes nothing, so its answer needs
 * no update to land; a save that goes through does, so Book anyway is
 * pressed once the hold is let go.
 *
 * In a build with the outbox switched on (`VITE_PESTM8_OUTBOX=on`), New
 * Job's booking is kept on the phone and sent without the sheet's checks
 * until 2c-J, so those two cases are skipped there; Clients → New client
 * goes straight either way.
 *
 * Numbers are from ACMA's ranges for fiction. On a phone's screen.
 */

const TZ = 'Australia/Perth'
const convexHost = new URL(process.env.VITE_CONVEX_URL!).host
const OUTBOX_BUILD = process.env.VITE_PESTM8_OUTBOX === 'on'

/** How long the page's updates are held at the least. */
const HOLD_MS = 5_000

const MEI = { name: 'Mei Chen', mobile: '0491 570 177' }

test.use({ viewport: { width: 390, height: 844 } })
test.describe.configure({ timeout: 180_000 })

function perthToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
}

/** `hh`:00 on `dayKey` in Perth (UTC+8 all year). */
function perthAt(dayKey: string, hh: number) {
  return Date.parse(`${dayKey}T${String(hh).padStart(2, '0')}:00:00+08:00`)
}

/** How New Job writes a day: "Thu 29 Oct". */
const dateOf = (dayKey: string) => formatJobDate(dayKey, perthToday())

/**
 * The page's Convex sockets, every query update held from `start()` until
 * HOLD_MS after it and `release()` both, then sent on in the order they
 * came. Everything else (a save's answer, a Ping) goes at once.
 */
async function holdUpdates(page: Page) {
  let holding = false
  let startedAt = 0
  const held: Array<{ ws: WebSocketRoute; message: string | Buffer }> = []
  const isUpdate = (message: string | Buffer) => {
    if (typeof message !== 'string') return false
    try {
      const type = (JSON.parse(message) as { type?: unknown }).type
      return typeof type === 'string' && type.startsWith('Transition')
    } catch {
      return false
    }
  }
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => {
        if (holding && isUpdate(message)) {
          held.push({ ws, message })
          return
        }
        ws.send(message)
      })
    },
  )
  return {
    start() {
      holding = true
      startedAt = Date.now()
    },
    async release() {
      const left = startedAt + HOLD_MS - Date.now()
      if (left > 0) await page.waitForTimeout(left)
      holding = false
      for (const { ws, message } of held.splice(0)) ws.send(message)
    },
  }
}

/** A business with Jane Nguyen at 12 Wattle St, Bayswater; the owner's
 * membership, to book with. */
async function seedBusiness(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `${label} ${Date.now()}`, state: 'WA', timezone: TZ },
  )
  const janeSite = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Jane Nguyen',
    kind: 'person',
    phone: '0491 570 162',
    addressLine: '12 Wattle St',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const ownerMembership = members.find((m) => m.role === 'owner')!._id
  return { owner, businessId, slug, janeSite, ownerMembership }
}

/** Mei Chen, with her mobile, at 7 Rose Ave: added from another phone. */
async function addMei(owner: Actor, businessId: Id<'businesses'>) {
  return owner.client.mutation(api.properties.create, {
    businessId,
    clientName: MEI.name,
    kind: 'person',
    phone: MEI.mobile,
    addressLine: '7 Rose Ave',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
}

async function jobsOn(
  owner: Actor,
  businessId: Id<'businesses'>,
  dayKey: string,
) {
  return owner.client.query(api.jobs.listDay, { businessId, dayKey })
}

async function clientsNamed(
  owner: Actor,
  businessId: Id<'businesses'>,
  name: string,
) {
  const book = await owner.client.query(api.clients.directory, { businessId })
  return book.clients.filter((c) => c.name === name).length
}

/** The schedule on `dayKey`, hydrated, and New Job open on it. */
async function openNewJob(page: Page, slug: string, dayKey: string) {
  await page.goto(`/${slug}/schedule?date=${dayKey}`)
  const button = page.getByRole('button', { name: 'New job' })
  await expect(button).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(button, () =>
    expect(sheet.getByText('New job').first()).toBeVisible({ timeout: 2_000 }),
  )
  return sheet
}

/** The address block, as a caller gives it. */
async function typeAddress(sheet: Locator, street: string) {
  await sheet.getByLabel('Street address', { exact: true }).fill(street)
  await sheet.getByLabel('Suburb', { exact: true }).fill('Bayswater')
  await sheet.getByLabel('Postcode', { exact: true }).fill('6053')
}

/** FormAlert, by its words: “Could not book this job: …”. */
const formAlert = (sheet: Locator) =>
  sheet.getByRole('alert').filter({ hasText: /^Could not/ })

/** The panel above Book, by its heading. */
const panelOf = (sheet: Locator) =>
  sheet.getByRole('region', { name: /to check before saving/ })

test('New Job, a new client the server finds was added a moment ago: “Already a client”, found when saving, and Book anyway books once', async ({
  page,
}) => {
  test.skip(
    OUTBOX_BUILD,
    'A booking kept on the phone sends no checks until 2c-J',
  )
  const s = await seedBusiness('sheet-match')
  const day = addDaysToKey(perthToday(), 1)
  const hold = await holdUpdates(page)
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug, day)

  await sheet.getByRole('radio', { name: 'New client', exact: true }).click()
  await sheet.getByLabel('Client name', { exact: true }).fill(MEI.name)
  await sheet.getByLabel('Phone (optional)', { exact: true }).fill(MEI.mobile)
  await typeAddress(sheet, '40 Coode St')
  await chooseJobTypes(page, sheet, ['General Pest Control'])

  // Added on another phone as this one books: this page's list is behind.
  hold.start()
  await addMei(s.owner, s.businessId)
  await sheet.getByRole('button', { name: 'Book job' }).click()

  // Waited 3 s for the list to hold her, which it doesn't: no Use or Book
  // at, and where to find her instead.
  const panel = panelOf(sheet)
  await expect(panel).toContainText(
    'Already a client: Mei Chen, of Bayswater, has the same name and mobile. Open Mei Chen from Clients to book this job.',
    { timeout: 10_000 },
  )
  await expect(panel).toContainText('PestM8 found this when saving.')
  await expect(panel.getByRole('button', { name: /Mei Chen/ })).toHaveCount(0)
  // The panel says it: FormAlert doesn't say it again.
  await expect(formAlert(sheet)).toHaveCount(0)
  expect(await jobsOn(s.owner, s.businessId, day)).toHaveLength(0)

  await hold.release()
  // The list catches up: the row is read again in place, with its fix,
  // and Book anyway is held for half a second as it changes (`refresh`,
  // SUBMIT_ARM_MS). Pressed only once it has, and again only if that press
  // landed in the hold and nothing came of it.
  await expect(panel).not.toContainText('Open Mei Chen from Clients')
  await clickUntil(sheet.getByRole('button', { name: 'Book anyway' }), () =>
    expect(sheet).toBeHidden({ timeout: 2_000 }),
  )
  await expect
    .poll(async () => (await jobsOn(s.owner, s.businessId, day)).length)
    .toBe(1)
  // The caller was booked as a new client, as Book anyway said.
  expect(await clientsNamed(s.owner, s.businessId, MEI.name)).toBe(2)
})

test('New Job at a site the server finds was booked a moment ago: “Already booked”, Open #n, and Book anyway books once', async ({
  page,
}) => {
  test.skip(
    OUTBOX_BUILD,
    'A booking kept on the phone sends no checks until 2c-J',
  )
  const s = await seedBusiness('sheet-site')
  const jobDay = addDaysToKey(perthToday(), 1)
  const bookDay = addDaysToKey(jobDay, 1)
  const creates: Array<string> = []
  page.on('websocket', (ws) =>
    ws.on('framesent', ({ payload }) => {
      if (String(payload).includes('jobs:create')) creates.push(String(payload))
    }),
  )
  const hold = await holdUpdates(page)
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug, bookDay)
  await chooseProperty(page, sheet, 'Jane Nguyen', /12 Wattle St/)
  await chooseJobTypes(page, sheet, ['General Pest Control'])

  hold.start()
  const jobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.janeSite,
    assignedMembershipId: s.ownerMembership,
    jobType: 'General Pest Control',
    price: 18500,
    scheduledAt: perthAt(jobDay, 10),
    durationMinutes: 60,
  })
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId,
  })
  await sheet.getByRole('button', { name: 'Book job' }).click()

  const panel = panelOf(sheet)
  await expect(panel).toContainText(
    `Already booked: 12 Wattle St has a job on ${dateOf(jobDay)} at 10:00am (#${job!.jobNumber}).`,
  )
  await expect(panel).toContainText('PestM8 found this when saving.')
  await expect(panel).toContainText(
    'Open it, or press Book anyway to book this one as well.',
  )
  await expect(
    panel.getByRole('button', { name: `Open #${job!.jobNumber}` }),
  ).toBeVisible()
  await expect(formAlert(sheet)).toHaveCount(0)
  expect(await jobsOn(s.owner, s.businessId, bookDay)).toHaveLength(0)

  await hold.release()
  await sheet.getByRole('button', { name: 'Book anyway' }).click()
  await expect(sheet).toBeHidden()
  await expect
    .poll(async () => (await jobsOn(s.owner, s.businessId, bookDay)).length)
    .toBe(1)
  expect(await jobsOn(s.owner, s.businessId, jobDay)).toHaveLength(1)
  // The press refused, and Book anyway: one send each, under one id.
  expect(creates).toHaveLength(2)
  const ids = creates.map(
    (frame) => /"clientRequestId":"([^"]+)"/.exec(frame)?.[1],
  )
  expect(ids[0]).toBeTruthy()
  expect(ids[1]).toBe(ids[0])
})

test('Clients → New client the server finds was added a moment ago: Open Mei Chen by the server’s id, and Save anyway saves once', async ({
  page,
}) => {
  const s = await seedBusiness('sheet-new-client')
  const hold = await holdUpdates(page)
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/clients`)
  const add = page.getByRole('button', { name: 'New client' })
  await expect(add).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(add, () =>
    expect(sheet.getByText('New client').first()).toBeVisible({
      timeout: 2_000,
    }),
  )
  await sheet.getByLabel('Client name', { exact: true }).fill(MEI.name)
  await sheet.getByLabel('Phone (optional)', { exact: true }).fill(MEI.mobile)
  await typeAddress(sheet, '40 Coode St')

  hold.start()
  await addMei(s.owner, s.businessId)
  await sheet.getByRole('button', { name: 'Save client' }).click()

  const panel = panelOf(sheet)
  await expect(panel).toContainText(
    'Already a client: Mei Chen, of Bayswater, has the same name and mobile.',
    { timeout: 10_000 },
  )
  await expect(panel).toContainText('PestM8 found this when saving.')
  // Her sheet opens by the server's id, list or no list.
  await expect(
    panel.getByRole('button', { name: 'Open Mei Chen' }),
  ).toBeVisible()
  await expect(formAlert(sheet)).toHaveCount(0)
  expect(await clientsNamed(s.owner, s.businessId, MEI.name)).toBe(1)

  await hold.release()
  await sheet.getByRole('button', { name: 'Save anyway' }).click()
  await expect(sheet).toBeHidden()
  await expect.poll(() => clientsNamed(s.owner, s.businessId, MEI.name)).toBe(2)
})
