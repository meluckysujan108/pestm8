import { expect, test } from '@playwright/test'
import { addDaysToKey } from '../convex/lib/dates'
import { formatJobDate } from '../src/lib/format'
import {
  FIXTURE_PASSWORD,
  api,
  chooseJobTypes,
  chooseProperty,
  clickUntil,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Locator, Page } from '@playwright/test'
import type { Actor } from './fixtures'
import type { Id } from '../convex/_generated/dataModel'

/**
 * Is this site already booked? (the matching plan's M5): New Job's check at
 * Book, from what is booked at each site on the phone (`jobs.openWork`),
 * with signal or without. A job at the site within a week either side is a
 * row, with Open #n; Book anyway books this one as well. An address typed
 * as a new client's names whose job it is (FW2); a second Recurring Job
 * where one runs is "Already repeats"; someone else's job is its date
 * alone, and Book anyway books once (RK1); three weeks away is no row; and
 * a match row that named the site's work books on the one press after its
 * fix (FW13).
 *
 * The server checks nothing of this yet (the plan's M7): every booking here
 * goes as the phone sends it. On a phone's screen.
 */

const TZ = 'Australia/Perth'

/** Further on than KEPT_PAGE_AGE_MS (src/lib/offline/useKept.ts), so the
 * page the service worker serves counts as its own copy (keptCopy.spec.ts). */
const PAGE_AGE_MS = 3 * 60_000

/** Long enough for an answer to come live and be written to the phone. */
const KEEP_TIMEOUT = 30_000

test.use({ viewport: { width: 390, height: 844 } })
test.describe.configure({ timeout: 180_000 })

function perthToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
}

/** `hh`:00 on `dayKey` in Perth (UTC+8 all year). */
function perthAt(dayKey: string, hh: number) {
  return Date.parse(`${dayKey}T${String(hh).padStart(2, '0')}:00:00+08:00`)
}

/**
 * A business with Jane Nguyen at 12 Wattle St, Bayswater, and Ray White
 * Bayswater at 5/12 Ocean Pde, Cottesloe; the owner's membership, to book
 * with.
 */
async function seedSites(label: string) {
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
  const oceanSite = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Ray White Bayswater',
    kind: 'business',
    phone: '08 7010 1234',
    addressLine: '5/12 Ocean Pde',
    suburb: 'Cottesloe',
    state: 'WA',
    postcode: '6011',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const ownerMembership = members.find((m) => m.role === 'owner')!._id
  return { owner, businessId, slug, janeSite, oceanSite, ownerMembership }
}

/** A job of the owner's at `propertyId`, at 10am on `dayKey`, and its
 * number. */
async function bookAt(
  owner: Actor,
  s: { businessId: Id<'businesses'>; ownerMembership: Id<'memberships'> },
  propertyId: Id<'properties'>,
  dayKey: string,
) {
  const jobId = await owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId,
    assignedMembershipId: s.ownerMembership,
    jobType: 'General Pest Control',
    price: 18500,
    scheduledAt: perthAt(dayKey, 10),
    durationMinutes: 60,
  })
  const job = await owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId,
  })
  return { jobId, jobNumber: job!.jobNumber! }
}

async function jobsOn(
  owner: Actor,
  businessId: Id<'businesses'>,
  dayKey: string,
) {
  return owner.client.query(api.jobs.listDay, { businessId, dayKey })
}

const newJobButton = (page: Page) =>
  page.getByRole('button', { name: 'New job' })

/** The schedule on `dayKey`, hydrated, and New Job open on it: the
 * Schedule's New Job books on the day it shows, and has no Date of its
 * own (that is the client sheet's, `pickDate`). */
async function openNewJob(page: Page, slug: string, dayKey: string) {
  await page.goto(`/${slug}/schedule?date=${dayKey}`)
  return newJobOnPage(page)
}

/** New Job opened on the day the page already shows. */
async function newJobOnPage(page: Page) {
  await expect(newJobButton(page)).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(newJobButton(page), () =>
    expect(sheet.getByText('New job').first()).toBeVisible({ timeout: 2_000 }),
  )
  return sheet
}

/** New Job made a Recurring Job, every three months. */
async function repeatQuarterly(sheet: Locator) {
  await sheet.getByRole('radio', { name: 'Recurring Job', exact: true }).click()
  await sheet.getByLabel('Repeat every', { exact: true }).fill('3')
  await sheet.getByLabel('Repeat unit', { exact: true }).selectOption('month')
}

