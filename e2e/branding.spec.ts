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
  await page.goto(`/${slug}/settings/business`)

  // The logo button stays disabled until the page hydrates (see
  // src/lib/useHydrated.ts) — filling before then lands on markup React is
  // still replacing and can be silently wiped when hydration reconciles. The
  // form's Save is no signal here: it only appears once something changes.
  await expect(page.getByRole('button', { name: 'Add logo' })).toBeEnabled()

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

  // One Save for the whole page, and only while something has changed.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible()

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

test('an owner can edit business name, state and ABN, and a subcontractor is shown none of it', async ({
  page,
}) => {
  const email = uniqueEmail('businessinfo-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `Business Info Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/settings/business`)

  // Hydrated once the logo button is enabled (see the test above).
  await expect(page.getByRole('button', { name: 'Add logo' })).toBeEnabled()

  await page.getByLabel('Legal name').fill('Business Info Co (Renamed)')
  await page.getByLabel('State').selectOption('QLD')
  await page.getByLabel('ABN (optional)').fill('51 824 753 556')
  await expect(page.getByText('Australia/Brisbane')).toBeVisible()

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible()

  // Reloading proves the write landed server-side, not just in the form —
  // which reads the business live, so it would show the new values either
  // way.
  await page.reload()
  await expect(page.getByLabel('Legal name')).toHaveValue(
    'Business Info Co (Renamed)',
  )
  await expect(page.getByLabel('State')).toHaveValue('QLD')
  await expect(page.getByLabel('ABN (optional)')).toHaveValue('51 824 753 556')
  await expect(page.getByText('Australia/Brisbane')).toBeVisible()

  // What the business prints is the owner's to see to: a subcontractor who
  // opens the page by its address is told so, with nothing to read or change.
  const s = await setupBusinessWithSub('businessinfo-readonly')
  const subBusinesses = await s.sub.client.query(api.businesses.listForUser, {})
  const subSlug = subBusinesses.find((b) => b.businessId === s.businessId)!.slug

  await signInViaUi(page, s.sub.email)
  await page.goto(`/${subSlug}/settings/business`)

  await expect(
    page.getByText('Only the business owner can change these.'),
  ).toBeVisible()
  await expect(page.getByLabel('Legal name')).toHaveCount(0)
  await expect(page.getByLabel('Business licence number')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /logo/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
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
