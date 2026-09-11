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

/** Smallest valid PNG — enough to exercise compress → upload → attach. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * A report can have more than one `gallery` field — this template has both a
 * single-photo "Front page photo" and a general "Report photos" — so, unlike
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
  const reportId = await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    data: {},
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)

  const input = galleryFileInput(page, 'photos')

  // --- first photo: no cover toggle yet, nothing to distinguish it from ---
  await input.setInputFiles({
    name: 'first.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await expect(page.getByLabel('Report photos photo 1 — caption')).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    page.getByRole('button', {
      name: /Report photos photo 1 — (set as cover|cover photo)/,
    }),
  ).toHaveCount(0)

  // --- second photo: now there is a set, so the cover flag means something ---
  await input.setInputFiles({
    name: 'second.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await expect(page.getByLabel('Report photos photo 2 — caption')).toBeVisible()

  // --- caption ---
  await page
    .getByLabel('Report photos photo 1 — caption')
    .fill('Front garden bed')
  await page.getByLabel('Report photos photo 1 — caption').blur()
  await expect(
    page.getByRole('img', { name: 'Front garden bed' }),
  ).toBeVisible()

  // --- cover: exclusive, setting the second clears the first ---
  await page
    .getByRole('button', { name: 'Report photos photo 2 — set as cover' })
    .click()
  await expect(
    page.getByRole('button', { name: 'Report photos photo 2 — cover photo' }),
  ).toBeVisible()

  // --- reorder: moving photo 2 up swaps it with photo 1 ---
  await page
    .getByRole('button', { name: 'Move Report photos photo 2 up' })
    .click()
  // The cover photo's caption was empty; the captioned one is now second.
  await expect(
    page.getByRole('img', { name: 'Front garden bed' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Report photos photo 1 — cover photo' }),
  ).toBeVisible()

  // --- remove: back to one photo, and the cover toggle disappears again ---
  // After the swap above, "photo 1" is the cover (no caption) and "photo 2"
  // is the captioned one — labels are positional, not tied to upload order,
  // so removing "photo 1" here is what leaves the captioned photo behind.
  await page
    .getByRole('button', { name: 'Remove Report photos photo 1' })
    .click()
  await expect(page.getByLabel('Report photos photo 2 — caption')).toHaveCount(
    0,
  )
  await expect(
    page.getByRole('button', {
      name: /Report photos photo 1 — (set as cover|cover photo)/,
    }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('img', { name: 'Front garden bed' }),
  ).toBeVisible()

  // --- survives onto the finalised document, evidence intact ---
  await owner.client.mutation(api.reports.finalise, {
    businessId,
    reportId,
    data: { safeToStart: true, treatments: [] },
  })
  await page.reload()
  await expect(page.getByText('Finalised and locked')).toBeVisible()
  await expect(
    page.getByRole('img', { name: 'Front garden bed' }),
  ).toBeVisible()
})

test('a finalised report accepts no further gallery photos', async () => {
  const s = await setupBusinessWithSub('gallery-lock')

  const reportId = await s.owner.client.mutation(api.reports.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
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
    data: { safeToStart: true, treatments: [] },
  })

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
