import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { builderReady, createReport, sectionUrl } from './fixtures/reportPayloads'

/**
 * Filling a report, the way a technician does it: an overview of the form, one
 * section at a time, and a lock that says what is missing instead of refusing
 * silently.
 *
 * Runs at phone width because that is where the work happens — standing in
 * someone's back garden, not at a desk.
 */

test.use({ viewport: { width: 390, height: 844 } })

async function startJobReport(label: string) {
  const email = uniqueEmail(label)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, { businessId })
  const jobId = await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: members.find((m) => m.role === 'owner')!._id,
    jobType: 'General Pest Control',
    price: 21000,
    scheduledAt: Date.now(),
    durationMinutes: 60,
  })
  const reportId = await createReport(owner.client, { businessId, propertyId, jobId }, 'serviceReport')
  return { email, owner, businessId, slug, reportId }
}

test('a report opens on its sections, and is filled one at a time', async ({ page }) => {
  const { email, slug, reportId } = await startJobReport('fill-sections')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)
  await builderReady(page)

  // The overview is the whole form at a glance: every section of the Service
  // Report, with what each still wants.
  for (const title of [
    'CLIENT & SITE DETAILS',
    'TREATMENT, PRODUCT(S) AND QUANTITIES APPLIED',
    'RISK ASSESSMENT',
    "TECHNICIAN'S RECOMMENDATIONS & COMMENTS",
  ]) {
    await expect(page.getByRole('button', { name: new RegExp(title.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first()).toBeVisible()
  }

  // Opening one shows that section, and not the rest of the form.
  await page.getByRole('button', { name: /CLIENT & SITE DETAILS/ }).first().click()
  await expect(page.getByRole('heading', { name: '1. CLIENT & SITE DETAILS' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /RISK ASSESSMENT/ })).toHaveCount(0)
  // And says where it sits, in the form's own numbering.
  await expect(page.getByText('Section 1 of 4')).toBeVisible()

  // The section it is on survives a refresh: a technician who locks their
  // phone mid-job comes back to the question they were on.
  await page.reload()
  await builderReady(page)
  await expect(page.getByRole('heading', { name: '1. CLIENT & SITE DETAILS' })).toBeVisible()

  await page.getByRole('button', { name: /^Next:/ }).click()
  await expect(
    page.getByRole('heading', { name: '2. TREATMENT, PRODUCT(S) AND QUANTITIES APPLIED' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: '1. CLIENT & SITE DETAILS' })).toBeVisible()
})

test('a suggested answer is marked, and confirmed by moving on', async ({ page }) => {
  const { email, owner, businessId, slug, reportId } = await startJobReport('fill-confirm')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)
  await builderReady(page)

  // The start time came from the booking, so the form says so rather than
  // passing it off as something the technician recorded.
  // On the overview itself: the desktop rail says the same thing, and on a
  // phone it is the overview the technician is looking at.
  await expect(
    page.getByRole('navigation', { name: 'Report sections' }).getByText(/[0-9]+ answers? to confirm/),
  ).toBeVisible()
  await page.getByRole('button', { name: /CLIENT & SITE DETAILS/ }).first().click()
  await expect(page.getByText('Suggested').first()).toBeVisible()

  // Reading the section and moving on IS the confirmation.
  await page.getByRole('button', { name: /^Next:/ }).click()
  await expect(page.getByRole('heading', { name: /2\./ })).toBeVisible()

  await expect
    .poll(async () => {
      const report = await owner.client.query(api.reports.get, { businessId, reportId })
      return report!.prefill!.startTime.confirmedAt !== undefined
    })
    .toBe(true)
})

test('finalising an unfinished report says what is missing, and jumps there', async ({ page }) => {
  const { email, slug, reportId } = await startJobReport('fill-blocked')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)
  await builderReady(page)

  // Never greyed out: pressing it is how a technician finds out what is left.
  await page.getByRole('button', { name: 'Finalise & lock' }).first().click()

  // Each entry is the form's own words for what is wrong, not a field name.
  const outstanding = page.getByRole('alert')
  await expect(outstanding).toContainText('to finish')
  const safety = outstanding.getByRole('button', {
    name: /Record whether it is safe to commence work/,
  })
  await expect(safety).toBeVisible()

  // And each one is a way into the section that asks it.
  await safety.click()
  await expect(page.getByRole('heading', { name: '3. RISK ASSESSMENT' })).toBeVisible()
  await expect(
    page.getByRole('group', { name: 'Is it safe to commence work?' }),
  ).toBeVisible()
})

