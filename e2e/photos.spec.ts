import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/** Smallest valid PNG — enough to exercise compress → upload → attach. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('a photo uploaded in the builder survives onto the finalised document', async ({
  page,
}) => {
  const email = uniqueEmail('photo-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `Photos ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const reportId = await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId,
    template: 'treatmentRecord',
    legalBasis: 'APVMA',
    data: {},
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)

  // The slot announces its own state, so this asserts what a screen reader
  // would hear rather than poking at the <img> the button's label hides.
  await expect(
    page.getByRole('button', { name: /Before photo, none yet/ }),
  ).toBeEnabled()

  // The input is hidden behind the tile, so set files on it directly.
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'before.png',
    mimeType: 'image/png',
    buffer: PNG,
  })

  await expect(
    page.getByRole('button', { name: /Before photo, uploaded/ }),
  ).toBeVisible({ timeout: 20_000 })

  // It must still be attached once the report is locked — evidence that
  // disappears on finalise is worse than never capturing it.
  await owner.client.mutation(api.reports.finalise, {
    businessId,
    reportId,
    data: {
      product: 'Termidor',
      activeConstituent: 'Fipronil',
      apvmaNumber: '62873',
      batchNumber: 'B-1',
      dilutionRate: '10 mL/L',
      targetPest: 'Termites',
      treatedAreas: ['Kitchen'],
    },
  })

  await page.reload()
  await expect(page.getByText('Finalised and locked')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Before' })).toBeVisible()
})

test('a finalised report accepts no further photos', async () => {
  const s = await setupBusinessWithSub('photo-lock')

  const reportId = await s.owner.client.mutation(api.reports.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    template: 'treatmentRecord',
    legalBasis: 'APVMA',
    data: {},
  })

  const uploadUrl = await s.owner.client.mutation(
    api.reports.generateUploadUrl,
    { businessId: s.businessId },
  )
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG,
  })
  const { storageId } = (await res.json()) as { storageId: string }

  await s.owner.client.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId,
    data: { product: 'Termidor' },
  })

  // Photos are evidence; a locked report must not gain new ones afterwards.
  await expectRejected(
    () =>
      s.owner.client.mutation(api.reports.attachPhoto, {
        businessId: s.businessId,
        reportId,
        storageId: storageId as never,
        slot: 'After',
      }),
    'REPORT_FINALISED',
  )
})
