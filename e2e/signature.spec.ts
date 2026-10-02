import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Id } from '../convex/_generated/dataModel'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
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
  // prints them too, so this asks about the signing screen specifically.
  const screen = page.getByRole('dialog')
  await expect(
    screen.getByText(/I hereby certify that the subterranean termite/),
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

  const screen = page.getByRole('dialog')
  const pad = screen.getByRole('img', {
    name: "Technician's Signature — sign here",
  })
  const done = screen.getByRole('button', { name: 'Done' })
  await expect(done).toBeDisabled()

  const screenBox = (await screen.boundingBox())!
  const box = (await pad.boundingBox())!
  // A long stroke straight down the phone: in a sheet, the drag that closed
  // it. Measured with the pen still down, after two frames, so anything the
  // first stroke shows or hides — the saved-signature button giving way to
  // "Save this as my signature" — has been laid out.
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(x, box.y + box.height - 12, { steps: 16 })
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  const screenNow = (await screen.boundingBox())!
  const padNow = (await pad.boundingBox())!
  expect(Math.abs(screenNow.x - screenBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(screenNow.y - screenBox.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(padNow.x - box.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(padNow.y - box.y)).toBeLessThanOrEqual(1)
  await page.mouse.up()
  await expect(done).toBeEnabled()

  // ✕ asks before a signature is thrown away, and keeping it keeps the ink.
  const discard = page
    .getByRole('alertdialog')
    .filter({ hasText: 'Discard this signature?' })
  await screen.getByRole('button', { name: 'Close' }).click()
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: 'Keep signing' }).click()
  await expect(discard).toHaveCount(0)
  await expect(done).toBeEnabled()
  // So does Escape.
  await page.keyboard.press('Escape')
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: 'Keep signing' }).click()

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

  const screen = page.getByRole('dialog')
  const pad = screen.getByRole('img', {
    name: "Technician's Signature — sign here",
  })
  // The pad's bitmap is the screen's own resolution, not a canvas's default
  // 300x150 stretched over the box: that put the ink beside the pen, soft,
  // and nowhere at all past the bitmap's edge. Measured on the pad's own box
  // (`clientWidth`), which on a turned screen is not its box on the screen.
  const sized = () =>
    pad.evaluate(
      (canvas: HTMLCanvasElement) =>
        canvas.width ===
          Math.round(canvas.clientWidth * window.devicePixelRatio) &&
        canvas.height ===
          Math.round(canvas.clientHeight * window.devicePixelRatio),
    )
  await expect.poll(sized).toBe(true)

  await draw(page, "Technician's Signature")
  await screen.getByRole('button', { name: 'Done' }).click()
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
  await expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled()
  await expect.poll(sized).toBe(true)
  await screen.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(screen).toHaveCount(0)
})

