import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseProperty,
  clickUntil,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import {
  addDaysToKey,
  startOfDayInZone,
  startOfWeekKey,
  todayKeyInZone,
} from '../convex/lib/dates'
import type { Page, WebSocketRoute } from '@playwright/test'
import type { Actor } from './fixtures'
import type { Id } from '../convex/_generated/dataModel'

/**
 * The copy of the schedule kept on the phone (src/lib/offline/): this week
 * and next, the client list, the team and the job types, so the Schedule and
 * New Job open in a backyard with no signal — and whose copy it is, so it
 * never outlives the person, the business or the view it was kept for.
 *
 * Every case first lets the service worker take the page over (as
 * licences.spec.ts does), then waits for the copy itself to be written:
 * one row per kept answer in the `pestm8-offline` database, read here
 * straight from IndexedDB. "No signal" is `context.setOffline`, which the
 * service worker's own fetches feel too; a line that looks open but never
 * answers is the page's socket routed and held (as deadLine.spec.ts does).
 *
 * On a phone's screen, where the copy matters: the week strip, not the
 * desktop's month grid, which is not kept.
 */

const TZ = 'Australia/Perth'
const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR

/** This week and next (14 days and 2 weeks), the client list, the team and
 * the job types: `keptQueries` in src/lib/offline/keptSet.ts. */
const KEPT_ROWS = 19

/** Long enough for every kept answer to come live and be written: a claim
 * waits for access:me, and a write 1.5 s after an answer (5 s for the
 * client list). */
const KEEP_TIMEOUT = 30_000

/**
 * Further on than KEPT_PAGE_AGE_MS (src/lib/offline/useKept.ts), so a page
 * the service worker serves afterwards counts as its own copy rather than
 * one fresh off the network, which is when the note shows from first paint.
 * The page's clock is moved on this far rather than the test waiting.
 */
const PAGE_AGE_MS = 3 * 60_000

const convexHost = new URL(process.env.VITE_CONVEX_URL!).host

/**
 * What the console says when hydration goes wrong: React's own words in
 * development, and in the production build these run against, only its
 * error number (418, 423 and 425 are the mismatches).
 */
const HYDRATION_TROUBLE =
  /hydrat|did not match|react\.dev\/errors\/(418|423|425)\b/i

test.use({ viewport: { width: 390, height: 844 } })
test.describe.configure({ timeout: 180_000 })

// ── Days ───────────────────────────────────────────────────────────────────

/** A day `offset` from today in Perth, where every business here is. */
function perthDay(offset: number): string {
  return addDaysToKey(todayKeyInZone(TZ), offset)
}

/** `hour` o'clock on `dayKey` in Perth. */
function perthAt(dayKey: string, hour: number): number {
  return startOfDayInZone(dayKey, TZ) + hour * HOUR
}