/** New Job's New client tab, filled in as a caller gives it. */
async function typeCaller(
  sheet: Locator,
  caller: {
    name: string
    phone: string
    street: string
    suburb: string
    postcode: string
  },
) {
  await sheet.getByRole('radio', { name: 'New client', exact: true }).click()
  await sheet.getByLabel('Client name', { exact: true }).fill(caller.name)
  await sheet.getByLabel('Phone (optional)', { exact: true }).fill(caller.phone)
  await sheet.getByLabel('Street address', { exact: true }).fill(caller.street)
  await sheet.getByLabel('Suburb', { exact: true }).fill(caller.suburb)
  await sheet.getByLabel('Postcode', { exact: true }).fill(caller.postcode)
}

/** The panel above Book, by its heading. */
const panelOf = (sheet: Locator) =>
  sheet.getByRole('region', { name: /to check before saving/ })

/** How New Job writes a day: "Thu 29 Oct". */
const dateOf = (dayKey: string) => formatJobDate(dayKey, perthToday())

test('a job there the day before: Already booked, Open #n opens it, and Book anyway makes two', async ({
  page,
}) => {
  const s = await seedSites('site-booked')
  const jobDay = addDaysToKey(perthToday(), 1)
  const bookDay = addDaysToKey(jobDay, 1)
  const booked = await bookAt(s.owner, s, s.janeSite, jobDay)
  await signInViaUi(page, s.owner.email)

  // Open #n: New Job asks before what was typed goes, then the job opens.
  let sheet = await openNewJob(page, s.slug, bookDay)
  await chooseProperty(page, sheet, 'Jane Nguyen', /12 Wattle St/)
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await sheet.getByRole('button', { name: 'Book job' }).click()
  let panel = panelOf(sheet)
  await expect(panel).toContainText(
    `Already booked: 12 Wattle St has a job on ${dateOf(jobDay)} at 10:00am — General Pest Control, Terence (#${booked.jobNumber}).`,
  )
  await expect(panel).toContainText(
    'Open it, or press Book anyway to book this one as well.',
  )
  const open = panel.getByRole('button', { name: `Open #${booked.jobNumber}` })
  const asking = page
    .getByRole('alertdialog')
    .filter({ hasText: 'Discard your changes?' })
  // Kept editing: the row is still there to read.
  await open.click()
  await asking.getByRole('button', { name: 'Keep editing' }).click()
  await expect(asking).toHaveCount(0)
  await expect(panelOf(sheet)).toContainText(
    `Already booked: 12 Wattle St has a job on ${dateOf(jobDay)}`,
  )
  await open.click()
  await asking.getByRole('button', { name: 'Discard' }).click()
  // On the job's own day, in the view the Schedule was in.
  await expect(page).toHaveURL(new RegExp(`jobId=${booked.jobId}`))
  await expect(page).toHaveURL(new RegExp(`date=${jobDay}`))
  // New Job gone, the job's own sheet in its place.
  await expect(page.getByRole('button', { name: 'Book job' })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.getByRole('dialog')).toContainText('Jane Nguyen')
  expect(await jobsOn(s.owner, s.businessId, bookDay)).toHaveLength(0)

  // Again, on the day after, and Book anyway: booked as well.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  sheet = await openNewJob(page, s.slug, bookDay)
  await chooseProperty(page, sheet, 'Jane Nguyen', /12 Wattle St/)
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await sheet.getByRole('button', { name: 'Book job' }).click()
  panel = panelOf(sheet)
  await expect(panel).toContainText('Already booked')
  await sheet.getByRole('button', { name: 'Book anyway' }).click()
  await expect(sheet).toBeHidden()
  await expect
    .poll(async () => (await jobsOn(s.owner, s.businessId, bookDay)).length)
    .toBe(1)
  expect(await jobsOn(s.owner, s.businessId, jobDay)).toHaveLength(1)
})