/** The pixel width and height in a PNG's header. */
function pngSize(bytes: ArrayBuffer) {
  const view = new DataView(bytes)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Whether the canvas has ink near a point in its own frame (CSS px). */
function inkNear(pad: Locator, x: number, y: number) {
  return pad.evaluate(
    (canvas: HTMLCanvasElement, [px, py]) => {
      const ratio = canvas.width / canvas.clientWidth
      const ctx = canvas.getContext('2d')!
      const size = Math.round(8 * ratio)
      const { data } = ctx.getImageData(
        Math.round(px * ratio) - size,
        Math.round(py * ratio) - size,
        size * 2,
        size * 2,
      )
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
      return false
    },
    [x, y] as const,
  )
}

test('a phone held upright signs on its side, and the saved image is the right way up', async ({
  page,
}) => {
  const { email, owner, businessId, slug, propertyId } =
    await setup('sig-turned')
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

  // This spec runs at phone width, held upright: the screen fills it, laid
  // out a quarter turn round, so the pad's own width runs down the screen.
  const screen = page.getByRole('dialog')
  const pad = screen.getByRole('img', {
    name: "Technician's Signature — sign here",
  })
  const turned = () =>
    pad.evaluate(
      (canvas: HTMLCanvasElement) =>
        canvas.clientWidth > canvas.getBoundingClientRect().width + 1,
    )
  const filled = (await screen.boundingBox())!
  expect(filled.x).toBeCloseTo(0, 0)
  expect(filled.y).toBeCloseTo(0, 0)
  expect(filled.width).toBeCloseTo(390, 0)
  expect(filled.height).toBeCloseTo(844, 0)
  expect(await turned()).toBe(true)

  // Across the pad as the signer sees it — down the screen of a phone held
  // upright — with a wave, as handwriting has, in the pad's top half as the
  // signer sees it: the right of the screen.
  const box = (await pad.boundingBox())!
  const at = (t: number) => ({
    x: box.x + box.width * (0.7 + 0.04 * Math.sin(t * Math.PI * 4)),
    y: box.y + box.height * (0.1 + 0.8 * t),
  })
  await page.mouse.move(at(0).x, at(0).y)
  await page.mouse.down()
  for (let i = 1; i <= 24; i++)
    await page.mouse.move(at(i / 24).x, at(i / 24).y)
  await page.mouse.up()

  // The ink is under the pen: halfway along the stroke in the pad's own
  // frame, and not where a mirrored reading would have put it.
  const mid = at(0.5)
  const local = {
    x: mid.y - box.y,
    y: box.x + box.width - mid.x,
  }
  const padHeight = await pad.evaluate((canvas) => canvas.clientHeight)
  expect(await inkNear(pad, local.x, local.y)).toBe(true)
  expect(await inkNear(pad, local.x, padHeight - local.y)).toBe(false)

  await screen.getByRole('button', { name: 'Done' }).click()
  await expect(
    page.getByRole('button', {
      name: "Technician's Signature — signed, sign again",
    }),
  ).toBeVisible()

  // What is saved is the ink, cut from the empty pad and drawn at least
  // 1,200 pixels across — and wide, as it was signed, not standing on end as
  // the phone was held.
  const urls = await owner.client.query(api.reports.signatureUrls, {
    businessId,
    reportId,
  })
  const image = await fetch(urls.technician)
  expect(image.headers.get('content-type')).toContain('image/png')
  const { width, height } = pngSize(await image.arrayBuffer())
  expect(width).toBeGreaterThanOrEqual(1200)
  expect(width).toBeLessThanOrEqual(2000)
  expect(width).toBeGreaterThan(height * 2)

  // A phone already on its side gets the screen as it is.
  await page.setViewportSize({ width: 844, height: 390 })
  await page
    .getByRole('button', {
      name: "Technician's Signature — signed, sign again",
    })
    .click()
  await expect(screen).toBeVisible()
  expect(await turned()).toBe(false)
})

test('a signature can be taken back: undone, cleared, discarded, and Back asks first', async ({
  page,
}) => {
  const { email, owner, businessId, slug, propertyId } =
    await setup('sig-takeback')
  const reportId = await createReport(
    owner.client,
    { businessId, propertyId },
    'serviceReport',
  )

  await signInViaUi(page, email)
  // Into the section from the report's overview, inside the app, so Back
  // stays in the app — a second page load would make Back leave the
  // document, which no page can stop.
  await page.goto(`/${slug}/reports/${reportId}`)
  await builderReady(page)
  const signButton = page.getByRole('button', {
    name: "Technician's Signature — sign",
  })
  await clickUntil(
    page.getByRole('button', { name: /TECHNICIAN'S RECOMMENDATIONS/ }),
    () => expect(signButton).toBeVisible({ timeout: 2_000 }),
  )
  await signButton.click()

  const screen = page.getByRole('dialog')
  const done = screen.getByRole('button', { name: 'Done' })
  const undo = screen.getByRole('button', { name: 'Undo the last stroke' })
  const clear = screen.getByRole('button', { name: 'Clear the signature' })
  await expect(undo).toBeDisabled()
  await expect(clear).toBeDisabled()

  // Undo takes one stroke at a time; Clear takes them all.
  await draw(page, "Technician's Signature")
  await draw(page, "Technician's Signature")
  await undo.click()
  await expect(done).toBeEnabled()
  await undo.click()
  await expect(done).toBeDisabled()
  await expect(undo).toBeDisabled()
  await draw(page, "Technician's Signature")
  await draw(page, "Technician's Signature")
  await clear.click()
  await expect(done).toBeDisabled()
  await expect(clear).toBeDisabled()

  // Discard closes the screen and signs nothing.
  await draw(page, "Technician's Signature")
  await screen.getByRole('button', { name: 'Close' }).click()
  const discard = page
    .getByRole('alertdialog')
    .filter({ hasText: 'Discard this signature?' })
  await discard.getByRole('button', { name: 'Discard' }).click()
  await expect(screen).toHaveCount(0)
  await expect(signButton).toBeVisible()
  // And focus is back on what opened it.
  await expect(signButton).toBeFocused()

  // The phone's Back asks too: keeping it stays put, with the ink.
  await signButton.click()
  await draw(page, "Technician's Signature")
  const url = page.url()
  // As the phone's Back does it: through the history, not a page load.
  await page.evaluate(() => history.back())
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: 'Keep signing' }).click()
  await expect(discard).toHaveCount(0)
  expect(page.url()).toBe(url)
  await expect(done).toBeEnabled()
  // Discarding lets Back go on, and the screen goes with it.
  await page.evaluate(() => history.back())
  await discard.getByRole('button', { name: 'Discard' }).click()
  await expect(screen).toHaveCount(0)
  await expect.poll(() => page.url()).not.toBe(url)

  const report = await owner.client.query(api.reports.get, {
    businessId,
    reportId,
  })
  expect(report!.signatureSlots?.technician).toBeUndefined()
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
  const screen = page.getByRole('dialog')
  await expect(
    screen.getByText(/The Client acknowledges and agrees with the contents/),
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