/** As the schedule's heading says a day (`formatDayLabel`). */
function dayLabel(dayKey: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${dayKey}T00:00:00Z`))
}

// ── People and work ────────────────────────────────────────────────────────

async function ownerWithBusiness(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  return { owner, ...(await businessOf(owner, label)) }
}

async function businessOf(owner: Actor, label: string) {
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
      state: 'WA',
      timezone: TZ,
    },
  )
  const [me] = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  return { businessId, slug, ownerMembershipId: me._id }
}

/** A job for a new client on `dayKey`, booked from the office. */
function book(
  owner: Actor,
  businessId: Id<'businesses'>,
  assignedMembershipId: Id<'memberships'>,
  clientName: string,
  dayKey: string,
  jobType = 'General Pest Control',
  phone?: string,
) {
  return owner.client.mutation(api.jobs.create, {
    businessId,
    newClient: {
      kind: 'person',
      clientName,
      ...(phone ? { phone } : {}),
      // An address of its own, so each is a client of its own.
      addressLine: `${clientName.length} ${clientName.split(' ')[0]} Street`,
      suburb: 'Wellard',
      state: 'WA',
      postcode: '6170',
    },
    assignedMembershipId,
    jobType,
    price: 19500,
    scheduledAt: perthAt(dayKey, 10),
    durationMinutes: 60,
  })
}

// ── The page ───────────────────────────────────────────────────────────────

const newJobButton = (page: Page) =>
  page.getByRole('button', { name: 'New job' })

/** The schedule, hydrated: New job is disabled until it is. */
async function openSchedule(page: Page, slug: string) {
  await page.goto(`/${slug}/schedule`)
  await expect(newJobButton(page)).toBeEnabled()
}

/**
 * Lets the service worker take this page over, then loads it through the
 * worker once, so the page is in its cache (licences.spec.ts says why it is
 * reloaded until then).
 */
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

/** The "Updated" note (KeptCopyNote). */
const keptNote = (page: Page) => page.locator('[data-kept-note]')

/** The note's first line as shown: the note also holds, unseen, every other
 * first line it can say, which keep its height. */
const keptWords = (page: Page) => keptNote(page).locator('[data-kept-words]')

/** The schedule's heading for a day. */
const dayHeading = (page: Page, dayKey: string) =>
  page.getByRole('heading', { name: dayLabel(dayKey), level: 2 })

/**
 * Goes from the day on screen, `from`, to `dayKey` as a person does: Next
 * week as often as it takes, then the day on the strip. Each step waits for
 * the heading, so the next tap goes from the day it should.
 */
async function openDay(page: Page, from: string, dayKey: string) {
  const weeks = Math.round(
    (Date.parse(startOfWeekKey(dayKey)) - Date.parse(startOfWeekKey(from))) /
      WEEK,
  )
  let at = from
  for (let i = 0; i < weeks; i++) {
    at = addDaysToKey(at, 7)
    await page.getByRole('button', { name: 'Next week' }).click()
    await expect(dayHeading(page, at)).toBeVisible()
  }
  if (at !== dayKey) {
    await page.getByRole('button', { name: dayKey, exact: true }).click()
    await expect(dayHeading(page, dayKey)).toBeVisible()
  }
}

/** "Not on this phone" in the list's place, for `dayKey` (NotKeptDay). */
async function expectNotKept(page: Page, dayKey: string) {
  await expect(dayHeading(page, dayKey)).toBeVisible()
  await expect(page.getByText('Not on this phone')).toBeVisible()
  await expect(
    page.getByText(
      `This phone keeps this week and next. ${dayLabel(dayKey)} shows when you have signal.`,
    ),
  ).toBeVisible()
}

// ── What is kept ───────────────────────────────────────────────────────────

type KeptOwnerSeen = {
  userId: string
  businessId: string
  slug: string
  lens: string
  epoch: string
  liveAt: number
}
type KeptRowSeen = {
  hash: string
  fn: string
  businessId: string
  args: Record<string, unknown>
  savedAt: number
  /** The answer, as JSON, to look for a job in. */
  data: string
}
type KeptCopy = { owner: KeptOwnerSeen | null; rows: Array<KeptRowSeen> }

const NOTHING_KEPT: KeptCopy = { owner: null, rows: [] }

/**
 * What the phone keeps, read from IndexedDB. Asks which databases there are
 * first: opening one that isn't there, with no version, makes an empty one,
 * which the app would then have to delete. Never throws, so it can be
 * polled (`expect.poll` stops at a callback that throws): a page between
 * loads reads as nothing kept.
 */
async function keptCopy(page: Page): Promise<KeptCopy> {
  return page
    .evaluate(async (): Promise<KeptCopy> => {
      const none: KeptCopy = { owner: null, rows: [] }
      const names = await indexedDB.databases()
      if (!names.some((db) => db.name === 'pestm8-offline')) return none
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('pestm8-offline')
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error ?? new Error('not opened'))
      })
      try {
        const stores = db.objectStoreNames
        if (!stores.contains('owner') || !stores.contains('rows')) return none
        const tx = db.transaction(['owner', 'rows'], 'readonly')
        const read = (request: IDBRequest) =>
          new Promise<unknown>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () =>
              reject(request.error ?? new Error('not read'))
          })
        // Both asked for at once, in the one transaction, so they agree.
        const [ownerRead, rowsRead] = await Promise.all([
          read(tx.objectStore('owner').get('owner')),
          read(tx.objectStore('rows').getAll()),
        ])
        const owner = ownerRead as KeptOwnerSeen | undefined
        const rows = rowsRead as Array<{
          hash: string
          fn: string
          businessId: string
          queryKey: [string, string, Record<string, unknown>]
          savedAt: number
          data: unknown
        }>
        return {
          owner: owner ?? null,
          rows: rows.map((row) => ({
            hash: row.hash,
            fn: row.fn,
            businessId: row.businessId,
            args: row.queryKey[2],
            savedAt: row.savedAt,
            data: JSON.stringify(row.data),
          })),
        }
      } finally {
        db.close()
      }
    })
    .catch(() => NOTHING_KEPT)
}

/** Waits until the whole copy is written, for `businessId`. */
async function waitForKeptCopy(page: Page, businessId: Id<'businesses'>) {
  await expect
    .poll(
      async () => {
        const kept = await keptCopy(page)
        return kept.owner?.businessId === businessId
          ? kept.rows.filter((row) => row.businessId === businessId).length
          : 0
      },
      { timeout: KEEP_TIMEOUT },
    )
    .toBeGreaterThanOrEqual(KEPT_ROWS)
}

/** The kept day `dayKey`, as JSON: '' until it is kept. */
async function keptDay(page: Page, dayKey: string): Promise<string> {
  const { rows } = await keptCopy(page)
  return (
    rows.find((row) => row.fn === 'jobs:listDay' && row.args.dayKey === dayKey)
      ?.data ?? ''
  )
}

/** The pages the service worker keeps for a business, by path. */
async function pagesKeptFor(page: Page, slug: string): Promise<Array<string>> {
  return page
    .evaluate(async (businessSlug) => {
      if (!(await caches.has('pages'))) return []
      const root = `/${encodeURIComponent(businessSlug)}`
      return (await (await caches.open('pages')).keys())
        .map((request) => new URL(request.url).pathname)
        .filter((path) => path === root || path.startsWith(`${root}/`))
    }, slug)
    .catch(() => ['(could not read)'])
}

/** Where the worker sends a page it has no copy of (HOME_MARKER). */
async function homeKept(page: Page): Promise<string | null> {
  return page
    .evaluate(async () => {
      if (!(await caches.has('pages'))) return null
      const marker = await (await caches.open('pages')).match('/__pestm8/home')
      return marker ? (await marker.text()).trim() : null
    })
    .catch(() => null)
}

/** A business with today's job, signed in, its page and copy kept. */
async function keptBusiness(page: Page, label: string) {
  const s = await ownerWithBusiness(label)
  const today = perthDay(0)
  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Arthur Wellard',
    today,
  )
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)
  await keepPageInWorker(page)
  await waitForKeptCopy(page, s.businessId)
  return { ...s, today }
}

// ── The cases ──────────────────────────────────────────────────────────────

test('with no signal, the schedule and New Job open from the copy kept on the phone', async ({
  page,
  context,
}) => {
  const s = await ownerWithBusiness('kept-cold-open')
  const today = perthDay(0)
  const tomorrow = perthDay(1)
  const nextWeek = perthDay(7)
  // The business's own service, which New Job could not offer without the
  // list: it would fall back to the nine every business starts with.
  await s.owner.client.mutation(api.jobTypes.create, {
    businessId: s.businessId,
    name: 'Possum Proofing',
    report: 'serviceReport',
  })
  // With a number, for the job sheet's Call with no signal.
  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Arthur Wellard',
    today,
    'General Pest Control',
    '0412 345 678',
  )
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)
  await keepPageInWorker(page)
  await waitForKeptCopy(page, s.businessId)

  // Booked from the office after the page the worker keeps was loaded: only
  // the copy kept on the phone has them, once the server has pushed them.
  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Beatrice Byford',
    tomorrow,
  )
  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Nadia Nollamara',
    nextWeek,
  )
  await expect
    .poll(() => keptDay(page, tomorrow), { timeout: KEEP_TIMEOUT })
    .toContain('Beatrice Byford')
  await expect
    .poll(() => keptDay(page, nextWeek), { timeout: KEEP_TIMEOUT })
    .toContain('Nadia Nollamara')

  await page.clock.setSystemTime(Date.now() + PAGE_AGE_MS)
  await context.setOffline(true)
  try {
    // Opened afresh from the Home Screen: `/` sends it to the schedule.
    await page.goto('/')
    await expect(page).toHaveURL(new RegExp(`/${s.slug}/schedule`))
    await expect(newJobButton(page)).toBeEnabled()
    await expect(page.getByText('Arthur Wellard')).toBeVisible()
    await expect(keptNote(page)).toHaveAttribute('data-kept-note', 'no-signal')
    await expect(keptWords(page)).toHaveText(
      'No signal — showing the copy kept on this phone.',
    )
    await expect(keptNote(page)).toContainText(/Updated \S/)

    await openDay(page, today, tomorrow)
    await expect(page.getByText('Beatrice Byford')).toBeVisible()
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(dayHeading(page, today)).toBeVisible()
    await openDay(page, today, nextWeek)
    await expect(page.getByText('Nadia Nollamara')).toBeVisible()

    // Three weeks out is further than the phone keeps.
    const farOff = perthDay(21)
    for (const step of [14, 21]) {
      await page.getByRole('button', { name: 'Next week' }).click()
      await expect(dayHeading(page, perthDay(step))).toBeVisible()
    }
    await expectNotKept(page, farOff)
    await page.getByRole('button', { name: 'Go to today' }).click()
    await expect(dayHeading(page, today)).toBeVisible()
    await expect(page.getByText('Arthur Wellard')).toBeVisible()

    // New Job, made of what the phone kept: the client list and the
    // business's own services, and a word on when the booking goes.
    await newJobButton(page).click()
    const sheet = page.getByRole('dialog')
    await expect(
      sheet.getByText(
        'No signal — the booking goes when you have signal. Keep PestM8 open until then.',
      ),
    ).toBeVisible()
    await expect(sheet.getByText('Choose a client and address')).toBeVisible()
    await chooseProperty(page, sheet, 'Arthur', /Arthur Wellard/)
    await sheet.getByLabel('Job type').click()
    const types = page.getByRole('dialog', { name: 'Job type' })
    await expect(
      types.getByRole('checkbox', { name: 'Possum Proofing', exact: true }),
    ).toBeVisible()

    // A job opened with no signal: read-only, from the day the phone keeps,
    // with the card's Call (a hold, never a `tel:` link) and why it can't
    // be changed. `jobs.get` is never kept.
    await page.keyboard.press('Escape')
    await expect(types).toHaveCount(0)
    // New Job asks before the client chosen goes.
    await page.keyboard.press('Escape')
    await page
      .getByRole('alertdialog')
      .filter({ hasText: 'Discard your changes?' })
      .getByRole('button', { name: 'Discard' })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const job = page.getByRole('dialog')
    await clickUntil(
      page.getByRole('button', { name: /Arthur Wellard/ }).first(),
      () =>
        expect(
          job.getByRole('heading', {
            name: 'General Pest Control',
            exact: true,
          }),
        ).toBeVisible({ timeout: 3_000 }),
    )
    await expect(
      job.getByText(
        /^No signal — showing the copy kept on this phone, updated \S.*\. Editing needs signal\.$/,
      ),
    ).toBeVisible()
    await expect(
      job.getByRole('button', { name: 'Call Arthur Wellard' }),
    ).toBeVisible()
    await expect(
      job.getByRole('button', { name: 'Edit job details' }),
    ).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
})

test('a page open when the signal goes still goes to the days it keeps, and says which it does not', async ({
  page,
  context,
}) => {
  const s = await ownerWithBusiness('kept-after-load')
  const today = perthDay(0)
  const nextWeek = perthDay(7)
  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Nadia Nollamara',
    nextWeek,
  )
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)
  await keepPageInWorker(page)
  await waitForKeptCopy(page, s.businessId)

  // The browser says it is offline, which is the moment react-query holds
  // back every fetch it hasn't started: what decides "not on this phone" is
  // the page as it draws, not a fetch that would never come back.
  await context.setOffline(true)
  try {
    await openDay(page, today, nextWeek)
    await expect(page.getByText('Nadia Nollamara')).toBeVisible()
    for (const step of [14, 21]) {
      await page.getByRole('button', { name: 'Next week' }).click()
      await expect(dayHeading(page, perthDay(step))).toBeVisible()
    }
    await expectNotKept(page, perthDay(21))
    // Never put in under a thumb once the page is up: a drop during a visit
    // is ConnectionNotice's to say.
    await expect(keptNote(page)).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
})

test('a page the worker kept from yesterday opens on today, without a hydration error', async ({
  page,
  context,
}) => {
  const s = await ownerWithBusiness('kept-stale-day')
  const tomorrow = perthDay(1)
  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Beatrice Byford',
    tomorrow,
  )
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)
  await keepPageInWorker(page)
  await waitForKeptCopy(page, s.businessId)
  expect(await keptDay(page, tomorrow)).toContain('Beatrice Byford')

  const problems: Array<string> = []
  page.on('console', (message) => problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))

  // The next morning, before there is any signal: the page the worker
  // serves was drawn for the day before.
  await page.clock.install({ time: perthAt(tomorrow, 7) })
  await context.setOffline(true)
  try {
    await page.reload()
    await expect(newJobButton(page)).toBeEnabled()
    await expect(dayHeading(page, tomorrow)).toBeVisible()
    await expect(page.getByText('Beatrice Byford')).toBeVisible()
    await expect(
      page.getByRole('button', { name: tomorrow, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(keptNote(page)).toBeVisible()
    expect(problems.filter((text) => HYDRATION_TROUBLE.test(text))).toEqual([])
  } finally {
    await context.setOffline(false)
  }
})

test('a change kept after the page was, and clearly later, shows on the next open with no signal', async ({
  page,
  context,
}) => {
  const s = await ownerWithBusiness('kept-upgrade')
  const today = perthDay(0)
  const jobId = await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Arthur Wellard',
    today,
    'General Pest Control',
  )
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)
  // The last page load the worker keeps, with the job as it was.
  await keepPageInWorker(page)
  await waitForKeptCopy(page, s.businessId)

  // More than two minutes on by the phone's clock (KEPT_UPGRADE_MARGIN_MS),
  // the office changes the job, and the open page keeps the change.
  await page.clock.setSystemTime(Date.now() + PAGE_AGE_MS)
  await s.owner.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId,
    jobType: 'Termite Inspection',
  })
  await expect
    .poll(() => keptDay(page, today), { timeout: KEEP_TIMEOUT })
    .toContain('Termite Inspection')

  await context.setOffline(true)
  try {
    // The worker's page still says General Pest Control; the copy, kept
    // clearly later, takes its place as the page hydrates.
    await page.reload()
    await expect(newJobButton(page)).toBeEnabled()
    await expect(
      page.getByRole('button', { name: /Termite Inspection/ }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /General Pest Control/ }),
    ).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
})

test('back in signal, the note says it is up to date, goes with the next day, and the live schedule carries on', async ({
  page,
  context,
}) => {
  const s = await keptBusiness(page, 'kept-live-again')
  const weekStart = startOfWeekKey(s.today)
  // Another day of the strip on screen.
  const otherDay =
    s.today === weekStart ? addDaysToKey(weekStart, 1) : weekStart

  await page.clock.setSystemTime(Date.now() + PAGE_AGE_MS)
  await context.setOffline(true)
  await page.reload()
  await expect(newJobButton(page)).toBeEnabled()
  await expect(keptNote(page)).toHaveAttribute('data-kept-note', 'no-signal')

  await context.setOffline(false)
  await expect(keptNote(page)).toHaveAttribute('data-kept-note', 'live', {
    timeout: 30_000,
  })
  await expect(keptWords(page)).toHaveText('Up to date.')
  // Its second line stays, so nothing under it moves: when it came live.
  await expect(keptNote(page)).toContainText(/Updated \S/)

  await page.getByRole('button', { name: otherDay, exact: true }).click()
  await expect(dayHeading(page, otherDay)).toBeVisible()
  await expect(keptNote(page)).toHaveCount(0)

  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Colin Coogee',
    otherDay,
  )
  await expect(page.getByText('Colin Coogee')).toBeVisible()
})

test('signing out clears the copy, and the next person sees nothing of it', async ({
  page,
  context,
}) => {
  const a = await keptBusiness(page, 'kept-sign-out')

  await page.goto(`/${a.slug}/settings`)
  const signOut = page.getByRole('button', { name: 'Sign out' })
  await expect(signOut).toBeEnabled()
  await clickUntil(signOut, () =>
    expect(page).toHaveURL(/\/login/, { timeout: 5_000 }),
  )
  await expect.poll(() => keptCopy(page)).toEqual(NOTHING_KEPT)
  // The worker may keep the sign-in page, but nothing of the business.
  expect(await pagesKeptFor(page, a.slug)).toEqual([])
  expect(await homeKept(page)).toBeNull()

  const b = await ownerWithBusiness('kept-next-person')
  await book(
    b.owner,
    b.businessId,
    b.ownerMembershipId,
    'Beatrice Byford',
    perthDay(0),
  )
  await signInViaUi(page, b.owner.email)
  await openSchedule(page, b.slug)
  await waitForKeptCopy(page, b.businessId)
  await expect.poll(() => homeKept(page)).toBe(`/${b.slug}/schedule`)
  expect(
    (await keptCopy(page)).rows.filter(
      (row) => row.businessId === a.businessId,
    ),
  ).toEqual([])

  await context.setOffline(true)
  try {
    // The first person's schedule, asked for by its address: the worker has
    // no copy of it, and sends the page to this person's.
    await page.goto(`/${a.slug}/schedule`)
    await expect(page).toHaveURL(new RegExp(`/${b.slug}/schedule`))
    await expect(page.getByText('Beatrice Byford')).toBeVisible()
    await expect(page.getByText('Arthur Wellard')).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
})

test('signing out with no signal says it needs signal, and keeps the copy', async ({
  page,
  context,
}) => {
  const s = await keptBusiness(page, 'kept-offline-sign-out')
  const before = await keptCopy(page)

  await page.goto(`/${s.slug}/settings`)
  const signOut = page.getByRole('button', { name: 'Sign out' })
  await expect(signOut).toBeEnabled()
  await context.setOffline(true)
  try {
    await signOut.click()
    await expect(page.getByText('Signing out needs signal.')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings`))
    const after = await keptCopy(page)
    expect(after.owner?.epoch).toBe(before.owner?.epoch)
    expect(after.rows.length).toBeGreaterThanOrEqual(KEPT_ROWS)
  } finally {
    await context.setOffline(false)
  }
})