test('with no signal, the same from the copy kept on the phone, saying when it was last right', async ({
  page,
  context,
}) => {
  const s = await seedSites('site-offline')
  // Booked on the page's today, beside a job two days from now: the page
  // opened afresh with no signal is the start page, today's Schedule by
  // the page's own clock, and its New Job books there. Two days, so that
  // today is still within a week of the job and never the job's own day
  // if Perth's midnight passes while the copy is kept and the clock is
  // moved on.
  const jobDay = addDaysToKey(perthToday(), 2)
  const booked = await bookAt(s.owner, s, s.janeSite, jobDay)
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(newJobButton(page)).toBeEnabled()
  await keepPageInWorker(page)
  // What is booked at each site, and the client list, on the phone.
  await expect
    .poll(() => keptRow(page, 'jobs:openWork', s.businessId), {
      timeout: KEEP_TIMEOUT,
    })
    .toContain(booked.jobId)
  await expect
    .poll(() => keptRow(page, 'clients:directory', s.businessId), {
      timeout: KEEP_TIMEOUT,
    })
    .toContain('Jane Nguyen')

  await page.clock.setSystemTime(Date.now() + PAGE_AGE_MS)
  await context.setOffline(true)
  let bookDay = ''
  try {
    // Opened afresh from the Home Screen.
    await page.goto('/')
    await expect(page).toHaveURL(new RegExp(`/${s.slug}/schedule`))
    const sheet = await newJobOnPage(page)
    // The day it books on: today on the page's clock, moved on above.
    bookDay = await page.evaluate(
      (tz) =>
        new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()),
      TZ,
    )
    expect(bookDay).not.toBe(jobDay)
    await chooseProperty(page, sheet, 'Jane Nguyen', /12 Wattle St/)
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    const panel = panelOf(sheet)
    await expect(panel).toContainText(
      `12 Wattle St has a job on ${dateOf(jobDay)} at 10:00am — General Pest Control, Terence (#${booked.jobNumber}).`,
    )
    await expect(panel).toContainText(/From the jobs on this phone, updated \S/)
    await expect(
      panel.getByRole('button', { name: `Open #${booked.jobNumber}` }),
    ).toBeVisible()
    await sheet.getByRole('button', { name: 'Book anyway' }).click()
    // Sent, or kept on the phone, once there is signal.
    await expect(panelOf(sheet)).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
  await expect
    .poll(async () => (await jobsOn(s.owner, s.businessId, bookDay)).length, {
      timeout: 60_000,
    })
    .toBe(1)
  expect(await jobsOn(s.owner, s.businessId, jobDay)).toHaveLength(1)
})

test('a new client typed at her address under another name: the row names Jane Nguyen’s job (FW2)', async ({
  page,
}) => {
  const s = await seedSites('site-typed')
  const jobDay = addDaysToKey(perthToday(), 1)
  const booked = await bookAt(s.owner, s, s.janeSite, jobDay)
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug, addDaysToKey(jobDay, 1))

  await typeCaller(sheet, {
    name: 'Tom Nguyen',
    phone: '0491 570 737',
    street: '12 Wattle St',
    suburb: 'Bayswater',
    postcode: '6053',
  })
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await sheet.getByRole('button', { name: 'Book job' }).click()
  const panel = panelOf(sheet)
  await expect(panel).toContainText(
    `Already a site: 12 Wattle St, Bayswater is Jane Nguyen’s. Same address, different name. It has a job on ${dateOf(jobDay)} (#${booked.jobNumber}).`,
  )
  await expect(
    panel.getByRole('button', { name: 'Book on Jane Nguyen' }),
  ).toBeVisible()
  // Said once, in the row that names her: not again as a row of its own.
  await expect(panel.getByText(/^Already booked/)).toHaveCount(0)
})

test('a second quarterly Recurring Job where one already runs: Already repeats', async ({
  page,
}) => {
  const s = await seedSites('site-repeats')
  const first = addDaysToKey(perthToday(), 3)
  await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.oceanSite,
    assignedMembershipId: s.ownerMembership,
    intervalCount: 3,
    intervalUnit: 'month',
    jobType: 'General Pest Control',
    price: 18500,
    anchorDate: perthAt(first, 9),
    durationMinutes: 60,
  })
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug, perthToday())

  await chooseProperty(page, sheet, 'Ocean Pde', /5\/12 Ocean Pde/)
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await repeatQuarterly(sheet)
  await sheet.getByRole('button', { name: 'Book job' }).click()
  const panel = panelOf(sheet)
  await expect(panel).toContainText(
    `Already repeats: 5/12 Ocean Pde already has a Recurring Job: General Pest Control every 3 months, next ${dateOf(first)}.`,
  )
  await expect(
    panel.getByRole('button', { name: 'Open the Recurring Job' }),
  ).toBeVisible()
  // Its first visit, in the same week, isn't a row of its own.
  await expect(panel.getByText(/^Already booked/)).toHaveCount(0)
})

