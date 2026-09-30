import { expect, test } from '@playwright/test'
import {
  api,
  chooseStatus,
  clickUntil,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'
import type { Page } from '@playwright/test'

/**
 * A client's status, number and place in the list (30 Sept 2026): the status
 * is a pill that is always shown and changed by tapping it, as a job's is;
 * the number heads the sheet and is given automatically; and a client just
 * added is at the top of the list and of New Job's picker.
 */

const DAY = 24 * 60 * 60 * 1000

async function openClient(page: Page, slug: string, name: RegExp) {
  await page.goto(`/${slug}/clients`)
  const sheet = page.getByRole('dialog')
  await clickUntil(page.getByRole('button', { name }).first(), () =>
    expect(sheet).toBeVisible({ timeout: 2_000 }),
  )
  return sheet
}

test('a client’s status is shown and changed from its pill, and saves at once', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('client-status')
  await signInViaUi(page, s.owner.email)
  const sheet = await openClient(page, s.slug, /J\. Nguyen/)

  // Active is shown, not hidden, and the number heads the sheet.
  await expect(
    sheet.getByRole('button', { name: 'Change client status' }),
  ).toContainText('Active')
  await expect(sheet.getByText(/^Client #\d+$/)).toBeVisible()

  await chooseStatus(page, 'Lead', 'client')
  await expect(
    sheet.getByRole('button', { name: 'Change client status' }),
  ).toContainText('Lead')
  const property = await s.owner.client.query(api.properties.list, {
    businessId: s.businessId,
  })
  expect(property[0].client?.status).toBe('lead')
})

test('marking a client Inactive offers to stop their recurring services', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('client-inactive')
  const recurrenceId = await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    intervalCount: 1,
    intervalUnit: 'month',
    jobType: 'General Pest Control',
    price: 18500,
    anchorDate: Date.now() + 2 * DAY,
    durationMinutes: 60,
  })
  await signInViaUi(page, s.owner.email)
  const sheet = await openClient(page, s.slug, /J\. Nguyen/)

  await chooseStatus(page, 'Inactive', 'client')
  await expect(sheet.getByText(/1 recurring service still runs/)).toBeVisible()

  await sheet.getByRole('button', { name: 'Stop them' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(
    confirm.getByText(/Stop J\. Nguyen’s recurring services\?/),
  ).toBeVisible()
  await confirm.getByRole('button', { name: 'Stop services' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(sheet.getByText(/still runs/)).toHaveCount(0)

  const running = await s.owner.client.query(api.recurrences.listForBusiness, {
    businessId: s.businessId,
  })
  expect(running.find((r) => r._id === recurrenceId)?.active).toBe(false)
})

test('editing a client: the owner may change the number; the form asks before a change is thrown away', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('client-edit')
  await signInViaUi(page, s.owner.email)
  const sheet = await openClient(page, s.slug, /J\. Nguyen/)

  await sheet.getByRole('button', { name: 'Edit client details' }).click()
  await expect(sheet.getByText(/^Editing client #\d+$/)).toBeVisible()
  // Status is the pill's job now, not the form's.
  await expect(sheet.getByRole('radiogroup', { name: 'Status' })).toHaveCount(0)
  await expect(sheet.getByLabel('Client number')).toBeVisible()
  await expect(
    sheet.getByText('Given automatically.', { exact: false }),
  ).toBeVisible()

  await sheet.getByLabel('Client name').fill('J. Nguyen Jr')
  await page.keyboard.press('Escape')
  const discard = page
    .getByRole('alertdialog')
    .filter({ hasText: 'Discard your changes?' })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: 'Keep editing' }).click()
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet.getByText(/^Editing client/)).toHaveCount(0)
  await expect(
    sheet.getByRole('heading', { name: 'J. Nguyen Jr' }),
  ).toBeVisible()
})

test('a contact being typed keeps the client’s Edit away, so it cannot be thrown out', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('client-subform')
  await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    kind: 'business',
    clientName: 'Mahal Mart',
    addressLine: '14 Kewdale Road',
    suburb: 'Kewdale',
    state: 'WA',
    postcode: '6105',
  })
  await signInViaUi(page, s.owner.email)
  const sheet = await openClient(page, s.slug, /Mahal Mart/)
  await expect(
    sheet.getByRole('button', { name: 'Edit client details' }),
  ).toBeVisible()
  await sheet.getByRole('button', { name: 'Add contact' }).click()
  await sheet.getByPlaceholder('Name').fill('Jan Morris')
  await expect(
    sheet.getByRole('button', { name: 'Edit client details' }),
  ).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(
    sheet.getByRole('button', { name: 'Edit client details' }),
  ).toBeVisible()
})

test('the newest client is first on the Clients page and in New Job’s picker', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('client-newest')
  // Added after J. Nguyen, and before them alphabetically only by A–Z.
  await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'Zara Hussain',
    addressLine: '12 Beach Road',
    suburb: 'Scarborough',
    state: 'WA',
    postcode: '6019',
  })
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/clients`)

  const names = page
    .locator('main button')
    .filter({ hasText: /Zara Hussain|J\. Nguyen/ })
  await expect(names.first()).toContainText('Zara Hussain')
  await page.getByRole('tab', { name: 'A–Z' }).click()
  await expect(page).toHaveURL(/[?&]sort=az/)
  await expect(names.first()).toContainText('J. Nguyen')

  // New Job's picker opens on the newest, under "Added recently".
  await page.goto(`/${s.slug}/schedule`)
  const add = page.getByRole('button', { name: 'New job' })
  const newJob = page.getByRole('dialog')
  await clickUntil(add, () =>
    expect(newJob.getByText('New job').first()).toBeVisible({ timeout: 2_000 }),
  )
  await newJob.getByRole('button', { name: 'Property' }).click()
  const picker = page.getByRole('dialog', { name: 'Property' })
  await expect(
    picker.getByRole('heading', { name: 'Added recently' }),
  ).toBeVisible()
  await expect(
    picker.getByRole('button', { name: /Zara Hussain/ }),
  ).toContainText(/Added /)
})