test('working in someone else’s account keeps nothing, and serves nothing kept', async ({
  page,
  context,
}) => {
  const s = await setupBusinessWithSub('kept-switched')
  const nextWeek = perthDay(7)
  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Nadia Nollamara',
    nextWeek,
  )
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)
  await keepPageInWorker(page)
  await waitForKeptCopy(page, s.businessId)

  await page.getByRole('button', { name: 'Whose jobs to show' }).click()
  await page.getByRole('menuitemradio', { name: /Kevin/ }).click()
  const banner = page.getByText(/Working in .*’s account/)
  await expect(banner).toBeVisible()
  // Whatever was on its way under his own view has landed.
  await page.waitForTimeout(3_000)
  const before = await keptCopy(page)
  expect(before.rows.length).toBeGreaterThanOrEqual(KEPT_ROWS)

  // A page drawn while switched, for the worker to keep; then long enough
  // for a write (1.5 s to 10 s) and a stamp (every 30 s) to have come.
  await page.reload()
  await expect(banner).toBeVisible()
  await expect(newJobButton(page)).toBeEnabled()
  await page.waitForTimeout(35_000)
  const after = await keptCopy(page)
  expect(after.owner).toEqual(before.owner)
  expect(after.rows.map(({ hash, savedAt }) => [hash, savedAt]).sort()).toEqual(
    before.rows.map(({ hash, savedAt }) => [hash, savedAt]).sort(),
  )

  await context.setOffline(true)
  try {
    // Only what the page itself carries: the owner's own copy of next week
    // is on the phone, and is not his to see in Kevin's account.
    await page.reload()
    await expect(banner).toBeVisible()
    await expect(newJobButton(page)).toBeEnabled()
    await page.getByRole('button', { name: 'Next week' }).click()
    await expectNotKept(page, nextWeek)
    await expect(page.getByText('Nadia Nollamara')).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
})