test('a subcontractor booking beside another member’s job: its date alone, and Book anyway books once (RK1)', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('site-sub')
  // The fixture's job's own day: a day read off the clock after it was
  // booked is tomorrow once the run crosses Perth midnight.
  const today = s.ownerJobDay
  const creates: Array<string> = []
  page.on('websocket', (ws) =>
    ws.on('framesent', ({ payload }) => {
      if (String(payload).includes('jobs:create')) creates.push(String(payload))
    }),
  )
  await signInViaUi(page, s.sub.email)
  const sheet = await openNewJob(page, s.slug, today)

  await chooseProperty(page, sheet, 'J. Nguyen', /12 Wattle Street/)
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await sheet.getByRole('button', { name: 'Book job' }).click()
  const panel = panelOf(sheet)
  await expect(panel).toContainText(
    `Already booked: 12 Wattle Street has another job booked on ${dateOf(today)}.`,
  )
  // Nothing of it but its date: no number, service, person or time, and
  // nothing to open (C5).
  await expect(panel).not.toContainText('Termite Inspection')
  await expect(panel).not.toContainText('Terence')
  await expect(panel.getByRole('button', { name: /^Open/ })).toHaveCount(0)
  await expect(panel).toContainText(
    'Press Book anyway to book this one as well.',
  )

  await sheet.getByRole('button', { name: 'Book anyway' }).click()
  await expect(sheet).toBeHidden()
  await expect
    .poll(async () => (await jobsOn(s.owner, s.businessId, today)).length)
    .toBe(2)
  expect(creates).toHaveLength(1)
})

test('three weeks away is no row: Book books on the first press', async ({
  page,
}) => {
  const s = await seedSites('site-far')
  const jobDay = addDaysToKey(perthToday(), 1)
  const farDay = addDaysToKey(jobDay, 21)
  await bookAt(s.owner, s, s.janeSite, jobDay)
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug, farDay)

  await chooseProperty(page, sheet, 'Jane Nguyen', /12 Wattle St/)
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()
  await expect
    .poll(async () => (await jobsOn(s.owner, s.businessId, farDay)).length)
    .toBe(1)
})

test('Book on her from a match row that named her job: the one press after the fix books (FW13)', async ({
  page,
}) => {
  const s = await seedSites('site-fw13')
  const jobDay = addDaysToKey(perthToday(), 1)
  const bookDay = addDaysToKey(jobDay, 1)
  const booked = await bookAt(s.owner, s, s.janeSite, jobDay)
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug, bookDay)

  await typeCaller(sheet, {
    name: 'Tom Nguyen',
    phone: '0491 570 737',
    street: '12 Wattle St',
    suburb: 'Bayswater',
    postcode: '6053',
  })
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await sheet.getByRole('button', { name: 'Book job' }).click()
  const panel = panelOf(sheet)
  await expect(panel).toContainText(
    `It has a job on ${dateOf(jobDay)} (#${booked.jobNumber}).`,
  )
  await panel.getByRole('button', { name: 'Book on Jane Nguyen' }).click()
  await expect(sheet.getByLabel('Property')).toContainText('Jane Nguyen')
  await expect(panelOf(sheet)).toHaveCount(0)

  // Her job was shown with the row the fix came from: no second panel.
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()
  await expect
    .poll(async () => (await jobsOn(s.owner, s.businessId, bookDay)).length)
    .toBe(1)
  const [job] = await jobsOn(s.owner, s.businessId, bookDay)
  expect(job.clientName).toBe('Jane Nguyen')
  expect(job.addressLine).toBe('12 Wattle St')
})

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

/**
 * The answer of `fn` the phone keeps for `businessId`, as JSON: '' until it
 * is written. Read straight from IndexedDB; never throws, so it can be
 * polled.
 */
async function keptRow(
  page: Page,
  fn: string,
  businessId: Id<'businesses'>,
): Promise<string> {
  return page
    .evaluate(
      async ([want, business]: [string, string]): Promise<string> => {
        const names = await indexedDB.databases()
        if (!names.some((db) => db.name === 'pestm8-offline')) return ''
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open('pestm8-offline')
          open.onsuccess = () => resolve(open.result)
          open.onerror = () => reject(open.error ?? new Error('not opened'))
        })
        try {
          if (!db.objectStoreNames.contains('rows')) return ''
          const rows = await new Promise<
            Array<{ fn: string; businessId: string; data: unknown }>
          >((resolve, reject) => {
            const request = db
              .transaction('rows', 'readonly')
              .objectStore('rows')
              .getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () =>
              reject(request.error ?? new Error('not read'))
          })
          const row = rows.find(
            (each) => each.fn === want && each.businessId === business,
          )
          return row ? JSON.stringify(row.data) : ''
        } finally {
          db.close()
        }
      },
      [fn, businessId] as [string, string],
    )
    .catch(() => '')
}
