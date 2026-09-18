import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { Id } from '../convex/_generated/dataModel'
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
  builderReady,
  createReport,
  sectionUrl,
  signReport,
} from './fixtures/reportPayloads'

/**
 * A signature is the evidence these documents rest on, so this spec is about
 * what is stored rather than what is drawn: that signing commits exactly once,
 * that what was signed records who, when and against which words, and that a
 * saved signature is only ever applied by the person it belongs to.
 */

test.use({ viewport: { width: 390, height: 844 } })

async function setup(label: string) {
  const email = uniqueEmail(label)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  return { email, owner, businessId, slug, propertyId }
}

async function draw(page: Page, label: string) {
  const pad = page.getByRole('img', { name: `${label} — sign here` })
  await pad.scrollIntoViewIfNeeded()
  const box = (await pad.boundingBox())!
  await page.mouse.move(box.x + 24, box.y + box.height * 0.6)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 40, box.y + box.height * 0.35, {
    steps: 10,
  })
  await page.mouse.up()
}

test('signing commits once, and records what was signed', async ({ page }) => {
  const { email, owner, businessId, slug, propertyId } = await setup('sig-once')
  const reportId = await createReport(
    owner.client,
    { businessId, propertyId },
    'termiteManagementCert',
  )

  // The pad used to upload on every pen lift: a five-stroke signature was five
  // uploads and five writes, any of which could half-fail.
  let uploads = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('storage/upload'))
      uploads++
  })

  await signInViaUi(page, email)
  await page.goto(
    sectionUrl(slug, reportId, 'termiteManagementCert', 'installerSignature'),
  )
  await builderReady(page)

  await page.getByRole('button', { name: 'Installer Signature — sign' }).click()

  // The words being agreed to are on the screen doing the agreeing — the form
  // prints them too, so this asks about the sheet specifically.
  const sheet = page.getByRole('dialog')
  await expect(
    sheet.getByText(/I hereby certify that the subterranean termite/),
  ).toBeVisible()

  // Several strokes, one signature.
  await draw(page, 'Installer Signature')
  await draw(page, 'Installer Signature')
  await draw(page, 'Installer Signature')
  expect(uploads).toBe(0)

  await page.getByRole('button', { name: 'Done' }).click()
  await expect(
    page.getByRole('button', {
      name: 'Installer Signature — signed, sign again',
    }),
  ).toBeVisible()
  expect(uploads).toBe(1)

  // And what is stored is the act, not just the image: when, how, against which
  // words, on which revision of the form.
  const report = await owner.client.query(api.reports.get, {
    businessId,
    reportId,
  })
  const slot = report!.signatureSlots!.installer
  expect(typeof slot).toBe('object')
  expect(slot).toMatchObject({
    method: 'drawn',
    templateVersion: report!.templateVersion,
  })
  expect((slot as { statement: string }).statement).toMatch(/I hereby certify/)
  expect((slot as { signedAt: number }).signedAt).toEqual(expect.any(Number))
})

test('a nothing-drawn pad cannot be committed', async ({ page }) => {
  const { email, owner, businessId, slug, propertyId } =
    await setup('sig-blank')
  const reportId = await createReport(
    owner.client,
    { businessId, propertyId },
    'serviceReport',
  )

  await signInViaUi(page, email)
  await page.goto(
    sectionUrl(slug, reportId, 'serviceReport', 'technicianSignature'),
  )
  await builderReady(page)

  await page
    .getByRole('button', { name: "Technician's Signature — sign" })
    .click()
  // A blank image is not a signature, and refusing to commit one says so more
  // honestly than storing an empty PNG would.
  await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled()
})

