import { expect, test } from '@playwright/test'
import { api, setupBusinessWithSub, signInViaUi } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The view menu, beside the + in the header: Overview, My jobs, or — for the
 * owner — someone else's account. Everyone whose lists can show more than
 * their own work has it, and every device opens in My jobs.
 *
 * Runs on the phone layout too (playwright.config.ts). The phone is where
 * My jobs matters — standing in a roof void, not at a desk — and it is where
 * the header has the least room to take a fourth control.
 *
 * The fixtures put each sign-in in Overview (`chooseOverview`); the tests
 * about where a device opens sign in with 'mine' to leave it there.
 */

async function ownerWithKevinsJob(label: string) {
  const setup = await setupBusinessWithSub(label)
  // The fixture's own job is the owner's Termite Inspection; this one is
  // Kevin's, on the same day, so Overview and My jobs differ. At the
  // same moment, not a fresh `Date.now()`, which past Perth midnight is the
  // next day. Each page opens on that day (`ownerJobDay`) for the same reason.
  await setup.owner.client.mutation(api.jobs.create, {
    businessId: setup.businessId,
    propertyId: setup.propertyId,
    assignedMembershipId: setup.subMembershipId,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: setup.ownerJobAt,
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

test('he opens in My jobs, which simplifies; Overview shows everyone', async ({
  page,
}) => {
  const { owner, slug, ownerJobDay } = await ownerWithKevinsJob('view-mine')

  await signInViaUi(page, owner.email, undefined, undefined, 'mine')
  await page.goto(`/${slug}/schedule?date=${ownerJobDay}`)

  // My jobs is where the device opens — on the phone as on the desktop.
  await expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible()
  await expect(ownJob(page)).toBeVisible()
  await expect(kevinsJob(page)).toBeHidden()
  // Whose jobs these are is no longer a question, so nothing asks it: the
  // filters keep their status, and lose their Technician.
  await page.getByRole('button', { name: /^Filter/ }).click()
  await expect(
    page.getByRole('dialog').getByRole('group', { name: 'Status' }),
  ).toBeVisible()
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Technician' }),
  ).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('Team this month')).toBeHidden()

  await choose(page, /Overview/)

  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  await expect(kevinsJob(page)).toBeVisible()
  await expect(ownJob(page)).toBeVisible()

  await choose(page, /My jobs/)
  await expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible()
  await expect(kevinsJob(page)).toBeHidden()
})

/**
 * Filtered to Kevin in Overview, then switched to his own jobs: without the
 * reset, the list would hold only the owner's jobs and the filter would still
 * want Kevin's — "No matches", with the staff picker hidden in that view
 * and so no way to see why.
 */
test('changing view starts the filters over', async ({ page }) => {
  const { owner, slug, ownerJobDay } = await ownerWithKevinsJob('view-filters')

  await signInViaUi(page, owner.email)
  await page.goto(`/${slug}/schedule?date=${ownerJobDay}`)
  await expect(kevinsJob(page)).toBeVisible()
  // The filter chip has no hydration guard of its own, and a click before
  // hydration is silently swallowed; the view menu's trigger does, so it is
  // the readiness signal.
  await expect(
    page.getByRole('button', { name: 'Whose jobs to show' }),
  ).toBeEnabled()

  await page.getByRole('button', { name: /^Filter/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: /Kevin/ }).click()
  await expect(ownJob(page)).toBeHidden()
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/[?&]staff=/)

  await choose(page, /My jobs/)

  await expect(ownJob(page)).toBeVisible()
  await expect(page.getByText('No matches', { exact: true })).toBeHidden()
  // Taken out of the address as well, so a reload doesn't bring it back.
  await expect(page).not.toHaveURL(/[?&]staff=/)
})

test('the choice belongs to this device: another sign-in opens in My jobs', async ({
  page,
  browser,
}) => {
  const { owner, slug, ownerJobDay } = await ownerWithKevinsJob('view-device')

  await signInViaUi(page, owner.email, undefined, undefined, 'mine')
  await page.goto(`/${slug}/schedule?date=${ownerJobDay}`)
  await expect(kevinsJob(page)).toBeHidden()
  await choose(page, /Overview/)
  await expect(kevinsJob(page)).toBeVisible()

  // The office machine: a separate browser, so a separate session.
  const office = await browser.newContext()
  try {
    const desk = await office.newPage()
    await signInViaUi(desk, owner.email, undefined, undefined, 'mine')
    await desk.goto(`/${slug}/schedule?date=${ownerJobDay}`)
    await expect(desk.getByRole('heading', { name: 'My jobs' })).toBeVisible()
    await expect(ownJob(desk)).toBeVisible()
    await expect(kevinsJob(desk)).toBeHidden()
  } finally {
    await office.close()
  }

  // And the phone is still where he left it.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  await expect(kevinsJob(page)).toBeVisible()
})

test('working in Kevin’s account is one pick away, and so is coming back', async ({
  page,
}) => {
  const { owner, businessId, slug, ownerJobDay } =
    await ownerWithKevinsJob('view-account')

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

  await page.goto(`/${slug}/schedule?date=${ownerJobDay}`)
  await choose(page, /Kevin/)
  const banner = page.getByText(/Working in .*’s account/)
  await expect(banner).toBeVisible()
  await expect(kevinsJob(page)).toBeVisible()
  await expect(ownJob(page)).toBeHidden()

  await choose(page, /Overview/)
  await expect(banner).toBeHidden()
  await expect(ownJob(page)).toBeVisible()
})

/**
 * Kevin, given "View only" for other people's jobs on Settings → Team: his day stays his own,
 * and everyone's is one pick away — the same menu as the owner's, without
 * anyone's account in it.
 */
test('a subcontractor allowed to see all jobs gets Overview and My jobs', async ({
  page,
}) => {
  const setup = await ownerWithKevinsJob('view-kevin')
  await setup.owner.client.mutation(api.memberships.setGrants, {
    businessId: setup.businessId,
    membershipId: setup.subMembershipId,
    grants: {
      switchInto: null,
      clientDirectory: true,
      prices: false,
      otherSchedules: true,
    },
  })

  await signInViaUi(page, setup.sub.email, undefined, undefined, 'mine')
  await page.goto(`/${setup.slug}/schedule?date=${setup.ownerJobDay}`)

  await expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible()
  await expect(kevinsJob(page)).toBeVisible()
  await expect(ownJob(page)).toBeHidden()

  await page.getByRole('button', { name: 'Whose jobs to show' }).click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(2)
  await expect(page.getByText('Work in another account')).toHaveCount(0)
  await page.getByRole('menuitemradio', { name: /Overview/ }).click()

  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  await expect(ownJob(page)).toBeVisible()
  await expect(kevinsJob(page)).toBeVisible()
})

test('a subcontractor who sees only their own jobs gets no menu', async ({
  page,
}) => {
  const { sub, slug } = await setupBusinessWithSub('view-sub')

  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Whose jobs to show' }),
  ).toHaveCount(0)
})

/**
 * The header's height should not change with the menu in it: a fourth
 * control that grew the header would push every page down under a thumb.
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