test('a long answer list is searched, not scrolled', async ({ page }) => {
  const { email, slug, reportId } = await startJobReport('fill-picker')

  await signInViaUi(page, email)
  await page.goto(sectionUrl(slug, reportId, 'serviceReport', 'treatments'))
  await builderReady(page)

  // A treatment row is four choices, not four stacked lists: 13 products, 13
  // treatments, 10 methods and 6 quantities came to 42 checkbox rows for one
  // row of the grid.
  await expect(page.getByRole('checkbox', { name: 'Advion Ant Gel (0.5 g/kg Indoxacarb)' })).toHaveCount(0)

  await page.getByRole('button', { name: /Product & Active Ingredient — choose/ }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('checkbox', { name: /Biflex Ultra/ })).toBeVisible()

  // Search narrows to the one the technician is holding.
  await sheet.getByLabel(/^Search /).fill('fipronil')
  await expect(sheet.getByRole('checkbox', { name: /Fipforce HP/ })).toBeVisible()
  await expect(sheet.getByRole('checkbox', { name: /Biflex Ultra/ })).toHaveCount(0)

  await sheet.getByRole('checkbox', { name: /Fipforce HP/ }).click()
  await sheet.getByRole('button', { name: 'Done' }).click()

  // And the answer reads back on the row, in the form's own words — including
  // to a screen reader, which hears the answer rather than "choose".
  await expect(
    page.getByRole('button', { name: /Product & Active Ingredient — Fipforce HP/ }),
  ).toBeVisible()
})

test('a clean safety checklist is one tap, and never answers the safety gate', async ({ page }) => {
  const { email, owner, businessId, slug, reportId } = await startJobReport('fill-quick')

  await signInViaUi(page, email)
  await page.goto(sectionUrl(slug, reportId, 'serviceReport', 'safetyChecklists'))
  await builderReady(page)

  await page.getByRole('button', { name: /Yes to all/ }).click()
  // Gone once there is nothing left for it to settle.
  await expect(page.getByRole('button', { name: /Yes to all/ })).toHaveCount(0)

  await expect
    .poll(async () => {
      const report = await owner.client.query(api.reports.get, { businessId, reportId })
      const data = report!.data as Record<string, unknown>
      return { ppe: data.ppe, msds: data.msds, safe: data.safeToStart }
    })
    // "Is it safe to commence work?" is the form's one mandatory gate. The app
    // answering it would defeat the only question the form insists on.
    .toEqual({ ppe: true, msds: true, safe: undefined })
})