test('a saved signature is offered to its owner, and to nobody else', async ({
  page,
}) => {
  const { email, owner, businessId, slug, propertyId } =
    await setup('sig-saved')
  const first = await createReport(
    owner.client,
    { businessId, propertyId },
    'serviceReport',
  )

  await signInViaUi(page, email)
  await page.goto(
    sectionUrl(slug, first, 'serviceReport', 'technicianSignature'),
  )
  await builderReady(page)

  await page
    .getByRole('button', { name: "Technician's Signature — sign" })
    .click()
  await draw(page, "Technician's Signature")
  // Offered only once something has been drawn to save, and on by default:
  // signing your own name on every report is the thing worth saving.
  await expect(page.getByLabel('Save this as my signature')).toBeChecked()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(
    page.getByRole('button', {
      name: "Technician's Signature — signed, sign again",
    }),
  ).toBeVisible()

  // On the next report it is one tap, with nothing to draw.
  const second = await createReport(
    owner.client,
    { businessId, propertyId },
    'serviceReport',
  )
  await page.goto(
    sectionUrl(slug, second, 'serviceReport', 'technicianSignature'),
  )
  await builderReady(page)
  await page
    .getByRole('button', { name: "Technician's Signature — sign" })
    .click()
  await page.getByRole('button', { name: 'Use my saved signature' }).click()
  await expect(
    page.getByRole('button', {
      name: "Technician's Signature — signed, sign again",
    }),
  ).toBeVisible()

  const report = await owner.client.query(api.reports.get, {
    businessId,
    reportId: second,
  })
  expect(report!.signatureSlots!.technician).toMatchObject({ method: 'saved' })

  // The client's pad never offers it. A saved signature applied by somebody
  // else is forgery with extra steps, however convenient.
  await page.goto(sectionUrl(slug, second, 'serviceReport', 'clientSignature'))
  await builderReady(page)
  await page
    .getByRole('button', { name: 'Signature — sign', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Use my saved signature' }),
  ).toHaveCount(0)
})

test('a client signing sees the statement and gives their name', async ({
  page,
}) => {
  const { email, owner, businessId, slug, propertyId } =
    await setup('sig-client')
  const reportId = await createReport(
    owner.client,
    { businessId, propertyId },
    'timberPestInspection',
  )

  await signInViaUi(page, email)
  await page.goto(
    sectionUrl(slug, reportId, 'timberPestInspection', 'clientSignature'),
  )
  await builderReady(page)

  await page.getByRole('button', { name: 'Signature — sign' }).click()

  // Handed the phone, a client sees what they are agreeing to on the screen
  // they are signing, not somewhere above the fold on the form behind it.
  const sheet = page.getByRole('dialog')
  await expect(
    sheet.getByText(/The Client acknowledges and agrees with the contents/),
  ).toBeVisible()

  // And who signed is recorded: an agent or a tenant may sign for the client.
  await draw(page, 'Signature')
  await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled()
  await page.getByLabel('Name').fill('R. Chen')
  await page.getByRole('button', { name: 'Done' }).click()

  await expect
    .poll(async () => {
      const report = await owner.client.query(api.reports.get, {
        businessId,
        reportId,
      })
      return report!.signatureSlots?.client
    })
    .toMatchObject({ signedBy: 'R. Chen', method: 'drawn' })
})

test('a colleague’s saved signature cannot be put on your report, however it is labelled', async () => {
  const s = await setupBusinessWithSub('sig-colleague')

  // The owner signs and keeps it, as the pad does by default.
  const ownerReport = await createReport(s.owner.client, s, 'serviceReport')
  const uploadUrl = await s.owner.client.mutation(
    api.reports.generateUploadUrl,
    {
      businessId: s.businessId,
    },
  )
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  })
  const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
  await s.owner.client.mutation(api.reports.attachSignature, {
    businessId: s.businessId,
    reportId: ownerReport,
    storageId,
    slot: 'technician',
    saveForMember: true,
  })

  // Reading the owner's report does not hand out the image's id…
  const read = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: ownerReport,
  })
  expect(read!.signatureSlots!.technician).not.toHaveProperty('storageId')
  expect(read!.context.signatureUrls.technician).toBeTruthy()

  // …and holding it anyway is not enough. Not as "my saved signature", and
  // not dressed up as a fresh drawing either.
  const theirs = await createReport(s.sub.client, s, 'serviceReport')
  for (const method of ['saved', 'drawn'] as const) {
    await expectRejected(
      () =>
        s.sub.client.mutation(api.reports.attachSignature, {
          businessId: s.businessId,
          reportId: theirs,
          storageId,
          slot: 'technician',
          method,
        }),
      'NOT_YOUR_SIGNATURE',
    )
  }

  // Their own drawing is fine, of course.
  await signReport(s.sub.client, s, theirs, 'technician')
})
