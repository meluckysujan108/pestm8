import { expect, test } from '@playwright/test'
import { api, clickUntil, setupBusinessWithSub, signInViaUi } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Long lists load a page at a time (docs/design-system.md, "Long lists"):
 * the Job tab and the Clients page arrive with their first page in the page
 * itself, load the rest as the end comes near, and keep a "Show more" button
 * for anyone not scrolling. Search, filters and counts still cover the whole
 * book, not just what has loaded.
 *
 * A short, tall-enough-to-scroll viewport, so the first page does not already
 * reach the point where the next one loads by itself.
 */

const DAY = 24 * 60 * 60 * 1000

test.use({ viewport: { width: 420, height: 640 } })

/**
 * "Show more" is disabled until the page hydrates (docs/design-system.md):
 * scrolled or typed into before that, the page has no handlers yet, as for
 * a person on a slow phone — so the readiness signal is the button enabling.
 */
async function hydrated(page: Page, noun: 'jobs' | 'clients') {
  await expect(
    page.getByRole('button', { name: `Show more ${noun}` }),
  ).toBeEnabled()
}

async function scrollToEnd(page: Page) {
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  )
}

const jobCards = (page: Page) =>
  page.getByRole('button', { name: /General Pest Control|Termite Inspection/ })

test('the Job tab loads a page, then the rest as you scroll, and counts them all', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('paging-jobs')
  // The fixture booked one; 29 more makes 30 — a page of 24 and six more.
  for (let i = 0; i < 29; i++) {
    await s.owner.client.mutation(api.jobs.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt: Date.now() + (i + 1) * DAY,
      durationMinutes: 60,
    })
  }

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job`)

  await expect(jobCards(page)).toHaveCount(24)
  // The count is the whole book's, not the page's.
  await expect(page.getByText(/^30 jobs/)).toBeVisible()
  // The oldest — the fixture's own — is past the first page.
  await expect(
    page.getByRole('button', { name: /Termite Inspection/ }),
  ).toHaveCount(0)

  await hydrated(page, 'jobs')
  await scrollToEnd(page)
  await expect(jobCards(page)).toHaveCount(30)
  await expect(
    page.getByRole('button', { name: /Termite Inspection/ }),
  ).toBeVisible()
  // Nothing left to load: the button goes.
  await expect(page.getByRole('button', { name: /Show more/ })).toHaveCount(0)
})

test('the status filter searches every job, not just the first page', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('paging-status')
  // The fixture's job, cancelled, then 26 newer ones: it is well past the
  // first page of everything, and the only cancelled job.
  await s.owner.client.mutation(api.jobs.cancel, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  for (let i = 0; i < 26; i++) {
    await s.owner.client.mutation(api.jobs.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt: Date.now() + (i + 1) * DAY,
      durationMinutes: 60,
    })
  }

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job?status=cancelled`)
  await expect(jobCards(page)).toHaveCount(1)
  await expect(jobCards(page).first()).toContainText('Termite Inspection')
  await expect(page.getByText(/^1 job/)).toBeVisible()
})

test('Clients opens on the newest page, finds anyone by search, and loads the rest', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('paging-clients')
  // The fixture's J. Nguyen first, then 35 more: 36 in all.
  for (let i = 1; i <= 35; i++) {
    const n = String(i).padStart(2, '0')
    await s.owner.client.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: `Paging Client ${n}`,
      addressLine: `${i} Paging Street`,
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
  }

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/clients`)

  const cards = page
    .locator('main button')
    .filter({ hasText: /Paging Client|J\. Nguyen/ })
  await expect(cards).toHaveCount(30)
  await expect(cards.first()).toContainText('Paging Client 35')
  await expect(page.getByText('36 clients')).toBeVisible()

  // The oldest is not on the first page, but search finds it.
  await hydrated(page, 'clients')
  const search = page.getByLabel('Search by name or address')
  await search.fill('nguyen')
  await expect(page).toHaveURL(/[?&]q=nguyen(&|$)/)
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('J. Nguyen')

  // Part of a street, as today: the search runs over every client.
  await search.fill('7 paging')
  await expect(cards.filter({ hasText: 'Paging Client 07' })).toHaveCount(1)
  await search.fill('')
  await expect(page).not.toHaveURL(/[?&]q=/)

  await expect(cards).toHaveCount(30)
  await scrollToEnd(page)
  await expect(cards).toHaveCount(36)
  await expect(cards.last()).toContainText('J. Nguyen')
})

test('an archived client stays off Clients, and stays pickable — last, labelled — in New Job', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('paging-archived')
  const propertyId = await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'Zed Archived',
    addressLine: '9 Old Road',
    suburb: 'Midland',
    state: 'WA',
    postcode: '6056',
  })
  const property = await s.owner.client.query(api.properties.get, {
    businessId: s.businessId,
    propertyId,
  })
  await s.owner.client.mutation(api.clients.archive, {
    businessId: s.businessId,
    clientId: property!.clientId,
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/clients?q=zed`)
  await expect(
    page.locator('main button').filter({ hasText: 'Zed Archived' }),
  ).toHaveCount(0)
  // Nor is it counted: J. Nguyen is the one client.
  await expect(page.getByText(/^1 client$/)).toBeVisible()

  await page.goto(`/${s.slug}/schedule`)
  const newJob = page.getByRole('dialog')
  await clickUntil(page.getByRole('button', { name: 'New job' }), () =>
    expect(newJob.getByText('New job').first()).toBeVisible({ timeout: 2_000 }),
  )
  await newJob.getByRole('button', { name: 'Property' }).click()
  await page
    .getByRole('textbox', { name: 'Search by name or address' })
    .fill('zed')
  await expect(
    page.getByRole('button', { name: /Zed Archived \(archived\)/ }),
  ).toBeVisible()
})

test('"Just my jobs" and back keeps the Job tab whole, with nothing twice', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('paging-view')
  // 27 more jobs, every third one Kevin's: 28 in all, 19 the owner's.
  for (let i = 0; i < 27; i++) {
    await s.owner.client.mutation(api.jobs.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId:
        i % 3 === 0 ? s.subMembershipId : s.ownerMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt: Date.now() + (i + 1) * DAY,
      durationMinutes: 60,
    })
  }

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job`)
  await expect(jobCards(page)).toHaveCount(24)
  await hydrated(page, 'jobs')
  await scrollToEnd(page)
  await expect(jobCards(page)).toHaveCount(28)

  const choose = async (item: RegExp) => {
    await page.getByRole('button', { name: 'Whose jobs to show' }).click()
    await page.getByRole('menuitemradio', { name: item }).click()
  }

  await choose(/Just my jobs/)
  await expect(jobCards(page)).toHaveCount(19)

  // A job booked meanwhile, then back to everyone's.
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: Date.now() + 40 * DAY,
    durationMinutes: 60,
  })
  await choose(/God view/)
  await expect(page.getByText(/^29 jobs/)).toBeVisible()
  await scrollToEnd(page)
  await expect(jobCards(page)).toHaveCount(29)
  await expect(page.getByText('No jobs yet')).toHaveCount(0)
})
