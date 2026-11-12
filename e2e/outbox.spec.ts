import { expect, test } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'
import {
  FIXTURE_PASSWORD,
  api,
  chooseJobTypes,
  chooseProperty,
  clickUntil,
  signInViaUi,
  signUpActor,
  skipNearPerthMidnight,
  uniqueEmail,
  inviteAndJoin,
} from './fixtures'
import {
  addDaysToKey,
  startOfDayInZone,
  startOfWeekKey,
  todayKeyInZone,
} from '../convex/lib/dates'
import type {
  BrowserContext,
  Locator,
  Page,
  WebSocketRoute,
} from '@playwright/test'
import type { Actor } from './fixtures'

/**
 * Book keeps it (plan part 2c, PR 2c-D): a booking made in New Job is written
 * to the phone first (src/lib/outbox/), sent at once when the line is live,
 * and shown in its day's "Not sent yet" group until it goes, each keeping its
 * slot as it turns into the real job.
 *
 * Keeping is behind `VITE_PESTM8_OUTBOX=on` until it is switched on for good,
 * and Playwright's own build has no flag, so this spec runs only against a
 * build made with it, served with `vite preview --port N --strictPort` and
 * pointed at with `E2E_BASE_URL` (a local anonymous backend, as the rest of
 * the suite is run before a merge). The rest of the suite runs once more
 * against Playwright's own build: that is what prod gets until then.
 *
 * "No signal" is `context.setOffline`, which the service worker's fetches
 * feel too. The phone's bookings are read straight from IndexedDB
 * (`pestm8-outbox`), and the backend's jobs straight from Convex.
 */

test.skip(
  process.env.VITE_PESTM8_OUTBOX !== 'on',
  'Needs a build with VITE_PESTM8_OUTBOX=on (E2E_BASE_URL); off by default until 2c-G',
)

const TZ = 'Australia/Perth'
const HOUR = 60 * 60 * 1000
/** Long enough for the kept copy to be written: as keptCopy.spec.ts. */
const KEEP_TIMEOUT = 30_000
/** How long the sheet waits for the server at most (ANSWER_WAIT_MS). */
const ANSWER_WAIT_MS = 4_000
/** How long a keep may take before New Job sends straight (KEEP_WAIT_MS),
 * and how late the slow store answers here: past that, inside the store's
 * own limit (STORE_OP_MS, 3 s). */
const KEEP_WAIT_MS = 1_500
const LATE_OPEN_MS = 2_500
/** How long after it went a booking sent with no answer is settled
 * (SETTLE_MIN_AGE_MS): its "hasn’t answered yet" line is drawn till then. */
const SETTLE_MIN_AGE_MS = 30_000

const convexHost = new URL(process.env.VITE_CONVEX_URL!).host

test.use({ viewport: { width: 390, height: 844 } })
test.describe.configure({ timeout: 240_000 })

// ── Days and people ────────────────────────────────────────────────────────

function perthDay(offset: number): string {
  return addDaysToKey(todayKeyInZone(TZ), offset)
}

function perthAt(dayKey: string, hour: number): number {
  return startOfDayInZone(dayKey, TZ) + hour * HOUR
}

