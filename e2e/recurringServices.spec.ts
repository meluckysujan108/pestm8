import { expect, test } from '@playwright/test'
import { api, setupBusinessWithSub, signInViaUi } from './fixtures'

/**
 * The Recurring Job page by service (30 Sept 2026): one card per running
 * service that opens to its visits, a visit opening its job on the page, and
 * "By date" keeping the list of visits.
 */

const DAY = 24 * 60 * 60 * 1000

test('the Recurring Job page lists each service, and opens it to its visits', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('recurring-services')
  const service = (unit: 'week' | 'year', jobType: string, anchor: number) =>
    s.owner.client.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 1,
      intervalUnit: unit,
      jobType,
      price: 18500,
      anchorDate: anchor,
      durationMinutes: 60,
    })
  await service('week', 'General Pest Control', Date.now() + DAY)
  // Nothing of it within the six months the engine books: still a card.
  await service('year', 'Termite Inspection', Date.now() - 30 * DAY)

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job/recurring`)
  await expect(
    page.getByText('2 Recurring Jobs', { exact: true }),
  ).toBeVisible()
  const byService = page.getByRole('tab', { name: 'By service' })
  await expect(byService).toHaveAttribute('aria-selected', 'true')

  const weekly = page.getByRole('button', {
    name: /^J\. Nguyen General Pest Control · Every week/,
  })
  const yearly = page.getByRole('button', {
    name: /^J\. Nguyen Termite Inspection · Every year/,
  })
  await expect(weekly).toContainText(/Next \w{3} \d+ \w+/)
  await expect(yearly).toContainText(/Due \w{3} \d+ \w+/)

  // Opened, it lists what is coming; a visit opens its job here. Enabled
  // once the page has hydrated: a tap before that would open nothing.
  await expect(weekly).toBeEnabled()
  await weekly.click()
  await expect(weekly).toHaveAttribute('aria-expanded', 'true')
  const card = page.locator('li').filter({ has: weekly })
  await expect(card.getByRole('heading', { name: 'Coming up' })).toBeVisible()
  await card
    .getByRole('button', { name: /Booked|Pending|Recurring/ })
    .first()
    .click()
  await expect(page).toHaveURL(/\/job\/recurring\?.*jobId=/)
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: 'General Pest Control', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // By date: the visits themselves, as cards.
  await page.getByRole('tab', { name: 'By date' }).click()
  await expect(page).toHaveURL(/[?&]view=date/)
  await expect(
    page.getByRole('button', { name: /General Pest Control/ }).first(),
  ).toContainText('Every week')
})
