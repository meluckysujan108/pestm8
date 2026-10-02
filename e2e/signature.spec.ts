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
import { CLIENT_SIGNATURES_SHOWN } from '../src/lib/reportTemplates/settings'

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
  // else is forgery with extra steps, however convenient. The client's pad
  // shares §4 with the technician's, so this is the same screen either way.
  // Reloaded only once the signed answer has been saved: left to its
  // debounce, the reload finds it still on this phone, and the page opens
  // under "Unsaved answers on this phone" instead.
  await expect
    .poll(
      async () =>
        (
          await owner.client.query(api.reports.get, {
            businessId,
            reportId: second,
          })
        )?.data?.technicianSignature,
    )
    .toBeTruthy()
  await page.goto(sectionUrl(slug, second, 'serviceReport', 'clientSignature'))
  await builderReady(page)
  if (CLIENT_SIGNATURES_SHOWN) {
    await page
      .getByRole('button', { name: 'Signature — sign', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: 'Use my saved signature' }),
    ).toHaveCount(0)
  } else {
    // While client signatures are off there is no client's pad to offer it
    // on. Asked once the technician's pad is on the screen, so a page that
    // has not drawn yet cannot pass for one without the client's.
    await expect(
      page.getByRole('button', {
        name: "Technician's Signature — signed, sign again",
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Signature — sign', exact: true }),
    ).toHaveCount(0)
  }
})

test('a client is not asked to sign a report being filled in', async ({
  page,
}) => {
  test.skip(CLIENT_SIGNATURES_SHOWN, 'client signatures are switched on')
  const { email, owner, businessId, slug, propertyId } =
    await setup('sig-no-client')
  const timber = await createReport(
    owner.client,
    { businessId, propertyId },
    'timberPestInspection',
  )
  const service = await createReport(
    owner.client,
    { businessId, propertyId },
    'serviceReport',
  )

  await signInViaUi(page, email)

  // The Timber Pest form's §9 is the client's sign-off and nothing else, so
  // the whole section is left out, not left as a screen with nothing on it.
  // Read from the overview: `sectionUrl` finds sections in the whole form,
  // and a link to one a draft does not show lands back on the overview, where
  // its absence would prove nothing.
  await page.goto(`/${slug}/reports/${timber}`)
  await builderReady(page)
  await expect(
    page.getByRole('button', { name: /CONTACT THE INSPECTOR/ }).first(),
  ).toBeVisible()
  await expect(
    page.getByText('CLIENT ACKNOWLEDGMENT OF THIS REPORT'),
  ).toHaveCount(0)

  // The Service Report's client pad shares §4 with the technician's, so §4
  // stays and only the client's pad goes.
  await page.goto(
    sectionUrl(slug, service, 'serviceReport', 'technicianSignature'),
  )
  await builderReady(page)
  await expect(
    page.getByRole('button', { name: "Technician's Signature — sign" }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Signature — sign', exact: true }),
  ).toHaveCount(0)
})

test('the pad holds still while a signature is drawn', async ({ page }) => {
  const { email, owner, businessId, slug, propertyId } =
    await setup('sig-still')
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

  const sheet = page.getByRole('dialog')
  const pad = sheet.getByRole('img', {
    name: "Technician's Signature — sign here",
  })
  const done = sheet.getByRole('button', { name: 'Done' })
  // A sheet is dragged down by a press anywhere in it that is not marked
  // otherwise, so a downward stroke on the pad pulled the sheet, the pad and
  // the line being drawn down with it.
  await expect(pad).toHaveAttribute('data-vaul-no-drag')

  // Vaul will not start a drag while anything behind the press is scrolled,
  // and reaching §4's pad scrolled the page. At the top, only the sheet's
  // lock and the pad's marker stop it; left scrolled, this passes on a pad
  // that still moves. Each guard is checked on its own as well: the marker
  // above, the lock by the tap outside and the ✕ below.
  await page.evaluate(() => window.scrollTo(0, 0))
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(
    0,
  )
  // And it ignores a drag for the first half-second a sheet is open.
  await page.waitForTimeout(700)

  const sheetTop = (await sheet.boundingBox())!.y
  const box = (await pad.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + 12
  // 300px down, the length of a sheet-closing swipe, but kept on the screen:
  // the sheet sits at the bottom of a phone-height page.
  const bottom = page.viewportSize()!.height - 4
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, Math.min(y + 300, bottom), { steps: 12 })
  // Two frames, so anything the first stroke changed has been laid out.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )

  // Measured with the pen still down: the sheet has not moved, and nothing
  // the first stroke shows or hides has moved the pad inside it.
  expect(
    Math.abs((await sheet.boundingBox())!.y - sheetTop),
  ).toBeLessThanOrEqual(1)
  expect(Math.abs((await pad.boundingBox())!.y - box.y)).toBeLessThanOrEqual(1)
  await page.mouse.up()

  await expect(sheet).toBeVisible()
  await expect(done).toBeEnabled()

  // A signature is not thrown away by a tap beside the sheet…
  await page.mouse.click(5, 5)
  await expect(sheet).toHaveAttribute('data-state', 'open')
  await expect(done).toBeEnabled()

  // …and ✕ asks first. Keeping it keeps the ink, and Done still signs.
  await sheet.getByRole('button', { name: 'Close' }).click()
  const discard = page
    .getByRole('alertdialog')
    .filter({ hasText: 'Discard your changes?' })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: 'Keep editing' }).click()
  await expect(discard).toHaveCount(0)
  await expect(done).toBeEnabled()
  await done.click()
  await expect(
    page.getByRole('button', {
      name: "Technician's Signature — signed, sign again",
    }),
  ).toBeVisible()
})

test('a pad opened again starts blank, sharp, and closes without asking', async ({
  page,
}) => {
  const { email, owner, businessId, slug, propertyId } =
    await setup('sig-again')
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

  const sheet = page.getByRole('dialog')
  const pad = sheet.getByRole('img', {
    name: "Technician's Signature — sign here",
  })
  // The pad's bitmap is the screen's own resolution, not a canvas's default
  // 300x150 stretched over the box: that put the ink beside the pen, soft,
  // and nowhere at all past the bitmap's edge.
  const sized = () =>
    pad.evaluate((canvas: HTMLCanvasElement) => {
      const rect = canvas.getBoundingClientRect()
      return (
        canvas.width === Math.round(rect.width * window.devicePixelRatio) &&
        canvas.height === Math.round(rect.height * window.devicePixelRatio)
      )
    })
  await expect.poll(sized).toBe(true)

  await draw(page, "Technician's Signature")
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(
    page.getByRole('button', {
      name: "Technician's Signature — signed, sign again",
    }),
  ).toBeVisible()

  // Opened again, it is a new pad: nothing to commit, nothing to discard.
  await page
    .getByRole('button', {
      name: "Technician's Signature — signed, sign again",
    })
    .click()
  await expect(sheet.getByRole('button', { name: 'Done' })).toBeDisabled()
  await expect.poll(sized).toBe(true)
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(sheet).toHaveCount(0)
})

test('a client signing sees the statement and gives their name', async ({
  page,
}) => {
  test.skip(!CLIENT_SIGNATURES_SHOWN, 'client signatures are switched off')
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