/** The day list's heading, "Sunday 1 November", as keptCopy.spec.ts. */
function dayHeading(page: Page, dayKey: string) {
  const label = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${dayKey}T00:00:00Z`))
  return page.getByRole('heading', { name: label, level: 2 })
}

/** An owner with a business, a subcontractor on it, and Arthur Wellard's
 * site to book on. */
async function business(label: string) {
  const owner = await signUpActor(
    uniqueEmail(`owner-${label}`),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const sub = await signUpActor(
    uniqueEmail(`sub-${label}`),
    FIXTURE_PASSWORD,
    'Kevin',
  )
  const name = `${label} ${Date.now()}`
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name, state: 'WA', timezone: TZ },
  )
  await inviteAndJoin(owner, sub, businessId)
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Arthur Wellard',
    addressLine: '12 Wattle Street',
    suburb: 'Wellard',
    state: 'WA',
    postcode: '6170',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  return {
    owner,
    sub,
    name,
    businessId,
    slug,
    propertyId,
    ownerMembershipId: members.find((m) => m.role === 'owner')!._id,
    subMembershipId: members.find((m) => m.email === sub.email)!._id,
  }
}

type Business = Awaited<ReturnType<typeof business>>

/** A job booked from the office on `dayKey`, at `hour`. */
function bookFromOffice(
  s: Business,
  clientName: string,
  hour: number,
  dayKey: string,
) {
  return s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    newClient: {
      kind: 'person',
      clientName,
      addressLine: `${hour} ${clientName.split(' ')[0]} Street`,
      suburb: 'Wellard',
      state: 'WA',
      postcode: '6170',
    },
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: perthAt(dayKey, hour),
    durationMinutes: 60,
  })
}

/** The day's jobs on the server, for `clientName`. */
async function jobsFor(s: Business, clientName: string, dayKey: string) {
  const day = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey,
  })
  return day.filter((job) => job.clientName === clientName)
}

// ── The page ───────────────────────────────────────────────────────────────

const newJobButton = (page: Page) =>
  page.getByRole('button', { name: 'New job' })

/**
 * The schedule on `dayKey`, hydrated. Each case reads its day once, before
 * anything is booked: New Job books on the day the page shows, and a day
 * read later is tomorrow once a run crosses Perth midnight. A reload keeps
 * it, the worker's with no signal too.
 */
async function openSchedule(page: Page, slug: string, dayKey: string) {
  await page.goto(`/${slug}/schedule?date=${dayKey}`)
  await expect(newJobButton(page)).toBeEnabled()
}

/** As keptCopy.spec.ts: the service worker takes the page over, and keeps it. */
async function keepPageInWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await expect(async () => {
    await page.reload()
    await expect(newJobButton(page)).toBeEnabled()
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller !== null),
    ).toBe(true)
  }).toPass({ timeout: 60_000 })
}

/**
 * Every kept answer (`keptQueries` in src/lib/offline/keptSet.ts): 14 days,
 * 2 weeks, the client list, the team, the job types and what is booked at
 * each site, as keptCopy.spec.ts counts them.
 */
const KEPT_ROWS = 20

/** Written last, so waited for by name as well as counted: the client list
 * (after 5 s), and what is booked at each site, which New Job's check at
 * Book reads with no signal. */
const KEPT_LAST = ['clients:directory', 'jobs:openWork']

/** Waits for the kept copy of the schedule (`pestm8-offline`) to be written,
 * for New Job with no signal. */
async function waitForKeptCopy(page: Page) {
  await expect
    .poll(
      () =>
        page
          .evaluate(async (last) => {
            const names = await indexedDB.databases()
            if (!names.some((db) => db.name === 'pestm8-offline')) return 0
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const open = indexedDB.open('pestm8-offline')
              open.onsuccess = () => resolve(open.result)
              open.onerror = () => reject(open.error ?? new Error('no db'))
            })
            try {
              if (!db.objectStoreNames.contains('rows')) return 0
              const all = db.transaction('rows').objectStore('rows').getAll()
              const rows = await new Promise<Array<{ fn?: unknown }>>(
                (resolve) => {
                  all.onsuccess = () =>
                    resolve(all.result as Array<{ fn?: unknown }>)
                  all.onerror = () => resolve([])
                },
              )
              return last.every((fn) => rows.some((row) => row.fn === fn))
                ? rows.length
                : 0
            } finally {
              db.close()
            }
          }, KEPT_LAST)
          .catch(() => 0),
      { timeout: KEEP_TIMEOUT },
    )
    .toBeGreaterThanOrEqual(KEPT_ROWS)
}

type StoredBooking = {
  localId: string
  state: string
  requestId: string
  attempts: number
  lastAttemptAt: number | null
  result: { id: string } | null
  sentAt: number | null
  /** When the page heard the session it was saved in had ended. */
  sessionEndedAt: number | null
}

/** The bookings on the phone, read from IndexedDB. Never throws. */
async function bookingsOnPhone(page: Page): Promise<Array<StoredBooking>> {
  return page
    .evaluate(async () => {
      const names = await indexedDB.databases()
      if (!names.some((db) => db.name === 'pestm8-outbox')) return []
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('pestm8-outbox')
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error ?? new Error('no db'))
      })
      try {
        if (!db.objectStoreNames.contains('items')) return []
        const all = db.transaction('items').objectStore('items').getAll()
        return await new Promise<Array<StoredBooking>>((resolve) => {
          all.onsuccess = () => resolve(all.result as Array<StoredBooking>)
          all.onerror = () => resolve([])
        })
      } finally {
        db.close()
      }
    })
    .catch(() => [])
}

/** New Job, opened. */
async function openNewJob(page: Page): Promise<Locator> {
  await newJobButton(page).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('button', { name: 'Book job' })).toBeEnabled()
  return sheet
}

/** Arthur Wellard's site, General Pest Control, and Book job. */
async function bookArthurIn(page: Page, sheet: Locator) {
  await chooseProperty(page, sheet, 'Arthur', /Arthur Wellard/)
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await sheet.getByRole('button', { name: 'Book job' }).click()
}

/** New Job for Arthur Wellard's site, booked. */
async function bookArthur(page: Page): Promise<Locator> {
  const sheet = await openNewJob(page)
  await bookArthurIn(page, sheet)
  return sheet
}

/** The day's group of bookings not sent yet, by its heading. */
const groupHeading = (page: Page, name: string | RegExp) =>
  page.getByRole('heading', { level: 3, name })

/** A card, by its client: the open button, which names everything on it. */
const card = (page: Page, clientName: string) =>
  page.getByRole('button', { name: new RegExp(clientName) })

/** How far below its group's heading `clientName`'s slot starts, or null
 * while either isn't there. Never throws, for `expect.poll`. */
async function offsetInGroup(
  page: Page,
  heading: string,
  clientName: string,
): Promise<number | null> {
  const box = (locator: Locator) =>
    locator.boundingBox({ timeout: 1_000 }).catch(() => null)
  const top = await box(groupHeading(page, heading))
  const slot = await box(card(page, clientName))
  return top && slot ? slot.y - top.y : null
}

/**
 * The page's Convex sockets, its first `jobs:create` sent once with another
 * assignee: the server then refuses it as it would a booking made for
 * someone removed from the team a moment before Book, which the form, its
 * roster live, would otherwise have swapped for someone else.
 */
async function refuseFirstBooking(page: Page, removedMembershipId: string) {
  let rewritten = false
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws: WebSocketRoute) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        if (
          !rewritten &&
          typeof message === 'string' &&
          message.includes('"jobs:create"')
        ) {
          rewritten = true
          server.send(
            message.replace(
              /"assignedMembershipId":"[^"]+"/,
              `"assignedMembershipId":"${removedMembershipId}"`,
            ),
          )
          return
        }
        server.send(message)
      })
      server.onMessage((message) => ws.send(message))
    },
  )
}

/** The phone's outbox store slow to open from when `slow()` is called, as
 * WebKit's IndexedDB can be: every open answers LATE_OPEN_MS late. */
async function slowOutboxStore(page: Page) {
  await page.addInitScript((late) => {
    const realOpen = IDBFactory.prototype.open
    const flags = window as unknown as { __outboxSlow?: boolean }
    IDBFactory.prototype.open = function (
      this: IDBFactory,
      name: string,
      version?: number,
    ) {
      if (name !== 'pestm8-outbox' || !flags.__outboxSlow) {
        return realOpen.call(this, name, version)
      }
      const fake = {
        onsuccess: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onupgradeneeded: null as ((event: Event) => void) | null,
        onblocked: null as ((event: Event) => void) | null,
        result: undefined as unknown,
        error: null as unknown,
      }
      setTimeout(() => {
        const real = realOpen.call(this, name, version)
        Object.defineProperty(fake, 'result', { get: () => real.result })
        real.onupgradeneeded = (event) => fake.onupgradeneeded?.(event)
        real.onsuccess = (event) => fake.onsuccess?.(event)
        real.onerror = (event) => fake.onerror?.(event)
        real.onblocked = (event) => fake.onblocked?.(event)
      }, late)
      return fake as unknown as IDBOpenDBRequest
    }
  }, LATE_OPEN_MS)
  return () =>
    page.evaluate(() => {
      ;(window as unknown as { __outboxSlow?: boolean }).__outboxSlow = true
    })
}

// ── The cases ──────────────────────────────────────────────────────────────

test('booked with no signal: kept on the phone, shown, and once back, the same slot becomes the job', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-offline')
  await bookFromOffice(s, 'Beatrice Byford', 8, day)
  await bookFromOffice(s, 'Cedric Coolbellup', 11, day)
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  let before: number | null = null
  try {
    const sheet = await openNewJob(page)
    // Its own words above Book job: kept on the phone, nothing to keep open.
    await expect(
      sheet.getByText(
        'No signal — the booking is kept on this phone and goes when PestM8 is open with signal.',
      ),
    ).toBeVisible()
    await chooseProperty(page, sheet, 'Arthur', /Arthur Wellard/)
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    const started = Date.now()
    await sheet.getByRole('button', { name: 'Book job' }).click()
    // Closed as soon as it was kept: no wait for an answer.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(Date.now() - started).toBeLessThan(ANSWER_WAIT_MS)

    await expect(groupHeading(page, '1 job not sent yet')).toBeVisible()
    await expect(card(page, 'Arthur Wellard')).toContainText('Not sent yet')
    expect(await bookingsOnPhone(page)).toEqual([
      expect.objectContaining({ state: 'waiting', attempts: 0 }),
    ])

    // From the phone's own storage, with the page served by the worker.
    await page.reload()
    await expect(groupHeading(page, '1 job not sent yet')).toBeVisible()
    await expect(card(page, 'Arthur Wellard')).toContainText('Not sent yet')
    before = await offsetInGroup(page, '1 job not sent yet', 'Arthur Wellard')
    expect(before).not.toBeNull()
  } finally {
    await context.setOffline(false)
  }

  // Back: the slot becomes the job, Pending with its number, where it was.
  const arthur = card(page, 'Arthur Wellard')
  await expect(arthur).toContainText('Pending', { timeout: 30_000 })
  await expect(arthur).toContainText(/#\d+/)
  await expect(arthur).not.toContainText('Not sent yet')
  await expect(
    page.getByRole('button', { name: /Arthur Wellard/ }),
  ).toHaveCount(1)
  await expect(groupHeading(page, 'Sent')).toBeVisible()
  // Where it was in its own group: as far below the group's heading, which
  // now reads Sent. Measured from the heading, not the page: offline every
  // card's forecast is a placeholder, and back online a forecast lands at the
  // placeholder's height, but a lookup that fails lands as "No forecast",
  // which is shorter, and the day's cards above the group (Beatrice, Cedric)
  // shrink, moving the whole group up. Not its height either: Arthur's own
  // forecast lands too, so its card can legitimately shrink like theirs.
  await expect
    .poll(() => offsetInGroup(page, 'Sent', 'Arthur Wellard'))
    .toBeCloseTo(before!, 1)
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(1)

  // A day tapped and back: the day drawn afresh, the job in its time order.
  // The next, or the one before on a Sunday: the strip shows Monday to Sunday.
  const otherDay = addDaysToKey(
    day,
    day === addDaysToKey(startOfWeekKey(day), 6) ? -1 : 1,
  )
  await page.getByRole('button', { name: otherDay, exact: true }).click()
  await expect(dayHeading(page, otherDay)).toBeVisible()
  await page.getByRole('button', { name: day, exact: true }).click()
  await expect(dayHeading(page, day)).toBeVisible()
  await expect(groupHeading(page, /not sent yet|Sent/)).toHaveCount(0)
  const names = await page
    .getByRole('button', {
      name: /Beatrice Byford|Arthur Wellard|Cedric Coolbellup/,
    })
    .allTextContents()
  expect(
    names.map((text) =>
      ['Beatrice Byford', 'Arthur Wellard', 'Cedric Coolbellup'].find((n) =>
        text.includes(n),
      ),
    ),
  ).toEqual(['Beatrice Byford', 'Arthur Wellard', 'Cedric Coolbellup'])
})

test('a new client booked with no signal: once back, one client, one site, one job, one number', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-new-client')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  try {
    await newJobButton(page).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('radio', { name: 'New client' }).click()
    await sheet.getByLabel('Client name').fill('Daphne Dalkeith')
    await sheet.getByLabel('Street address').fill('4 Waratah Ave')
    await sheet.getByLabel('Suburb').fill('Dalkeith')
    await sheet.getByLabel('Postcode').fill('6009')
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    // Offline the checks answer at once, and the street check gives up
    // without a word, so this normally books on the first press; should a
    // warning show instead, "Book anyway" books it as typed. Either way the
    // sheet closes once it is kept.
    const anyway = sheet.getByRole('button', { name: 'Book anyway' })
    await expect(async () => {
      if (
        (await page.getByRole('dialog').count()) > 0 &&
        (await anyway.isVisible())
      ) {
        // Briefly: gone under it, the next round looks again.
        await anyway.click({ timeout: 2_000 })
      }
      expect(await page.getByRole('dialog').count()).toBe(0)
    }).toPass({ timeout: 15_000 })
    await expect(card(page, 'Daphne Dalkeith')).toContainText('Not sent yet')
  } finally {
    await context.setOffline(false)
  }

  await expect(card(page, 'Daphne Dalkeith')).toContainText('Pending', {
    timeout: 30_000,
  })
  const jobs = await jobsFor(s, 'Daphne Dalkeith', day)
  expect(jobs).toHaveLength(1)
  expect(jobs[0].jobNumber).toEqual(expect.any(Number))
  const directory = await s.owner.client.query(api.clients.directory, {
    businessId: s.businessId,
  })
  const clients = directory.clients.filter((c) => c.name === 'Daphne Dalkeith')
  expect(clients).toHaveLength(1)
  expect(
    directory.sites.filter((site) => site.clientId === clients[0]._id),
  ).toHaveLength(1)
  // Sent by the sender, not the sheet (it closed as kept): the booking stays
  // on the phone as sent, with its job, for SENT_KEEP_MS (10 minutes,
  // src/lib/outbox/outboxSet.ts) so its card has time to land, and the
  // sender's tidy deletes it after that.
  await expect
    .poll(() => bookingsOnPhone(page))
    .toEqual([
      expect.objectContaining({
        state: 'sent',
        result: expect.objectContaining({ id: jobs[0]._id }),
        sentAt: expect.any(Number),
      }),
    ])
})

test('booked with signal: closed inside the wait as before, keyed, and on the phone as sent until SENT_KEEP_MS', async ({
  page,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-online')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)

  const sheet = await openNewJob(page)
  await chooseProperty(page, sheet, 'Arthur', /Arthur Wellard/)
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  const started = Date.now()
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0, {
    timeout: ANSWER_WAIT_MS,
  })
  expect(Date.now() - started).toBeLessThan(ANSWER_WAIT_MS + KEEP_WAIT_MS)
  await expect(card(page, 'Arthur Wellard')).toContainText('Pending')
  // In the day's list as it always was: no group under it, at any point,
  // and the job drawn once.
  await expect(groupHeading(page, /not sent yet|sending|Sent/)).toHaveCount(0)
  await expect(page.getByText('Not sent yet', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Sending…', { exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /Arthur Wellard/ }),
  ).toHaveCount(1)
  await page.waitForTimeout(1_000)
  await expect(groupHeading(page, /not sent yet|sending|Sent/)).toHaveCount(0)
  const jobs = await jobsFor(s, 'Arthur Wellard', day)
  expect(jobs).toHaveLength(1)
  expect(jobs[0].clientRequestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  // Sent by the sheet's own send, which deletes nothing either: the booking
  // stays on the phone as sent, with its job, for SENT_KEEP_MS (10 minutes,
  // src/lib/outbox/outboxSet.ts), and the sender's tidy deletes it after
  // that.
  await expect
    .poll(() => bookingsOnPhone(page))
    .toEqual([
      expect.objectContaining({
        state: 'sent',
        result: expect.objectContaining({ id: jobs[0]._id }),
        sentAt: expect.any(Number),
      }),
    ])
})

test('refused inside the wait with signal: FormAlert as before, nothing left on the phone, and a retry books once', async ({
  page,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-refused')
  await s.owner.client.mutation(api.team.remove, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
  })
  await refuseFirstBooking(page, s.subMembershipId)
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)

  const sheet = await bookArthur(page)
  await expect(
    sheet.getByText(
      'Could not book this job: someone on it is no longer on the team. Choose someone else under Assigned to or Also going.',
    ),
  ).toBeVisible()
  await expect.poll(() => bookingsOnPhone(page)).toEqual([])
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(0)
  // Nothing of it is on the phone now, so closing the sheet asks first, as
  // it always did.
  await page.keyboard.press('Escape')
  const discard = page
    .getByRole('alertdialog')
    .filter({ hasText: 'Discard your changes?' })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: 'Keep editing' }).click()

  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => jobsFor(s, 'Arthur Wellard', day)).toHaveLength(1)
})

test('nothing can be kept (the phone’s storage never answers): no signal says to keep PestM8 open, and back online it books once', async ({
  page,
  context,
}) => {
  // Only the outbox's own database: the kept copy (`pestm8-offline`) is
  // IndexedDB too, and New Job with no signal is made from it.
  await page.addInitScript(() => {
    const realOpen = IDBFactory.prototype.open
    IDBFactory.prototype.open = function (
      this: IDBFactory,
      name: string,
      version?: number,
    ) {
      if (name !== 'pestm8-outbox') return realOpen.call(this, name, version)
      return {} as IDBOpenDBRequest
    }
  })
  const day = perthDay(0)
  const s = await business('outbox-no-storage')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  let sheet: Locator
  try {
    await newJobButton(page).click()
    sheet = page.getByRole('dialog')
    await expect(
      sheet.getByText(
        'No signal — the booking goes when you have signal. Keep PestM8 open until then.',
      ),
    ).toBeVisible()
    await chooseProperty(page, sheet, 'Arthur', /Arthur Wellard/)
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    await expect(sheet.getByRole('button', { name: 'Booking…' })).toBeVisible()
    await page.waitForTimeout(ANSWER_WAIT_MS + KEEP_WAIT_MS)
    await expect(sheet.getByRole('button', { name: 'Booking…' })).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => jobsFor(s, 'Arthur Wellard', day)).toHaveLength(1)
  await page.waitForTimeout(5_000)
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(1)
})

test('a keep that lands late (F2): booked straight, and the late row gone, with no card', async ({
  page,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-late-keep')
  const slow = await slowOutboxStore(page)
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)

  await slow()
  await bookArthur(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => jobsFor(s, 'Arthur Wellard', day)).toHaveLength(1)
  await page.waitForTimeout(LATE_OPEN_MS * 2)
  await expect.poll(() => bookingsOnPhone(page)).toEqual([])
  await expect(page.getByText('Not sent yet', { exact: true })).toHaveCount(0)
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(1)
})

test('a keep that lands late, and the booking refused: FormAlert, ✕, and a minute on, nothing booked and nothing on the phone', async ({
  page,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-late-refused')
  await s.owner.client.mutation(api.team.remove, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
  })
  const slow = await slowOutboxStore(page)
  await refuseFirstBooking(page, s.subMembershipId)
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)

  await slow()
  const sheet = await bookArthur(page)
  await expect(
    sheet.getByText(
      'Could not book this job: someone on it is no longer on the team. Choose someone else under Assigned to or Also going.',
    ),
  ).toBeVisible()
  // Nothing of it was kept: closing asks first.
  await sheet.getByRole('button', { name: 'Close' }).click()
  const discard = page
    .getByRole('alertdialog')
    .filter({ hasText: 'Discard your changes?' })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.waitForTimeout(60_000)
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(0)
  expect(await bookingsOnPhone(page)).toEqual([])
})

test('with no signal and nothing of it on the phone, New Job says so rather than wait for good', async ({
  page,
  context,
}) => {
  const s = await business('outbox-not-on-phone')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, perthDay(0))
  await keepPageInWorker(page)
  // No copy of anything on the phone: only the page the worker keeps, which
  // carries the day and the team, never the client list.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const gone = indexedDB.deleteDatabase('pestm8-offline')
        gone.onsuccess = () => resolve()
        gone.onerror = () => resolve()
        gone.onblocked = () => resolve()
      }),
  )
  await context.setOffline(true)
  try {
    await page.reload()
    await expect(newJobButton(page)).toBeEnabled()
    await newJobButton(page).click()
    const sheet = page.getByRole('dialog')
    await expect(
      sheet.getByText('New Job isn’t on this phone yet'),
    ).toBeVisible()
    await expect(
      sheet.getByText(
        'It needs the client list and the team, which this phone doesn’t have yet. It opens when you have signal.',
      ),
    ).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})

// ── The booking's own sheet (plan part 2c, PR 2c-E) ────────────────────────
//
// A booking on the phone opened from its card: what it says of itself, its
// fix and Discard. A booking's age, or its first visit's, is moved by
// rewriting the booking the phone stored, never `page.clock`: the server's
// clock can't be moved with it, and a page three days ahead of it would hold
// every sign-in token as long expired.

/** One Book of New Job with no signal, kept on the phone: Arthur Wellard's
 * site, General Pest Control, for `assignee` if given, repeating if asked. */
async function bookArthurOffline(
  page: Page,
  options: { assignee?: string; repeats?: boolean } = {},
) {
  const sheet = await openNewJob(page)
  await chooseProperty(page, sheet, 'Arthur', /Arthur Wellard/)
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  if (options.assignee) {
    await sheet.getByLabel('Assigned to').selectOption(options.assignee)
  }
  if (options.repeats) {
    await sheet.getByRole('radio', { name: 'Recurring Job' }).click()
  }
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => bookingsOnPhone(page)).toHaveLength(1)
}

/** The one booking the phone holds, rewritten in its storage: when it was
 * saved, and when it is for. Read by the page once it reloads. */
async function rewriteBooking(
  page: Page,
  change: { createdAt?: number; scheduledAt?: number },
) {
  await page.evaluate(async (next) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('pestm8-outbox')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error ?? new Error('no db'))
    })
    try {
      const store = db.transaction('items', 'readwrite').objectStore('items')
      const all = await new Promise<Array<Record<string, unknown>>>(
        (resolve, reject) => {
          const read = store.getAll()
          read.onsuccess = () =>
            resolve(read.result as Array<Record<string, unknown>>)
          read.onerror = () => reject(read.error ?? new Error('no read'))
        },
      )
      for (const item of all) {
        const booking = item.booking as Record<string, unknown>
        store.put({
          ...item,
          ...(next.createdAt !== undefined && { createdAt: next.createdAt }),
          booking: {
            ...booking,
            ...(next.scheduledAt !== undefined && {
              scheduledAt: next.scheduledAt,
            }),
          },
        })
      }
      await new Promise<void>((resolve, reject) => {
        store.transaction.oncomplete = () => resolve()
        store.transaction.onerror = () =>
          reject(store.transaction.error ?? new Error('no write'))
      })
    } finally {
      db.close()
    }
  }, change)
}

/**
 * Waits for the sender, back with signal, to find the phone's one booking
 * needs a look, then draws the page afresh. Today's group takes another
 * day's booking in only as needing a look, and a booking that comes to need
 * one after a day was drawn empty is left for the next draw (plan §9.3: no
 * card replaces "This day is clear." after ADD_AFTER_DRAW_MS), as the
 * sender can only look once the line and access:me are live, which is after
 * the first draw.
 */
async function needsLookAtFirstDraw(page: Page) {
  await expect
    .poll(async () => (await bookingsOnPhone(page)).map((b) => b.state), {
      timeout: 30_000,
    })
    .toEqual(['needsLook'])
  await page.reload()
}

/** The booking's sheet, opened from its card. */
async function openItem(page: Page, clientName: string): Promise<Locator> {
  await card(page, clientName).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toHaveCount(1)
  return sheet
}

/** New Job over a booking's sheet, opened by its Edit. */
const editSheet = (page: Page) =>
  page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'New job' }) })

/** Recurring Jobs on the server, for Arthur Wellard. */
async function seriesForArthur(s: Business) {
  const all = await s.owner.client.query(api.recurrences.listForBusiness, {
    businessId: s.businessId,
  })
  return all.filter((r) => JSON.stringify(r).includes('Arthur Wellard'))
}

test('the answer lost: “Sending…”, locked, not to be booked again; a new page settles it as the one job', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-lost')
  // Every frame from the server dropped once `jobs:create` has gone: the
  // booking went, and nothing ever says so.
  let sent = false
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws: WebSocketRoute) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        if (typeof message === 'string' && message.includes('"jobs:create"')) {
          sent = true
        }
        server.send(message)
      })
      server.onMessage((message) => {
        if (!sent) ws.send(message)
      })
    },
  )
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await bookArthur(page)
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 })
  await expect(card(page, 'Arthur Wellard')).toContainText('Sending…')
  const sheet = await openItem(page, 'Arthur Wellard')
  await expect(sheet.getByRole('button', { name: 'Edit' })).toBeDisabled()
  await expect(sheet.getByRole('button', { name: 'Discard' })).toBeDisabled()
  const [{ localId, lastAttemptAt }] = await bookingsOnPhone(page)
  await page.close()

  // A new page, the line whole: the booking from an earlier page says not to
  // book it again until PestM8 says, then settles as the one job it made.
  // Opened by its address: the day's list has the job it made already, which
  // carries its request id, so its card is the job's.
  const next = await context.newPage()
  await next.goto(`/${s.slug}/schedule?date=${day}&outboxId=${localId}`)
  const again = next.getByRole('dialog')
  // That line is drawn only until the sender settles it, SETTLE_MIN_AGE_MS
  // after it went, and a loaded machine can take most of that to get here:
  // looked for while there is time to draw it, never raced against the
  // settle, which the rest of the test sees either way.
  const left = (lastAttemptAt ?? 0) + SETTLE_MIN_AGE_MS - Date.now()
  if (left > 12_000) {
    await expect(again).toContainText(
      'It was sent and PestM8 hasn’t answered yet, so it may already be booked. Don’t book it again',
      { timeout: left - 5_000 },
    )
    await expect(again.getByRole('button', { name: 'Edit' })).toBeDisabled()
  } else {
    test.info().annotations.push({
      type: 'note',
      description: `Reached the new page ${Math.round(-left / 1000) + 30} s after the send: its line wasn't looked for.`,
    })
  }
  // Settled with `find` 30 s after it went (SETTLE_MIN_AGE_MS): the sheet
  // becomes its job's.
  await expect(again).toContainText(/Job #\d+/, { timeout: 60_000 })
  await expect(again).not.toContainText('Not sent yet')
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(1)
})

