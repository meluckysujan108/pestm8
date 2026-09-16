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
import { builderReady, createReport, finaliseReport, sectionUrl } from './fixtures/reportPayloads'
import { solidPng } from './fixtures/png'

const PNG_200 = solidPng(200, 200)


test('a gallery photo can be annotated, and the annotated version survives finalise', async ({
  page,
}) => {
  const email = uniqueEmail('annotate-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `Annotate Co ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
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
  await page.goto(sectionUrl(slug, reportId, 'serviceReport', 'addPhotos'))

  // A tap before hydration is dropped: the server-rendered button has no
  // handler yet, and "Report Photos" would never appear.
  await builderReady(page)

  // "Report Photos" only shows while the form's own "Add Photos?" is Yes.
  await page
    .getByRole('group', { name: 'Add Photos?' })
    .getByRole('button', { name: 'Yes', exact: true })
    .click()
  const input = page.locator(
    '[data-gallery-field="photos"] input[data-photo-source="library"]',
  )
  // The add button stays disabled until the field hydrates; see the same wait
  // in gallery.spec.ts for when that matters.
  await expect(
    page.getByRole('button', { name: 'Report Photos — add photos' }),
  ).toBeEnabled()
  await input.setInputFiles({
    name: 'wall.png',
    mimeType: 'image/png',
    buffer: PNG_200,
  })
  await expect(
    page.getByLabel('Report Photos photo 1 — caption', { exact: true }),
  ).toBeVisible({ timeout: 20_000 })

  const photoBefore = await page.getByRole('img', { name: 'Report Photos photo 1', exact: true }).getAttribute('src')

  await page.getByRole('button', { name: 'Annotate Report Photos photo 1', exact: true }).click()

  const canvas = page.getByRole('img', { name: 'Photo annotation canvas' })
  await expect(canvas).toBeVisible()
  // The canvas exists as soon as the editor mounts, but sizes itself off the
  // image only once it finishes loading — drawing before then is a no-op.
  // Its default bitmap is 300x300, so waiting for that to change is the
  // readiness signal.
  await expect
    .poll(() => canvas.evaluate((el: HTMLCanvasElement) => el.width))
    .not.toBe(300)
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 10 })
  await page.mouse.up()

  await page.getByRole('button', { name: 'Save annotation' }).click()
  await expect(canvas).toHaveCount(0, { timeout: 20_000 })

  // A new storage id means a new URL — proves the stroke was actually
  // composited and re-uploaded, not just a no-op close.
  const photoAfter = await page.getByRole('img', { name: 'Report Photos photo 1', exact: true }).getAttribute('src')
  expect(photoAfter).not.toBe(photoBefore)

  await finaliseReport(owner.client, { businessId }, reportId, 'serviceReport')
  await page.reload()
  await expect(page.getByText('Finalised and locked')).toBeVisible()
  // The finalised document's `ReportGallery` labels an uncaptioned photo by
  // its field, not positionally like the builder's `GalleryTile` does.
  const photoFinal = await page.getByRole('img', { name: 'Report Photos', exact: true }).getAttribute('src')
  expect(photoFinal).toBe(photoAfter)
})

test('a finalised report rejects new annotations', async () => {
  const s = await setupBusinessWithSub('annotate-lock')

  const reportId = await createReport(s.owner.client, s, 'serviceReport')

  const uploadUrl = await s.owner.client.mutation(api.reports.generateUploadUrl, {
    businessId: s.businessId,
  })
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG_200),
  })
  const { storageId } = (await uploadRes.json()) as { storageId: string }
  await s.owner.client.mutation(api.reports.addGalleryPhoto, {
    businessId: s.businessId,
    reportId,
    fieldKey: 'photos',
    storageId: storageId as never,
  })
  const [photo] = await s.owner.client.query(api.reports.galleryPhotos, {
    businessId: s.businessId,
    reportId,
  })
  const photoId = photo._id

  await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

  await expectRejected(
    () =>
      s.owner.client.mutation(api.reports.annotateGalleryPhoto, {
        businessId: s.businessId,
        reportId,
        photoId,
        storageId: storageId as never,
      }),
    'REPORT_FINALISED',
  )
})
