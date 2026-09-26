import { expect, test } from '@playwright/test'
import { api, setupBusinessWithSub, signInViaUi } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The owner's view menu, beside the + in the header: God view, just his own
 * jobs, or someone else's account.
 *
 * Runs on the phone layout too (playwright.config.ts). The phone is where he
 * wants "Just my jobs" — standing in a roof void, not at a desk — and it is
 * where the header has the least room to take a fourth control.
 */

async function ownerWithKevinsJob(label: string) {
  const setup = await setupBusinessWithSub(label)
  // The fixture's own job is the owner's Termite Inspection; this one is
  // Kevin's, on the same day, so God view and "Just my jobs" differ.
  await setup.owner.client.mutation(api.jobs.create, {
    businessId: setup.businessId,
    propertyId: setup.propertyId,
    assignedMembershipId: setup.subMembershipId,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: Date.now(),
    durationMinutes: 60,
  })
  return setup
}

const ownJob = (page: Page) =>
  page.getByRole('button', { name: /Termite Inspection/ })
const kevinsJob = (page: Page) =>
  page.getByRole('button', { name: /General Pest Control/ })

async function choose(page: Page, item: RegExp) {
  await page.getByRole('button', { name: 'Whose jobs to show' }).click()
  await page.getByRole('menuitemradio', { name: item }).click()
}

test('God view shows everyone; "Just my jobs" shows his own and simplifies', async ({
  page,
}) => {
  const { owner, slug } = await ownerWithKevinsJob('view-mine')

  await signInViaUi(page, owner.email)
  await page.goto(`/${slug}/schedule`)

  // God view is the default — on the phone as on the desktop.
  await expect(ownJob(page)).toBeVisible()
  await expect(kevinsJob(page)).toBeVisible()

  await choose(page, /Just my jobs/)

  await expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible()
  await expect(ownJob(page)).toBeVisible()
  await expect(kevinsJob(page)).toBeHidden()
  // Whose jobs these are is no longer a question, so nothing asks it.
  await expect(
    page.getByRole('button', { name: 'Filter by staff' }),
  ).toBeHidden()
  await expect(page.getByText('Team this month')).toBeHidden()

  await choose(page, /God view/)

  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  await expect(kevinsJob(page)).toBeVisible()
})

/**
 * Filtered to Kevin in God view, then switched to his own jobs: without the
 * reset, the list would hold only the owner's jobs and the filter would still
 * want Kevin's — "No matches", with the staff picker hidden in that view
 * and so no way to see why.
 */
test('changing view starts the filters over', async ({ page }) => {
  const { owner, slug } = await ownerWithKevinsJob('view-filters')

  await signInViaUi(page, owner.email)
  await page.goto(`/${slug}/schedule`)
  await expect(kevinsJob(page)).toBeVisible()
  // The filter chip has no hydration guard of its own, and a click before
  // hydration is silently swallowed; the view menu's trigger does, so it is
  // the readiness signal.
  await expect(
    page.getByRole('button', { name: 'Whose jobs to show' }),
  ).toBeEnabled()

  await page.getByRole('button', { name: 'Filter by staff' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /Kevin/ }).click()
  await expect(ownJob(page)).toBeHidden()

  await choose(page, /Just my jobs/)

  await expect(ownJob(page)).toBeVisible()
  await expect(page.getByText('No matches', { exact: true })).toBeHidden()
})

test('the choice belongs to this device: another sign-in stays in God view', async ({
  page,
  browser,
}) => {
  const { owner, slug } = await ownerWithKevinsJob('view-device')

  await signInViaUi(page, owner.email)
  await page.goto(`/${slug}/schedule`)
  await choose(page, /Just my jobs/)
  await expect(kevinsJob(page)).toBeHidden()

  // The office machine: a separate browser, so a separate session.
  const office = await browser.newContext()
  try {
    const desk = await office.newPage()
    await signInViaUi(desk, owner.email)
    await desk.goto(`/${slug}/schedule`)
    await expect(kevinsJob(desk)).toBeVisible()
    await expect(ownJob(desk)).toBeVisible()
  } finally {
    await office.close()
  }

  // And the phone is still where he left it.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible()
})

test('working in Kevin’s account is one pick away, and so is coming back', async ({
  page,
}) => {
  const { owner, businessId, slug } = await ownerWithKevinsJob('view-account')

  await signInViaUi(page, owner.email)

  // Switching lives in this menu, not twice over: the Settings hub's own list
  // of accounts is for everyone but the owner. The server would give him one
  // — Kevin is in it — so its absence is the page's doing, not an empty list.
  const targets = await owner.client.query(api.accountSwitches.targets, {
    businessId,
  })
  expect(targets.map((t) => t.name)).toContain('Kevin')

  await page.goto(`/${slug}/settings`)
  // For him the hub's list would arrive over the socket after hydration, not
  // in the HTML: the loader does not ask for it. The view menu's names come
  // the same way, asked for at the same moment — so once Kevin is in the
  // menu, the list would have been too.
  await page.getByRole('button', { name: 'Whose jobs to show' }).click()
  await expect(page.getByRole('menuitemradio', { name: /Kevin/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('main').getByText('Work in another account'),
  ).toHaveCount(0)

  await page.goto(`/${slug}/schedule`)
  await choose(page, /Kevin/)
  const banner = page.getByText(/Working in .*’s account/)
  await expect(banner).toBeVisible()
  await expect(kevinsJob(page)).toBeVisible()
  await expect(ownJob(page)).toBeHidden()

  await choose(page, /God view/)
  await expect(banner).toBeHidden()
  await expect(ownJob(page)).toBeVisible()
})

test('nobody else gets the menu', async ({ page }) => {
  const { sub, slug } = await setupBusinessWithSub('view-sub')

  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Whose jobs to show' }),
  ).toHaveCount(0)
})

/**
 * The header's height is load-bearing on a phone: the week strip is pinned at
 * a hard-coded 75px beneath it (schedule.tsx) — a hair inside the header's
 * 75.4px, so no slit of page shows between them — and a fourth control that
 * grew the header would slide it over the strip.
 */
test('the header keeps its height with the menu in it', async ({ page }) => {
  const { owner, slug } = await ownerWithKevinsJob('view-header')

  await signInViaUi(page, owner.email)
  await page.goto(`/${slug}/schedule`)

  const trigger = page.getByRole('button', { name: 'Whose jobs to show' })
  await expect(trigger).toBeEnabled()
  const header = await page.locator('header').first().boundingBox()
  const box = await trigger.boundingBox()
  expect(header && header.height).toBeLessThanOrEqual(76.5)
  expect(box && box.height).toBe(36)
})