test('needs a look after an offline booking for someone removed meanwhile: Edit, someone else, Book; one job, theirs', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-look')
  const third = await signUpActor(
    uniqueEmail('third-outbox-look'),
    FIXTURE_PASSWORD,
    'Wendy',
  )
  await inviteAndJoin(s.owner, third, s.businessId)
  const members = await s.owner.client.query(api.memberships.listForBusiness, {
    businessId: s.businessId,
  })
  const wendy = members.find((m) => m.email === third.email)!._id
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page, { assignee: s.subMembershipId })
    await s.owner.client.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.subMembershipId,
    })
  } finally {
    await context.setOffline(false)
  }

  await expect(card(page, 'Arthur Wellard')).toContainText('Needs a look', {
    timeout: 30_000,
  })
  const sheet = await openItem(page, 'Arthur Wellard')
  await expect(sheet).toContainText(
    'Could not book this job: someone on it is no longer on the team.',
  )
  await sheet.getByRole('button', { name: 'Edit' }).click()
  const edit = editSheet(page)
  await expect(edit.getByRole('button', { name: 'Book job' })).toBeEnabled()
  await edit.getByLabel('Assigned to').selectOption(wendy)
  await edit.getByRole('button', { name: 'Book job' }).click()
  await expect(editSheet(page)).toHaveCount(0, { timeout: 15_000 })
  await expect
    .poll(() => jobsFor(s, 'Arthur Wellard', day), { timeout: 30_000 })
    .toEqual([expect.objectContaining({ assignedMembershipId: wendy })])
})