test('a service report from a job reaches Finalise in well under 30 taps', async ({ page }) => {
  const { email, owner, businessId, slug, reportId } = await startJobReport('fill-taps')

  // Counts what a technician's thumb actually does, rather than the lines this
  // spec happens to be written in: every pointer press on the page, including
  // the ones inside sheets and on the signature canvas.
  await page.addInitScript(() => {
    ;(window as unknown as { __taps: number }).__taps = 0
    window.addEventListener(
      'pointerdown',
      () => {
        ;(window as unknown as { __taps: number }).__taps++
      },
      true,
    )
  })
  const taps = () => page.evaluate(() => (window as unknown as { __taps: number }).__taps)

  await signInViaUi(page, email)
  await page.goto(`/${slug}/reports/${reportId}`)
  await builderReady(page)
  const start = await taps()

  // 1. Client & site details: everything is already filled from the job and
  // the client record, so this section is read and passed.
  await page.getByRole('button', { name: /CLIENT & SITE DETAILS/ }).first().click()
  await page.getByRole('button', { name: /^Next:/ }).click()

  // 2. Treatments: the row is already started from the job type, so what is
  // left is what only the technician knows — product, quantity, method.
  for (const cell of ['Product & Active Ingredient', 'Quantity of Chemicals Used', 'Chemical Application Method']) {
    await page.getByRole('button', { name: new RegExp(`${cell.replace(/[()&]/g, '\\$&')} — choose`) }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('checkbox').first().click()
    await sheet.getByRole('button', { name: 'Done' }).click()
  }
  await page.getByRole('button', { name: /^Next:/ }).click()

  // 3. Risk assessment: one risk, one action, the safety checks in one tap,
  // and the mandatory gate answered by hand.
  await page.getByRole('checkbox', { name: 'No Risk Safe Access Given' }).click()
  await page
    .getByRole('group', { name: 'Action taken to eliminate any risk was' })
    .getByRole('checkbox')
    .first()
    .click()
  await page.getByRole('button', { name: /Yes to all/ }).click()
  await page
    .getByRole('group', { name: 'Is it safe to commence work?' })
    .getByRole('button', { name: 'Yes', exact: true })
    .click()
  await page.getByRole('button', { name: /^Next:/ }).click()

  // 4. Recommendations and the signature.
  const pad = page.getByRole('img', { name: /Technician's Signature — sign/ })
  // The mouse does not scroll: drawing at coordinates below the fold lands on
  // whatever is actually there, which is how this first "signed" nothing.
  await pad.scrollIntoViewIfNeeded()
  const box = (await pad.boundingBox())!
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2 - 12, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByText('Signed')).toBeVisible()

  await page.getByRole('button', { name: 'Finalise & lock' }).click()

  // Locked, with nothing typed: no date, no client, no site, no technician.
  await expect
    .poll(async () => {
      const report = await owner.client.query(api.reports.get, { businessId, reportId })
      return report!.status
    })
    .toBe('finalised')

  const used = (await taps()) - start
  console.info(`taps used: ${used}`)
  expect(used).toBeLessThanOrEqual(30)
})

test.describe('starting a report from the job it belongs to', () => {
  test('the job sheet offers the form that job produces', async ({ page }) => {
    const email = uniqueEmail('start-from-job')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
    const { businessId, slug } = await owner.client.mutation(api.businesses.create, {
      name: `Start ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'J. Nguyen',
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
    const members = await owner.client.query(api.memberships.listForBusiness, { businessId })
    await owner.client.mutation(api.jobs.create, {
      businessId,
      propertyId,
      assignedMembershipId: members.find((m) => m.role === 'owner')!._id,
      jobType: 'Termite Inspection',
      price: 38000,
      scheduledAt: Date.now(),
      durationMinutes: 90,
    })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/schedule`)
    await page.getByText('Termite Inspection').first().click()

    // A termite inspection produces a Timber Pest Inspection, so that is the
    // button — not a picker of every form the business issues.
    await page.getByRole('button', { name: /Start Inspection/ }).click()
    await expect(page.getByRole('heading', { name: 'Timber Pest Inspection' })).toBeVisible()
    await expect(page.getByText('AS 4349.3-2010').first()).toBeVisible()
  })

  test('the picker puts that form first, and says why', async ({ page }) => {
    const email = uniqueEmail('picker-suggests')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
    const { businessId, slug } = await owner.client.mutation(api.businesses.create, {
      name: `Picks ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    const propertyId = await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'J. Nguyen',
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
    const members = await owner.client.query(api.memberships.listForBusiness, { businessId })
    const jobId = await owner.client.mutation(api.jobs.create, {
      businessId,
      propertyId,
      assignedMembershipId: members.find((m) => m.role === 'owner')!._id,
      jobType: 'Termite Treatment',
      price: 120000,
      scheduledAt: Date.now(),
      durationMinutes: 180,
    })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/new?propertyId=${propertyId}&jobId=${jobId}`)

    await expect(page.getByText('Suggested for Termite Treatment')).toBeVisible()
    // Suggested, not chosen for them: every form is still on the list.
    for (const name of ['Pest Service Report', 'Timber Pest Inspection']) {
      await expect(page.getByText(name, { exact: true })).toBeVisible()
    }
  })
})