test('someone removed from the business has its copy wiped from their phone', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('kept-removed')
  await signInViaUi(page, s.sub.email)
  await openSchedule(page, s.slug)
  await keepPageInWorker(page)
  await waitForKeptCopy(page, s.businessId)

  // The server's NO_ACCESS on access:me, pushed to the open page.
  await s.owner.client.mutation(api.team.remove, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
  })
  await expect
    .poll(() => keptCopy(page), { timeout: KEEP_TIMEOUT })
    .toEqual(NOTHING_KEPT)
})

test('a line that looks open but never answers is noticed, and says when the screen was last updated', async ({
  page,
}) => {
  // Each socket passes through until the line is held; a held one opens at
  // once, as far as the page can tell, and says nothing.
  let held = false
  const opened: Array<WebSocketRoute> = []
  await page.routeWebSocket(
    (url) => url.host === convexHost,
    (ws) => {
      opened.push(ws)
      if (held) return
      const server = ws.connectToServer()
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => ws.send(message))
    },
  )
  await keptBusiness(page, 'kept-black-hole')
  await expect(page.getByText('Arthur Wellard')).toBeVisible()

  // The line closes, and the one that takes its place is a black hole.
  // Everything on screen had its answer before, so no query waits for a
  // first one, and the new socket reads as open: the only thing left to
  // time is that what is on screen counts as waiting until the server
  // confirms it on this line (`keptWaiting`), 12 s (QUERY_WAIT_MS). Well
  // before the silent socket would be given up (20 s) and then counted as
  // down (8 s more), which would raise the notice anyway.
  held = true
  const before = opened.length
  await opened.at(-1)?.close()
  await expect
    .poll(() => opened.length, { timeout: 10_000 })
    .toBeGreaterThan(before)

  const notice = page.locator('[data-reach-notice="banner"]')
  await expect(notice).toBeVisible({ timeout: 18_000 })
  await expect(notice).toContainText('Could not reach PestM8')
  await expect(notice).toContainText(/What’s on screen was last updated \S/)
})