test('a Recurring Job whose first visit went by before it was sent: needs a look before any send; Change the date books its first visit; one a week back goes as online', async ({
  page,
  context,
}) => {
  skipNearPerthMidnight('today’s group is the page’s own today')
  const day = perthDay(0)
  const s = await business('outbox-late-series')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page, { repeats: true })
    // Booked for an hour before it was saved, and sent 25 h on.
    const now = Date.now()
    await rewriteBooking(page, {
      scheduledAt: now - 25 * HOUR,
      createdAt: now - 24 * HOUR,
    })
  } finally {
    await context.setOffline(false)
  }
  await page.reload()
  await needsLookAtFirstDraw(page)
  // Another day's, needing a look: in today's group too (D13).
  await expect(card(page, 'Arthur Wellard')).toContainText('Needs a look', {
    timeout: 30_000,
  })
  const sheet = await openItem(page, 'Arthur Wellard')
  await expect(sheet).toContainText(
    /Could not book this job: its first visit, .* went by before it was sent\. Change the start date to book it\./,
  )
  expect(await seriesForArthur(s)).toHaveLength(0)
  await sheet.getByRole('button', { name: 'Change the date' }).click()
  const edit = editSheet(page)
  await expect(edit.getByLabel('Date')).toBeFocused()
  await edit.getByLabel('Date').fill(day)
  await edit.getByRole('button', { name: 'Book job' }).click()
  await expect
    .poll(() => seriesForArthur(s), { timeout: 30_000 })
    .toHaveLength(1)
  await expect
    .poll(() => jobsFor(s, 'Arthur Wellard', day), { timeout: 30_000 })
    .toHaveLength(1)
})

