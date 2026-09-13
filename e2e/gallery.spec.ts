import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { createReport, finaliseReport } from './fixtures/reportPayloads'

/** Smallest valid PNG — enough to exercise compress → upload → attach. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * A report can have more than one photo field — the Service Report has both a
 * front-page cover photo and a general "Report Photos" gallery — so, unlike
 * `photos.spec.ts`'s `input[type=file]).first()` (safe there because a report
 * has only one slot-photo field), the target field has to be scoped
 * explicitly by its key rather than by DOM position.
 */
function galleryFileInput(page: Page, fieldKey: string) {
  return page.locator(`[data-gallery-field="${fieldKey}"] input[type=file]`)
}

test('photos in a gallery field can be uploaded, captioned, reordered and removed', async ({
  page,
}) => {
  const email = uniqueEmail('gallery-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `Gallery ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const reportId = await createReport(
    owner.client,
    { businessId, propertyId },
    'serviceReport',
  )

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)


  // "Report Photos" only shows while the form's own "Add Photos?" is Yes.
  await page
    .getByRole('group', { name: 'Add Photos?' })
    .getByRole('button', { name: 'Yes', exact: true })
    .click()
  const input = galleryFileInput(page, 'photos')

  // --- first photo: no cover toggle yet, nothing to distinguish it from ---
  await input.setInputFiles({
    name: 'first.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await expect(
    page.getByLabel('Report Photos photo 1 — caption', { exact: true }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    page.getByRole('button', { name: /Report Photos photo 1 — (set as cover|cover photo)/ }),
  ).toHaveCount(0)

  // --- second photo: now there is a set, so the cover flag means something ---
  await input.setInputFiles({
    name: 'second.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await expect(page.getByLabel('Report Photos photo 2 — caption', { exact: true })).toBeVisible()

  // --- caption ---
  await page.getByLabel('Report Photos photo 1 — caption', { exact: true }).fill('Front garden bed')
  await page.getByLabel('Report Photos photo 1 — caption', { exact: true }).blur()
  await expect(
    page.getByRole('img', { name: 'Front garden bed' }),
  ).toBeVisible()

  // --- cover: exclusive, setting the second clears the first ---
  await page
    .getByRole('button', { name: 'Report Photos photo 2 — set as cover', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Report Photos photo 2 — cover photo', exact: true }),
  ).toBeVisible()

  // --- reorder: moving photo 2 up swaps it with photo 1 ---
  await page
    .getByRole('button', { name: 'Move Report Photos photo 2 up', exact: true })
    .click()
  // The cover photo's caption was empty; the captioned one is now second.
  await expect(
    page.getByRole('img', { name: 'Front garden bed' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Report Photos photo 1 — cover photo', exact: true }),
  ).toBeVisible()

  // --- remove: back to one photo, and the cover toggle disappears again ---
  // After the swap above, "photo 1" is the cover (no caption) and "photo 2"
  // is the captioned one — labels are positional, not tied to upload order,
  // so removing "photo 1" here is what leaves the captioned photo behind.
  await page
    .getByRole('button', { name: 'Remove Report Photos photo 1', exact: true })
    .click()
  await expect(
    page.getByLabel('Report Photos photo 2 — caption', { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /Report Photos photo 1 — (set as cover|cover photo)/ }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('img', { name: 'Front garden bed' }),
  ).toBeVisible()

  // --- survives onto the finalised document, evidence intact ---
  await finaliseReport(owner.client, { businessId }, reportId, 'serviceReport')
  await page.reload()
  await expect(page.getByText('Finalised and locked')).toBeVisible()
  await expect(
    page.getByRole('img', { name: 'Front garden bed' }),
  ).toBeVisible()
})

test('a finalised report accepts no further gallery photos', async () => {
  const s = await setupBusinessWithSub('gallery-lock')

  const reportId = await createReport(s.owner.client, s, 'serviceReport')

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

  await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

  // Photos are evidence; a locked report must not gain new ones afterwards —
  // the same guarantee `attachPhoto` gives the fixed-slot kind.
  await expectRejected(
    () =>
      s.owner.client.mutation(api.reports.addGalleryPhoto, {
        businessId: s.businessId,
        reportId,
        fieldKey: 'photos',
        storageId: storageId as never,
      }),
    'REPORT_FINALISED',
  )
})