test('switching business takes the last one’s copy and pages off the phone', async ({
  page,
  context,
}) => {
  const owner = await signUpActor(
    uniqueEmail('kept-two-businesses'),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const a = await businessOf(owner, 'kept-first')
  const b = await businessOf(owner, 'kept-second')
  await book(
    owner,
    a.businessId,
    a.ownerMembershipId,
    'Arthur Wellard',
    perthDay(0),
  )
  await book(
    owner,
    b.businessId,
    b.ownerMembershipId,
    'Beatrice Byford',
    perthDay(0),
  )

  await signInViaUi(page, owner.email)
  await openSchedule(page, a.slug)
  await keepPageInWorker(page)
  await waitForKeptCopy(page, a.businessId)
  expect(await pagesKeptFor(page, a.slug)).not.toEqual([])

  // The second business, with signal: its claim takes the copy over.
  await openSchedule(page, b.slug)
  await waitForKeptCopy(page, b.businessId)
  expect(
    (await keptCopy(page)).rows.filter(
      (row) => row.businessId === a.businessId,
    ),
  ).toEqual([])
  await expect.poll(() => pagesKeptFor(page, a.slug)).toEqual([])
  await expect.poll(() => homeKept(page)).toBe(`/${b.slug}/schedule`)

  // What keeping a page rests on (keptPages.ts): a cache deleted after it
  // was opened, as a sign-out deletes 'pages', stays gone, even once
  // something puts into the reference opened before.
  const orphan = await page.evaluate(async () => {
    const name = 'kept-copy-orphan-check'
    const cache = await caches.open(name)
    await caches.delete(name)
    await cache.put('/orphan-check', new Response('kept'))
    const found = {
      named: await caches.has(name),
      matched: (await caches.match('/orphan-check')) !== undefined,
    }
    await caches.delete(name)
    return found
  })
  expect(orphan).toEqual({ named: false, matched: false })

  await context.setOffline(true)
  try {
    await page.goto('/')
    await expect(page).toHaveURL(new RegExp(`/${b.slug}/schedule`))
    await expect(page.getByText('Beatrice Byford')).toBeVisible()
    await expect(page.getByText('Arthur Wellard')).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
})

test('with no signal, the Clients page lists every client from the copy kept on the phone, and opens one', async ({
  page,
  context,
}) => {
  const s = await ownerWithBusiness('kept-clients')
  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Arthur Wellard',
    perthDay(0),
  )
  // Not on the schedule's day: the page lists every client the phone
  // keeps, not only today's. With a number, for the client sheet's Call
  // with no signal.
  await book(
    s.owner,
    s.businessId,
    s.ownerMembershipId,
    'Beatrice Byford',
    perthDay(7),
    'General Pest Control',
    '0412 555 019',
  )
  await signInViaUi(page, s.owner.email)
  await openSchedule(page, s.slug)
  await keepPageInWorker(page)
  await waitForKeptCopy(page, s.businessId)

  await page.clock.setSystemTime(Date.now() + PAGE_AGE_MS)
  await context.setOffline(true)
  try {
    await page.goto('/')
    await expect(newJobButton(page)).toBeEnabled()

    // Neither the newest clients' page nor the server's count is kept: the
    // page reads the client list New Job picks from, and counts that.
    await page
      .getByRole('navigation', { name: 'Tabs' })
      .getByRole('link', { name: 'Clients', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: 'Clients', level: 1 }),
    ).toBeVisible()
    await expect(page.getByText('2 clients', { exact: true })).toBeVisible()
    await expect(page.getByText('Arthur Wellard')).toBeVisible()
    await expect(page.getByText('Beatrice Byford')).toBeVisible()
    await expect(keptNote(page)).toHaveAttribute('data-kept-note', 'no-signal')
    await expect(keptWords(page)).toHaveText(
      'No signal — showing the copy kept on this phone.',
    )
    await expect(keptNote(page)).toContainText(/Updated \S/)
    await expect(page.getByText(/Could not load/)).toHaveCount(0)

    // A search runs over the copy, as it does over the live list.
    await page
      .getByLabel('Search clients by name, address, phone or email')
      .fill('Beat')
    await expect(page.getByText('Beatrice Byford')).toBeVisible()
    await expect(page.getByText('Arthur Wellard')).toHaveCount(0)

    // A client opened with no signal: read-only, from their row in the
    // client list the phone keeps, with Call (a hold, never a `tel:` link)
    // and each site's Map, and why it can't be changed. `clients.get` is
    // never kept.
    const sheet = page.getByRole('dialog')
    await clickUntil(
      page.getByRole('button', { name: /Beatrice Byford/ }).first(),
      () =>
        expect(
          sheet.getByRole('heading', { name: 'Beatrice Byford', exact: true }),
        ).toBeVisible({ timeout: 3_000 }),
    )
    await expect(
      sheet.getByText(
        /^No signal — showing the copy kept on this phone, updated \S.*\. Editing needs signal\.$/,
      ),
    ).toBeVisible()
    await expect(
      sheet.getByRole('button', { name: 'Call Beatrice Byford' }),
    ).toBeVisible()
    await expect(
      sheet.getByRole('button', {
        name: 'Map of 15 Beatrice Street, Wellard',
      }),
    ).toBeVisible()
    // Their jobs and notes aren't kept, and say when they open. No Xero
    // row: this deployment has no Xero, so the live sheet has none either.
    await expect(sheet.getByText('Opens when you have signal.')).toHaveCount(2)
    await expect(sheet.getByText('Xero')).toHaveCount(0)
    await expect(
      sheet.getByRole('button', { name: 'Edit client details' }),
    ).toHaveCount(0)
    await expect(
      sheet.getByRole('button', { name: /Add another property/ }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)

    // The Clients page as the worker kept it, opened again with no signal:
    // the cards its HTML drew stay, rather than giving way to the list's
    // placeholder while every client is read from the copy instead.
    await context.setOffline(false)
    const newClient = page.getByRole('button', { name: 'New client' })
    await page.goto(`/${s.slug}/clients`)
    await expect(newClient).toBeEnabled()
    await expect(page.getByText('Beatrice Byford')).toBeVisible()
    await page.addInitScript(() => {
      const seen = window as unknown as { listPlaceholderSeen?: boolean }
      seen.listPlaceholderSeen = false
      new MutationObserver(() => {
        for (const label of document.querySelectorAll(
          '[role="status"] > .sr-only',
        )) {
          if (label.textContent === 'Loading clients') {
            seen.listPlaceholderSeen = true
          }
        }
      }).observe(document, { childList: true, subtree: true })
    })
    await context.setOffline(true)
    await page.goto(`/${s.slug}/clients`)
    await expect(newClient).toBeEnabled()
    await expect(page.getByText('2 clients', { exact: true })).toBeVisible()
    await expect(page.getByText('Arthur Wellard')).toBeVisible()
    await expect(page.getByText('Beatrice Byford')).toBeVisible()
    await expect(keptNote(page)).toBeVisible()
    // Long enough for the phone's copy to have been read (PEEK_TIMEOUT_MS).
    await page.waitForTimeout(3_500)
    await expect(page.getByText('Arthur Wellard')).toBeVisible()
    await expect(page.getByText('2 clients', { exact: true })).toBeVisible()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { listPlaceholderSeen?: boolean })
            .listPlaceholderSeen,
      ),
    ).toBe(false)
  } finally {
    await context.setOffline(false)
  }
})