test('a Recurring Job saved with its start a week back already: booked as online would, no first visit, never needing a look', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-week-back')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page, { repeats: true })
    await rewriteBooking(page, { scheduledAt: perthAt(perthDay(-7), 9) })
    // Still with no signal, so the new page is the one that sends it. Back
    // online first, this page can send it as it unloads, and the new page's
    // sweep then takes the sent row.
    await page.reload()
  } finally {
    await context.setOffline(false)
  }
  await expect
    .poll(() => seriesForArthur(s), { timeout: 30_000 })
    .toHaveLength(1)
  expect(await jobsFor(s, 'Arthur Wellard', perthDay(-7))).toHaveLength(0)
  await expect
    .poll(async () => (await bookingsOnPhone(page)).map((b) => b.state))
    .toEqual(['sent'])
  await expect(page.getByText('Needs a look')).toHaveCount(0)
})

test('kept with no signal for three days: needs a look before any send, and Send books it once', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-stale')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page)
    // Three days, as the owner set it (STALE_AFTER_MS), and an hour on.
    await rewriteBooking(page, { createdAt: Date.now() - 73 * HOUR })
  } finally {
    await context.setOffline(false)
  }
  await page.reload()
  await expect(card(page, 'Arthur Wellard')).toContainText('Needs a look', {
    timeout: 30_000,
  })
  const sheet = await openItem(page, 'Arthur Wellard')
  await expect(sheet).toContainText(
    /Saved on this phone on .* and not sent\. Send it now, or discard it\./,
  )
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(0)
  await sheet.getByRole('button', { name: 'Send' }).click()
  await expect(sheet).toContainText(/Job #\d+/, { timeout: 30_000 })
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(1)
})

test('Discard: asked first, then gone from the phone, and nothing booked once back', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-discard')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page)
    const sheet = await openItem(page, 'Arthur Wellard')
    await sheet.getByRole('button', { name: 'Discard' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('Discard this job?')
    await expect(confirm).toContainText(
      'It hasn’t been sent, so it’s only on this phone. This can’t be undone.',
    )
    await confirm.getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(card(page, 'Arthur Wellard')).toHaveCount(0)
    await expect.poll(() => bookingsOnPhone(page)).toEqual([])
  } finally {
    await context.setOffline(false)
  }
  await expect(newJobButton(page)).toBeEnabled()
  await page.waitForTimeout(5_000)
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(0)
})

test('Edit while it waits with no signal: the time changed on the phone, and once back one job at the new time', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-edit')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page)
    const sheet = await openItem(page, 'Arthur Wellard')
    await sheet.getByRole('button', { name: 'Edit' }).click()
    const edit = editSheet(page)
    await expect(edit.getByRole('button', { name: 'Book job' })).toBeEnabled()
    await edit.getByLabel('Start').fill('11:00')
    await edit.getByRole('button', { name: 'Book job' }).click()
    await expect(editSheet(page)).toHaveCount(0)
    await expect(sheet).toContainText('Not sent yet')
    await expect(sheet).toContainText('11:00')
  } finally {
    await context.setOffline(false)
  }
  await expect
    .poll(() => jobsFor(s, 'Arthur Wellard', day), { timeout: 30_000 })
    .toEqual([expect.objectContaining({ scheduledAt: perthAt(day, 11) })])
})

