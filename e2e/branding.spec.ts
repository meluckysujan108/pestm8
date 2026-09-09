import { expect, test } from '@playwright/test'
import {
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
  uniqueEmail,
  FIXTURE_PASSWORD,
  signUpActor,
} from './fixtures'

/** Smallest valid PNG — enough to exercise compress → upload → attach. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('an owner can set branding details and a logo, and they survive a reload', async ({
  page,
}) => {
  const email = uniqueEmail('branding-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `Branding Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/settings?seg=prefs`)

  // The Save button stays disabled until the page hydrates (see
  // ProfileSection/signInViaUi) — filling before then lands on markup React
  // is still replacing and can be silently wiped when hydration reconciles.
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()

  await page.getByLabel('Address').fill('14 Ocean Drive')
  await page.getByLabel('Suburb').fill('Fremantle')
  await page.getByLabel('Postcode').fill('6160')
  await page.getByLabel('Phone').fill('0400 123 456')
  await page.getByLabel('Email').fill('office@baysidepest.example')
  await page.getByLabel('Business licence number').fill('PMT-88213')

  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByRole('button', { name: 'Change logo' })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('img', { name: 'Business logo' })).toBeVisible()

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('Address')).toHaveValue('14 Ocean Drive')
  await expect(page.getByLabel('Suburb')).toHaveValue('Fremantle')
  await expect(page.getByLabel('Postcode')).toHaveValue('6160')
  await expect(page.getByLabel('Phone')).toHaveValue('0400 123 456')
  await expect(page.getByLabel('Email')).toHaveValue(
    'office@baysidepest.example',
  )
  await expect(page.getByLabel('Business licence number')).toHaveValue(
    'PMT-88213',
  )
  await expect(page.getByRole('img', { name: 'Business logo' })).toBeVisible()
})

test('a subcontractor cannot edit business branding', async () => {
  const s = await setupBusinessWithSub('branding-lock')

  await expectRejected(
    () =>
      s.sub.client.mutation(api.businesses.update, {
        businessId: s.businessId,
        addressLine: 'Snuck-in address',
      }),
    'NO_ACCESS',
  )
  await expectRejected(
    () =>
      s.sub.client.mutation(api.businesses.generateUploadUrl, {
        businessId: s.businessId,
      }),
    'NO_ACCESS',
  )
})
