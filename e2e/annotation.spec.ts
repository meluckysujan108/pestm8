import { deflateSync } from 'node:zlib'
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * A hand-rolled PNG encoder — the 1x1 fixture PNG other specs use is too
 * small to draw a meaningful stroke on (the annotation canvas caps at
 * `min(naturalWidth, 640)`, so a 1x1 source stays 1x1). No image library is
 * a devDependency here, so this builds a real, valid solid-colour PNG
 * directly: IHDR, one IDAT of raw (uncompressed-filter) scanlines deflated,
 * IEND.
 */
function solidColourPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(size, 0)
  ihdrData.writeUInt32BE(size, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 2 // colour type: RGB
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0

  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 3
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
    }
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdrData),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG_200 = solidColourPng(200, [80, 140, 80])

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
  const reportId = await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    data: {},
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)

  const input = page.locator(
    '[data-gallery-field="photos"] input[type=file]',
  )
  await input.setInputFiles({
    name: 'wall.png',
    mimeType: 'image/png',
    buffer: PNG_200,
  })
  await expect(
    page.getByLabel('Report photos photo 1 — caption'),
  ).toBeVisible({ timeout: 20_000 })

  const photoBefore = await page.getByRole('img', { name: 'Report photos photo 1' }).getAttribute('src')

  await page.getByRole('button', { name: 'Annotate Report photos photo 1' }).click()

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
  const photoAfter = await page.getByRole('img', { name: 'Report photos photo 1' }).getAttribute('src')
  expect(photoAfter).not.toBe(photoBefore)

  await owner.client.mutation(api.reports.finalise, {
    businessId,
    reportId,
    data: { safeToStart: true, treatments: [] },
  })
  await page.reload()
  await expect(page.getByText('Finalised and locked')).toBeVisible()
  // The finalised document's `ReportGallery` labels an uncaptioned photo by
  // its field, not positionally like the builder's `GalleryTile` does.
  const photoFinal = await page.getByRole('img', { name: 'Report photos' }).getAttribute('src')
  expect(photoFinal).toBe(photoAfter)
})

test('a finalised report rejects new annotations', async () => {
  const s = await setupBusinessWithSub('annotate-lock')

  const reportId = await s.owner.client.mutation(api.reports.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    data: {},
  })

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

  await s.owner.client.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId,
    data: { safeToStart: true, treatments: [] },
  })

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