test('a Recurring Job of another day needing a look, opened from today’s group: once fixed the sheet lands on its first visit', async ({
  page,
  context,
}) => {
  skipNearPerthMidnight('today’s group is the page’s own today')
  const day = perthDay(0)
  const s = await business('outbox-handover')
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page, {
      assignee: s.subMembershipId,
      repeats: true,
    })
    await rewriteBooking(page, { scheduledAt: perthAt(perthDay(2), 9) })
    await s.owner.client.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.subMembershipId,
    })
  } finally {
    await context.setOffline(false)
  }
  await page.reload()
  await needsLookAtFirstDraw(page)
  // In today's group with its date, as it needs a look.
  await expect(card(page, 'Arthur Wellard')).toContainText('Needs a look', {
    timeout: 30_000,
  })
  const sheet = await openItem(page, 'Arthur Wellard')
  await sheet.getByRole('button', { name: 'Edit' }).click()
  const edit = editSheet(page)
  // Nobody left to choose but the owner: the form has them already.
  await expect(edit.getByText('Assigned to you')).toBeVisible()
  await edit.getByRole('button', { name: 'Book job' }).click()
  // The first visit's own sheet, in the same one.
  await expect(page.getByRole('dialog')).toContainText(/Job #\d+/, {
    timeout: 30_000,
  })
  await expect(page.getByRole('dialog')).not.toContainText('Needs a look')
  await expect(page).toHaveURL(/jobId=/)
  await expect(page).not.toHaveURL(/outboxId=/)
  expect(await jobsFor(s, 'Arthur Wellard', perthDay(2))).toHaveLength(1)
})

// ── Leaving, and where else they are said (plan part 2c, PR 2c-F) ─────────
//
// Signing out and switching business ask first about the bookings on the
// phone not sent yet (`OutboxLeaveGuard`); the sign-in screens say whose are
// there; the notice, SwitchBanner and the switcher say they wait. The server
// is moved only through its own functions, or Better Auth's endpoints, as
// the page or a laptop would move it.

/** The app, as fixtures.ts reaches it. */
const SITE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

/** Whose the phone's bookings are (its `owner` row), or null with none. */
async function ownerOnPhone(
  page: Page,
): Promise<{ userId: string; firstName: string } | null> {
  return page
    .evaluate(async () => {
      const names = await indexedDB.databases()
      if (!names.some((db) => db.name === 'pestm8-outbox')) return null
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('pestm8-outbox')
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error ?? new Error('no db'))
      })
      try {
        if (!db.objectStoreNames.contains('owner')) return null
        const read = db.transaction('owner').objectStore('owner').get('owner')
        return await new Promise<{ userId: string; firstName: string } | null>(
          (resolve) => {
            read.onsuccess = () =>
              resolve(
                (read.result as
                  { userId: string; firstName: string } | undefined) ?? null,
              )
            read.onerror = () => resolve(null)
          },
        )
      } finally {
        db.close()
      }
    })
    .catch(() => null)
}

/** The businesses of the bookings on the phone, each with its state. */
async function businessesOnPhone(
  page: Page,
): Promise<Array<{ businessId: string; state: string }>> {
  const all = (await bookingsOnPhone(page)) as Array<
    StoredBooking & { businessId: string }
  >
  return all.map(({ businessId, state }) => ({ businessId, state }))
}

/**
 * Every `jobs:create` the page's Convex sockets send (or the whole
 * context's), its frame kept, and dropped while `hold` is on: the booking
 * goes nowhere, and nothing answers it. Each refusal the server sends back
 * for being in someone else's account is noted too, by when.
 */
async function bookingCalls(target: Page | BrowserContext) {
  const calls = {
    hold: false,
    sent: [] as Array<string>,
    refused: [] as Array<number>,
  }
  await target.routeWebSocket(
    (url) => url.host === convexHost,
    (ws: WebSocketRoute) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        if (typeof message === 'string' && message.includes('"jobs:create"')) {
          calls.sent.push(message)
          if (calls.hold) return
        }
        server.send(message)
      })
      server.onMessage((message) => {
        if (
          typeof message === 'string' &&
          message.includes('"MutationResponse"') &&
          /NOT_OWN_ACCOUNT|SWITCH_[A-Z_]+/.test(message)
        ) {
          calls.refused.push(Date.now())
        }
        ws.send(message)
      })
    },
  )
  return calls
}

/** A Convex client for the Better Auth session behind `cookie`, traded at
 * /api/auth/convex/token as the page and fixtures.ts trade it. */
async function clientFor(cookie: string): Promise<ConvexHttpClient> {
  const res = await fetch(`${SITE}/api/auth/convex/token`, {
    headers: { cookie, origin: SITE },
  })
  expect(res.ok).toBe(true)
  const { token } = (await res.json()) as { token?: string }
  expect(token).toBeTruthy()
  const client = new ConvexHttpClient(process.env.VITE_CONVEX_URL!)
  client.setAuth(token!)
  return client
}

/** A session of `email`'s own, signed in over HTTP as a laptop would: its
 * cookie. */
async function signInOverHttp(email: string): Promise<string> {
  const res = await fetch(`${SITE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE },
    body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
  })
  expect(res.ok).toBe(true)
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  expect(cookie).not.toBe('')
  return cookie
}

/** `actor` signed in afresh: the fixture's own session goes when every one
 * of theirs is revoked, or when they leave their last business. */
async function signedInAgain(actor: Actor): Promise<Actor> {
  return {
    email: actor.email,
    client: await clientFor(await signInOverHttp(actor.email)),
  }
}

/** Every session of `email`'s ended on the server, as a password changed on
 * a laptop ends them: signed in over HTTP, then all of them revoked (Better
 * Auth's /revoke-sessions). */
async function endSessionsOf(email: string) {
  const cookie = await signInOverHttp(email)
  const res = await fetch(`${SITE}/api/auth/revoke-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE, cookie },
    body: '{}',
  })
  expect(res.ok).toBe(true)
}

/**
 * A Convex client signed in as the page's own session: its cookies traded
 * for a token, as the page trades them. A switch of account it starts is
 * the page's session's, since a switch is kept per session.
 */
async function asThePage(context: BrowserContext): Promise<ConvexHttpClient> {
  const cookie = (await context.cookies(SITE))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
  return clientFor(cookie)
}

/** The schedule on `day`, its page kept in the worker and the kept copy
 * written, for New Job with no signal. */
async function readyOffline(page: Page, slug: string, day: string) {
  await openSchedule(page, slug, day)
  await keepPageInWorker(page)
  await waitForKeptCopy(page)
}

/** Settings' Sign out, once the page can act on it. */
async function pressSignOut(page: Page) {
  const button = page.getByRole('button', { name: 'Sign out', exact: true })
  await expect(button).toBeEnabled()
  await button.click()
}

/**
 * The business switcher in the sidebar (a desktop's), opened on `current`.
 * Its list stays open after a switch (the shell isn't drawn again for the
 * new business, nor does a row's link close it) and under the switch's
 * question, and a press on its button closes an open list: so it is pressed
 * only while the list is shut.
 */
async function openSwitcher(page: Page, current: string) {
  const trigger = page
    .getByRole('button', { name: new RegExp(current) })
    .first()
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click()
  }
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
}

const DESKTOP = { width: 1280, height: 900 }
const PHONE = { width: 390, height: 844 }

