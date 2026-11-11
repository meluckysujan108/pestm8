import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseJobTypes,
  chooseProperty,
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
import type { Locator, Page, WebSocketRoute } from '@playwright/test'

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
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `${label} ${Date.now()}`, state: 'WA', timezone: TZ },
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
