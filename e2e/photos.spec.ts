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
import {
  createCustomReport,
  customSectionUrl,
  customTemplateArgs,
} from './fixtures/reportPayloads'

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
  // Fixed named photo slots ("Before" / "After") live on in business-authored
  // templates; the retired built-in that used them had no source form.
  const templateId = await owner.client.mutation(api.customTemplates.create, {
    businessId,
    ...customTemplateArgs(),
  })
  const reportId = await createCustomReport(
    owner.client,
    { businessId, propertyId },
    templateId,
  )

  await signInViaUi(page, email)
  await page.goto(customSectionUrl(slug, reportId))

  // The slot announces its own state, so this asserts what a screen reader
  // would hear rather than poking at the <img> the button's label hides. It
  // is also the hydration signal: the slot stays disabled until its input has
  // an `onChange`, and files set before then are silently dropped.
  await expect(
    page.getByRole('button', { name: /Before photo, none yet/ }),
  ).toBeEnabled()

  // The input is hidden behind the tile, so set files on it directly.
  // Scoped to the slot rather than positionally: `.first()` silently
  // retargets the moment another file input is added to the screen.
  await page.locator('[data-photo-slot="Before"] input[type=file]').setInputFiles({
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
    data: { product: 'Termidor' },
  })

  await page.reload()
  await expect(page.getByText('Finalised and locked')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Before' })).toBeVisible()
})

test('a finalised report accepts no further photos', async () => {
  const s = await setupBusinessWithSub('photo-lock')

  const templateId = await s.owner.client.mutation(api.customTemplates.create, {
    businessId: s.businessId,
    ...customTemplateArgs(),
  })
  const reportId = await createCustomReport(s.owner.client, s, templateId)

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