test('sign out with a booking on the phone: asked first; Stay keeps it; Discard leaves nothing, and nothing comes back on signing in again', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-signout')
  await signInViaUi(page, s.owner.email)
  await readyOffline(page, s.slug, day)

  // Kept three days, so it waits for a look and isn't sent once back; read
  // afresh with no signal, so nothing goes as the page unloads.
  await context.setOffline(true)
  try {
    await bookArthurOffline(page)
    await rewriteBooking(page, { createdAt: Date.now() - 73 * HOUR })
    await page.reload()
    await expect(newJobButton(page)).toBeEnabled()
  } finally {
    await context.setOffline(false)
  }
  await expect(card(page, 'Arthur Wellard')).toContainText('Needs a look', {
    timeout: 30_000,
  })

  await page.goto(`/${s.slug}/settings`)
  await pressSignOut(page)
  const asked = page.getByRole('alertdialog')
  await expect(asked).toContainText('Sign out and discard 1 job not sent yet?')
  await expect(asked).toContainText('It’s only on this phone.')
  await asked.getByRole('button', { name: 'Stay signed in' }).click()
  await expect(asked).toHaveCount(0)
  await expect(page).toHaveURL(/\/settings/)
  expect(await bookingsOnPhone(page)).toHaveLength(1)

  await pressSignOut(page)
  await asked.getByRole('button', { name: 'Discard and sign out' }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect.poll(() => bookingsOnPhone(page)).toEqual([])
  await expect.poll(() => ownerOnPhone(page)).toBeNull()
  // Nothing for the sign-in screen to say.
  await expect(page.getByText(/on this phone not sent yet/)).toHaveCount(0)

  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug, day)
  await expect(card(page, 'Arthur Wellard')).toHaveCount(0)
  expect(await bookingsOnPhone(page)).toEqual([])
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(0)
})

test('a session ended elsewhere: the sign-in screen says whose booking is on the phone; signing in as someone else drops it', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-ended')
  // Nothing this page sends is let through: the line coming back wakes the
  // sender before the page has heard the session ended, and what a send
  // meets then (the server refuses an ended session) isn't what this test is
  // about. The booking must still be on the phone at the sign-in screen.
  const calls = await bookingCalls(page)
  calls.hold = true
  await signInViaUi(page, s.owner.email)
  await readyOffline(page, s.slug, day)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page)
    // A password changed on a laptop: every session of Terence's ended.
    await endSessionsOf(s.owner.email)
  } finally {
    await context.setOffline(false)
  }
  // The page finds out by itself, as a phone does: Better Auth asks again
  // when the page comes back on screen (at most every 5 s), and the ended
  // session sends it to the sign-in screen (SessionWatch).
  await expect
    .poll(
      async () => {
        await page
          .evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
          .catch(() => undefined)
        return new URL(page.url()).pathname
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe('/login')
  // Kept, marked as having outlived its session: it goes only once Terence
  // has looked at it.
  await expect
    .poll(async () => (await bookingsOnPhone(page))[0]?.sessionEndedAt ?? null)
    .toEqual(expect.any(Number))
  await expect(
    page.getByText(
      'Terence has 1 job on this phone not sent yet. It’s kept until Terence signs in again and sends it. Signing in as anyone else discards it.',
    ),
  ).toBeVisible()

  await signInViaUi(page, s.sub.email)
  await expect.poll(() => bookingsOnPhone(page)).toEqual([])
  const owner = await signedInAgain(s.owner)
  expect(await jobsFor({ ...s, owner }, 'Arthur Wellard', day)).toHaveLength(0)
})

/**
 * The owner's booking, kept with no signal, and then Kevin's account switched
 * into from the page's own session while its line was still down: the same
 * as a switch made in another tab before the sender's next wake, without
 * racing it (the plan's "an offline item kept while the line is down").
 */
async function switchedWithBooking(
  page: Page,
  context: BrowserContext,
  s: Business,
  day: string,
) {
  await signInViaUi(page, s.owner.email)
  await readyOffline(page, s.slug, day)
  await context.setOffline(true)
  try {
    await bookArthurOffline(page)
    const asPage = await asThePage(context)
    await asPage.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.subMembershipId,
    })
  } finally {
    await context.setOffline(false)
  }
  await expect(page.getByText('Working in Kevin’s account')).toBeVisible({
    timeout: 30_000,
  })
}

test('switched into someone else’s account: the booking is held, the banner says so, and once switched back it is booked as the owner’s', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-switched')
  await switchedWithBooking(page, context, s, day)

  await expect(
    page.getByText(
      '1 of your jobs isn’t sent yet. It goes when you switch back.',
    ),
  ).toBeVisible()
  await page.waitForTimeout(5_000)
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(0)
  expect((await bookingsOnPhone(page)).map((b) => b.state)).toEqual(['waiting'])

  await clickUntil(page.getByRole('button', { name: 'Switch back' }), () =>
    expect(page.getByText('Working in Kevin’s account')).toHaveCount(0, {
      timeout: 5_000,
    }),
  )
  await expect
    .poll(() => jobsFor(s, 'Arthur Wellard', day), { timeout: 30_000 })
    .toHaveLength(1)
  const [job] = await jobsFor(s, 'Arthur Wellard', day)
  // Booked as Terence himself: a job is put in the history only when it
  // was booked in someone else's account (convex/lib/audit.ts
  // `recordOnBehalf`), so there is nothing there.
  const history = await s.owner.client.query(api.auditLog.forEntity, {
    businessId: s.businessId,
    entityType: 'jobs',
    entityId: job._id,
  })
  expect(history).toEqual([])
})

/**
 * A switch that ends by itself while its row still stands, so it reads as
 * degraded rather than gone (plan S7, F7). Neither of the owner's can: the
 * owner may work in anyone's account, so theirs ends only when its twelve
 * hours do, and taking someone off the team deletes every switch naming them
 * (convex/team.ts `offboard`), which reads as no switch at all. A
 * contractor's into their own crew ends the moment the crew member is moved
 * off it: the row stands, and `access.me` reads it as SWITCH_TEAM_CHANGED
 * until the banner stops it.
 *
 * So Kevin runs a crew of one, Mia. His booking is kept with no signal, and
 * Mia's account switched into from the page's own session while the line
 * is still down, as `switchedWithBooking` does for the owner.
 */
async function crewSwitchWithBooking(
  page: Page,
  context: BrowserContext,
  s: Business,
  day: string,
) {
  await s.owner.client.mutation(api.memberships.setRole, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    role: 'contractor',
  })
  const mia = await signUpActor(
    uniqueEmail('mia-outbox-degraded'),
    FIXTURE_PASSWORD,
    'Mia',
  )
  await inviteAndJoin(s.owner, mia, s.businessId)
  const members = await s.owner.client.query(api.memberships.listForBusiness, {
    businessId: s.businessId,
  })
  const miaMembershipId = members.find((m) => m.email === mia.email)!._id
  await s.owner.client.mutation(api.team.assignTo, {
    businessId: s.businessId,
    membershipId: miaMembershipId,
    parentMembershipId: s.subMembershipId,
  })

  await signInViaUi(page, s.sub.email)
  await readyOffline(page, s.slug, day)
  await context.setOffline(true)
  try {
    await bookArthurOffline(page)
    const asPage = await asThePage(context)
    await asPage.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: miaMembershipId,
    })
  } finally {
    await context.setOffline(false)
  }
  await expect(page.getByText('Working in Mia’s account')).toBeVisible({
    timeout: 30_000,
  })
  return miaMembershipId
}

test('a switch that ends by itself (Mia moved off Kevin’s crew): no send loop, and the booking goes once the banner has ended it', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-degraded')
  const calls = await bookingCalls(page)
  const miaMembershipId = await crewSwitchWithBooking(page, context, s, day)
  await expect(
    page.getByText(
      '1 of your jobs isn’t sent yet. It goes when you switch back.',
    ),
  ).toBeVisible()

  // Mia back under Terence: Kevin's switch still stands, and reads as
  // degraded until the banner stops it, and says why.
  await s.owner.client.mutation(api.team.assignTo, {
    businessId: s.businessId,
    membershipId: miaMembershipId,
    parentMembershipId: null,
  })
  await expect(
    page.getByText(
      'You have moved teams, so you are back in your own account.',
    ),
  ).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => jobsFor(s, 'Arthur Wellard', day), { timeout: 60_000 })
    .toHaveLength(1)
  // Kevin's own, as he booked it: never Mia's.
  expect(await jobsFor(s, 'Arthur Wellard', day)).toEqual([
    expect.objectContaining({ assignedMembershipId: s.subMembershipId }),
  ])
  // Held while the switch stood, never sent into it over and over: at most
  // one refusal in any 30 s.
  for (let i = 1; i < calls.refused.length; i++) {
    expect(calls.refused[i] - calls.refused[i - 1]).toBeGreaterThanOrEqual(
      30_000,
    )
  }
  expect(calls.refused.length).toBeLessThanOrEqual(1)
})

test('two tabs, one booking: both back online, one job, its request sent at most twice', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-two-tabs')
  const calls = await bookingCalls(context)
  await signInViaUi(page, s.owner.email)
  await readyOffline(page, s.slug, day)
  const other = await context.newPage()
  await openSchedule(other, s.slug, day)

  await context.setOffline(true)
  let requestId = ''
  try {
    await bookArthurOffline(page)
    requestId = (await bookingsOnPhone(page))[0].requestId
  } finally {
    await context.setOffline(false)
  }
  await expect
    .poll(() => jobsFor(s, 'Arthur Wellard', day), { timeout: 30_000 })
    .toHaveLength(1)
  await page.waitForTimeout(10_000)
  const jobs = await jobsFor(s, 'Arthur Wellard', day)
  expect(jobs).toHaveLength(1)
  expect(jobs[0].clientRequestId).toBe(requestId)
  // One send, and at most one repeat of it, which its key books once.
  const sends = calls.sent.filter((frame) => frame.includes(requestId))
  expect(sends.length).toBeGreaterThanOrEqual(1)
  expect(sends.length).toBeLessThanOrEqual(2)
})

test('PestM8 not answering with a booking on the phone: the notice says it goes when PestM8 answers, and Reload takes one tap', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-notice')
  // The page's socket: on, or cut and refusing, as connectionNotice.spec.ts.
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
  await signInViaUi(page, s.owner.email)
  await readyOffline(page, s.slug, day)

  await context.setOffline(true)
  try {
    cut = true
    for (const ws of open.splice(0)) void ws.close({ code: 1006 })
    await bookArthurOffline(page)
  } finally {
    await context.setOffline(false)
  }
  // Settings, which has no kept view of its own to say so in its place.
  await page.goto(`/${s.slug}/settings`)
  const notice = page.locator('[data-reach-notice="banner"]')
  await expect(notice).toContainText('Could not reach PestM8', {
    timeout: 30_000,
  })
  await expect(notice).toContainText(
    '1 job is on this phone, not sent yet. It goes when PestM8 answers.',
  )
  // A reload loses none of it, so it isn't a change waiting to save.
  await expect(notice).not.toContainText('waiting to save')
  await notice.getByRole('button', { name: 'Try again' }).click()
  const reload = notice.getByRole('button', { name: 'Reload' })
  await expect(reload).toBeVisible({ timeout: 15_000 })
  const loaded = page.waitForEvent('load')
  await reload.click()
  await loaded

  cut = false
  await expect
    .poll(() => jobsFor(s, 'Arthur Wellard', day), { timeout: 90_000 })
    .toHaveLength(1)
})

test('switching business: asked first, the booking held in the other, the switcher says so, and it goes back in its own', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-switch-a')
  const otherName = `outbox-switch-b ${Date.now()}`
  const other = await s.owner.client.mutation(api.businesses.create, {
    name: otherName,
    state: 'WA',
    timezone: TZ,
  })
  await signInViaUi(page, s.owner.email)
  await readyOffline(page, s.slug, day)

  // There and back by the switcher (a desktop's, in the sidebar), so the
  // other business is in memory and a switch to it can go with no signal.
  await page.setViewportSize(DESKTOP)
  await openSwitcher(page, s.name)
  await page.getByRole('link', { name: new RegExp(otherName) }).click()
  await expect(page).toHaveURL(new RegExp(`/${other.slug}/schedule`))
  await expect(newJobButton(page)).toBeEnabled()
  await openSwitcher(page, otherName)
  await page.getByRole('link', { name: new RegExp(s.name) }).click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/schedule`))
  await expect(newJobButton(page)).toBeEnabled()
  await page.setViewportSize(PHONE)
  await waitForKeptCopy(page)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page)
    await page.setViewportSize(DESKTOP)
    await openSwitcher(page, s.name)
    await page.getByRole('link', { name: new RegExp(otherName) }).click()
    const asked = page.getByRole('alertdialog')
    await expect(asked).toContainText('Switch with 1 job not sent yet?')
    await expect(asked).toContainText(
      `It stays on this phone and goes when you’re back in ${s.name} with signal.`,
    )
    await asked.getByRole('button', { name: 'Switch', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/${other.slug}/schedule`))
  } finally {
    await context.setOffline(false)
  }

  // Held in the other business: nothing booked, still waiting.
  await page.waitForTimeout(5_000)
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(0)
  expect((await bookingsOnPhone(page)).map((b) => b.state)).toEqual(['waiting'])
  await openSwitcher(page, otherName)
  const back = page.getByRole('link', { name: new RegExp(s.name) })
  await expect(back).toContainText('1 job not sent yet')

  // Back in its own: nothing to ask, and it goes.
  await back.click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/schedule`))
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect
    .poll(() => jobsFor(s, 'Arthur Wellard', day), { timeout: 30_000 })
    .toHaveLength(1)
})

test('offboarded with a booking on the phone: held, never booked, and gone once the business Kevin joins next lists him', async ({
  page,
  context,
}) => {
  const day = perthDay(0)
  const s = await business('outbox-offboarded')
  await signInViaUi(page, s.sub.email)
  await readyOffline(page, s.slug, day)

  await context.setOffline(true)
  try {
    await bookArthurOffline(page)
    // Kevin's only business lets him go, which ends his sessions.
    await s.owner.client.mutation(api.team.remove, {
      businessId: s.businessId,
      membershipId: s.subMembershipId,
    })
  } finally {
    await context.setOffline(false)
  }

  // He signs in again, and joins another business.
  await signInViaUi(page, s.sub.email)
  const kevin = await signedInAgain(s.sub)
  const dana = await signUpActor(
    uniqueEmail('owner-outbox-next'),
    FIXTURE_PASSWORD,
    'Dana',
  )
  const next = await dana.client.mutation(api.businesses.create, {
    name: `outbox-next ${Date.now()}`,
    state: 'WA',
    timezone: TZ,
  })
  await dana.client.mutation(api.properties.create, {
    businessId: next.businessId,
    clientName: 'Arthur Wellard',
    addressLine: '12 Wattle Street',
    suburb: 'Wellard',
    state: 'WA',
    postcode: '6170',
  })
  await inviteAndJoin(dana, kevin, next.businessId)
  await page.goto('/')
  await expect(page).toHaveURL(new RegExp(`/${next.slug}/`))
  await openSchedule(page, next.slug, day)

  // Held: a list that shows none of the memberships his bookings were saved
  // under can't yet be told apart from someone else's (sender.ts,
  // `forgetNotListed`), so it forgets nothing.
  await page.waitForTimeout(5_000)
  expect((await businessesOnPhone(page)).map((b) => b.businessId)).toEqual([
    s.businessId,
  ])
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(0)

  // His first booking in it: the list is his for certain, and the one for
  // the business that let him go is forgotten, never sent.
  await bookArthur(page)
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect
    .poll(
      async () => (await businessesOnPhone(page)).map((b) => b.businessId),
      { timeout: 60_000 },
    )
    .toEqual([next.businessId])
  expect(await jobsFor(s, 'Arthur Wellard', day)).toHaveLength(0)
})
