import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import {
  builderReady,
  createReport,
  finaliseReport,
  saveReportDraft,
  sectionUrl,
  signReport,
} from './fixtures/reportPayloads'
import type { Id } from '../convex/_generated/dataModel'

/**
 * Filling a report, the way a technician does it: an overview of the form, one
 * section at a time, and a lock that says what is missing instead of refusing
 * silently.
 *
 * Runs at phone width because that is where the work happens — standing in
 * someone's back garden, not at a desk.
 */

test.use({ viewport: { width: 390, height: 844 } })

/** Draws on the open signing sheet and commits it. */
async function sign(page: Page, label: string) {
  const pad = page.getByRole('img', { name: new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — sign here`) })
  // The mouse does not scroll: drawing at coordinates below the fold lands on
  // whatever is actually there, which is how this once "signed" nothing.
  await pad.scrollIntoViewIfNeeded()
  const box = (await pad.boundingBox())!
  await page.mouse.move(box.x + 24, box.y + box.height * 0.6)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 40, box.y + box.height * 0.35, { steps: 10 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Done' }).click()
}

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
  return { email, owner, businessId, slug, propertyId, jobId, reportId }
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
  await page.getByRole('button', { name: "Technician's Signature — sign" }).click()
  await sign(page, "Technician's Signature")
  await expect(
    page.getByRole('button', { name: "Technician's Signature — signed, sign again" }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Finalise & lock' }).click()

  // One last tap, and it is the one that matters: the sheet reads back what is
  // about to become a record, and locking it is a deliberate second act rather
  // than a stray press on the bar the Save button shares.
  const confirm = page.getByRole('dialog')
  await expect(confirm.getByText('General Pest Control')).toBeVisible()
  await confirm.getByRole('button', { name: 'Finalise & lock' }).click()

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

/**
 * Everything the form insists on, answered through the API, so a spec about
 * the last screen does not have to walk the whole form to reach it.
 *
 * Merges rather than replaces: `saveDraft` writes `data` wholesale, and the
 * seeded date, time and technician are exactly what makes the report
 * finishable.
 */
async function readyToLock(
  owner: Awaited<ReturnType<typeof startJobReport>>['owner'],
  businessId: Id<'businesses'>,
  reportId: Id<'reports'>,
  answers: Record<string, unknown>,
) {
  const report = await owner.client.query(api.reports.get, { businessId, reportId })
  await saveReportDraft(owner.client, { businessId }, reportId, 'serviceReport', {
    ...(report!.data as Record<string, unknown>),
    // The pad writes its own timestamp into the answers as well as the image
    // into storage; the form asks for both.
    technicianSignature: { signedAt: 1789000000000 },
    ...answers,
  })
  // Suggestions block the lock until someone has looked at them. Here, that
  // someone is the fixture.
  const keys = Object.keys(report!.prefill ?? {})
  if (keys.length > 0) {
    await owner.client.mutation(api.reports.confirmPrefill, { businessId, reportId, keys })
  }
  await signReport(owner.client, { businessId }, reportId, 'technician')
}

test.describe('the sheet before the lock', () => {
  test('reads the report back, and offers the finish time it is the only one who knows', async ({
    page,
  }) => {
    const { email, owner, businessId, slug, reportId } = await startJobReport('fill-confirm-sheet')

    await readyToLock(owner, businessId, reportId, {
      treatments: [
        {
          _id: 'row-1',
          treatment: ['General Pest Control'],
          product: ['Biflex Ultra (100 g/L Bifenthrin)'],
          quantity: ['100ml/10L'],
          method: ['Hand Compression Sprayer'],
        },
      ],
      safeToStart: false,
      nextVisit: '6 Months',
      finishTime: undefined,
    })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${reportId}`)
    await builderReady(page)
    await page.getByRole('button', { name: 'Finalise & lock' }).click()

    const sheet = page.getByRole('dialog')
    // What the report says, in the form's own words — not a field dump.
    await expect(sheet.getByText('General Pest Control')).toBeVisible()
    await expect(sheet.getByText('Biflex Ultra (100 g/L Bifenthrin)')).toBeVisible()
    await expect(sheet.getByText('6 Months')).toBeVisible()
    // The gate answered No still locks — and must be impossible to miss.
    await expect(sheet.getByText('No', { exact: true })).toBeVisible()
    // An unsigned client pad is a warning, never a refusal.
    await expect(sheet.getByText(/Signature — not signed/)).toBeVisible()
    await expect(sheet.getByText('No photos')).toBeVisible()

    // The one answer nobody could have known any earlier.
    await sheet.getByRole('button', { name: /Finish Time — set to/ }).click()
    await sheet.getByRole('button', { name: 'Finalise & lock' }).click()

    await expect
      .poll(async () => {
        const report = await owner.client.query(api.reports.get, { businessId, reportId })
        return (report!.data as Record<string, unknown>).finishTime
      })
      .toMatch(/^\d{2}:\d{2}$/)
  })

  test('the document itself can be read before it is locked', async ({ page }) => {
    const { email, owner, businessId, slug, reportId } = await startJobReport('fill-preview')

    await readyToLock(owner, businessId, reportId, { safeToStart: true, treatments: [] })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${reportId}`)
    await builderReady(page)
    await page.getByRole('button', { name: 'Finalise & lock' }).click()

    const sheet = page.getByRole('dialog')
    // The tab is opened on the tap and pointed at the file when the render
    // lands — a popup opened afterwards is one every browser blocks.
    const opened = page.waitForEvent('popup')
    await sheet.getByRole('button', { name: 'Preview the document' }).click()
    await opened

    // The watermarked copy is kept where the next one can replace it, rather
    // than accumulating a file per look. (What it contains is asserted in
    // reportPdf.spec.ts, where the bytes can be read.)
    await expect
      .poll(
        async () => {
          const report = await owner.client.query(api.reports.get, { businessId, reportId })
          return report!.previewStorageId ?? null
        },
        { timeout: 30_000 },
      )
      .not.toBeNull()

    // Still a draft: reading it is not agreeing to it.
    const report = await owner.client.query(api.reports.get, { businessId, reportId })
    expect(report!.status).toBe('draft')
  })

  test('backing out of it changes nothing', async ({ page }) => {
    const { email, owner, businessId, slug, reportId } = await startJobReport('fill-sheet-cancel')

    // No treatments at all: an inspection-only visit finalises, and the row
    // the job type started is either completed or dropped.
    await readyToLock(owner, businessId, reportId, { safeToStart: true, treatments: [] })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${reportId}`)
    await builderReady(page)
    await page.getByRole('button', { name: 'Finalise & lock' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    // Still editable: opening the sheet is asking what would happen, not
    // agreeing to it.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const report = await owner.client.query(api.reports.get, { businessId, reportId })
    expect(report!.status).toBe('draft')
  })
})

/**
 * Puts a record into the device's mirror, exactly as a session that ended
 * before its save landed would have left one.
 *
 * Seeded rather than simulated: the real cause is iOS discarding a
 * backgrounded tab with a mutation still queued, and there is no way to ask a
 * browser to do that. What can be tested is the contract either way — if this
 * device holds answers the server never acknowledged, they are offered back.
 */
async function seedMirror(page: Page, reportId: string, data: Record<string, unknown>) {
  await page.evaluate(
    ([key, answers]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('pestm8', 1)
        open.onupgradeneeded = () =>
          open.result.createObjectStore('reportDrafts', { keyPath: 'reportId' })
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const tx = open.result.transaction('reportDrafts', 'readwrite')
          tx.objectStore('reportDrafts').put({
            reportId: key,
            data: answers,
            savedAt: Date.now(),
          })
          tx.oncomplete = () => {
            open.result.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    [reportId, data] as const,
  )
}

async function mirrored(page: Page, reportId: string) {
  return page.evaluate(
    (key) =>
      new Promise<unknown>((resolve) => {
        const open = indexedDB.open('pestm8', 1)
        open.onupgradeneeded = () =>
          open.result.createObjectStore('reportDrafts', { keyPath: 'reportId' })
        open.onerror = () => resolve(null)
        open.onsuccess = () => {
          const request = open.result
            .transaction('reportDrafts', 'readonly')
            .objectStore('reportDrafts')
            .get(key)
          request.onsuccess = () => {
            open.result.close()
            resolve(request.result ?? null)
          }
          request.onerror = () => resolve(null)
        }
      }),
    reportId,
  )
}

test.describe('answers that never reached the server', () => {
  test('are offered back, and putting them back is what saves them', async ({ page }) => {
    const { email, owner, businessId, slug, reportId } = await startJobReport('fill-mirror')

    await signInViaUi(page, email)
    await page.goto(sectionUrl(slug, reportId, 'serviceReport', 'comments'))
    await builderReady(page)

    await seedMirror(page, reportId, { comments: 'Nest behind the meter box' })
    await page.reload()
    await builderReady(page)

    const sheet = page.getByRole('dialog')
    await expect(sheet).toContainText('Unsaved answers on this phone')
    await sheet.getByRole('button', { name: 'Restore them' }).click()

    await expect(page.getByLabel("Technician's Comments")).toHaveValue(
      'Nest behind the meter box',
    )

    // Restoring is what puts them on the server, so the recovery is real
    // rather than a second copy of the same loss.
    await expect
      .poll(async () => {
        const report = await owner.client.query(api.reports.get, { businessId, reportId })
        return (report!.data as Record<string, unknown>).comments
      })
      .toBe('Nest behind the meter box')
  })

  test('are discarded when they are not wanted, and stay discarded', async ({ page }) => {
    const { email, owner, businessId, slug, reportId } = await startJobReport('fill-mirror-no')

    await signInViaUi(page, email)
    await page.goto(sectionUrl(slug, reportId, 'serviceReport', 'comments'))
    await builderReady(page)

    await seedMirror(page, reportId, { comments: 'Typed on the wrong report' })
    await page.reload()
    await builderReady(page)
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByLabel("Technician's Comments")).toHaveValue('')

    // And the offer does not come back on the next open.
    await page.reload()
    await builderReady(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const report = await owner.client.query(api.reports.get, { businessId, reportId })
    expect((report!.data as Record<string, unknown>).comments).toBeUndefined()
  })

  test('are forgotten the moment the server has them', async ({ page }) => {
    const { email, owner, businessId, slug, reportId } =
      await startJobReport('fill-mirror-clear')

    await signInViaUi(page, email)
    await page.goto(sectionUrl(slug, reportId, 'serviceReport', 'comments'))
    await builderReady(page)

    await page.getByLabel("Technician's Comments").fill('Ants at the meter box')
    await expect
      .poll(async () => {
        const report = await owner.client.query(api.reports.get, { businessId, reportId })
        return (report!.data as Record<string, unknown>).comments
      })
      .toBe('Ants at the meter box')

    // A copy left behind after a successful save would offer to "restore"
    // answers that are already safe — which reads as data loss where there
    // was none.
    await expect.poll(async () => await mirrored(page, reportId)).toBeNull()
  })
})

test.describe('the one question the phone answers better', () => {
  test('takes the reading by itself only where permission was already given', async ({
    page,
    context,
  }) => {
    const { email, owner, businessId, slug, reportId } = await startJobReport('fill-gps')

    // Granted once, deliberately, on this device — which is the only state the
    // form is allowed to act on.
    await context.grantPermissions(['geolocation'])
    await context.setGeolocation({ latitude: -31.9187, longitude: 115.9315, accuracy: 8 })

    await signInViaUi(page, email)
    await page.goto(sectionUrl(slug, reportId, 'serviceReport', 'location'))
    await builderReady(page)

    // No tap: the technician is standing at the property when they open §1.
    await expect(page.getByText(/-31\.918700, 115\.931500/)).toBeVisible()
    // And it says when, and how good it is — eight metres and three hundred
    // look identical on a printed page.
    await expect(page.getByText(/captured .* · ±8 m/)).toBeVisible()

    await expect
      .poll(async () => {
        const report = await owner.client.query(api.reports.get, { businessId, reportId })
        const gps = (report!.data as Record<string, { lat?: number }>).location
        return gps.lat
      })
      .toBeCloseTo(-31.9187, 3)
  })

  test('asks for nothing when the permission has never been given', async ({ page }) => {
    const { email, slug, reportId } = await startJobReport('fill-gps-none')

    await signInViaUi(page, email)
    await page.goto(sectionUrl(slug, reportId, 'serviceReport', 'location'))
    await builderReady(page)

    // A permission dialog that appears because a section scrolled into view is
    // one people dismiss without reading, and an answer obtained that way is
    // not evidence of anything.
    await expect(
      page.getByRole('button', { name: /GPS Coordinates — capture location/ }),
    ).toBeVisible()
    await expect(page.getByText(/captured/)).toHaveCount(0)
  })
})

test.describe('reports where the work is', () => {
  test('a job sheet separates this visit from the property’s history', async ({ page }) => {
    const { email, owner, businessId, slug, reportId } = await startJobReport('inline-job')

    // A second report at the same address, from no job at all: the property's
    // history, not this visit's.
    const property = await owner.client.query(api.reports.get, { businessId, reportId })
    await createReport(
      owner.client,
      { businessId, propertyId: property!.propertyId },
      'timberPestInspection',
    )

    await signInViaUi(page, email)
    await page.goto(`/${slug}/schedule`)
    await page.getByRole('button', { name: /General Pest Control/ }).first().click()

    const sheet = page.getByRole('dialog')
    // The report for THIS job is the thing a technician came looking for; the
    // rest is context.
    const thisVisit = sheet.getByRole('heading', { name: 'Reports for this visit' })
    await expect(thisVisit).toBeVisible()
    await expect(
      sheet.getByRole('heading', { name: 'Other reports at this property' }),
    ).toBeVisible()

    // Named for the form, not for the standard it was written to — three
    // different documents all used to read "APVMA · AEPMA".
    await expect(sheet.getByText('Pest Service Report').first()).toBeVisible()
    await expect(sheet.getByText('Timber Pest Inspection').first()).toBeVisible()
  })

  test('a client with no reports is told so, rather than shown nothing', async ({
    page,
  }) => {
    const email = uniqueEmail('inline-client')
    const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
    const { businessId, slug } = await owner.client.mutation(api.businesses.create, {
      name: `Inline ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    await owner.client.mutation(api.properties.create, {
      businessId,
      clientName: 'J. Nguyen',
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })

    await signInViaUi(page, email)
    await page.goto(`/${slug}/clients`)
    await page.getByText('J. Nguyen').first().click()

    const sheet = page.getByRole('dialog')
    await expect(sheet.getByRole('heading', { name: 'Reports' })).toBeVisible()
    // The section used to render nothing at all when empty, so a client with
    // no reports had no heading and no hint that reports exist.
    await expect(sheet.getByText(/No reports yet/)).toBeVisible()
  })
})

test('the second visit to the same address costs a fraction of the first', async ({
  page,
}) => {
  // The measurement that matters for the whole carry-over idea. The first
  // visit's budget is pinned by "a service report from a job reaches Finalise
  // in well under 30 taps" above, against the same form, the same job type and
  // the same fixture; this counts the second one against it.
  const s = await startJobReport('fill-return-taps')

  // The first visit, paid in full — through the API, because what it costs is
  // already measured up there and paying it twice here only makes this test
  // slow.
  const first = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: s.reportId,
  })
  const suggested = Object.keys(first!.prefill ?? {})
  if (suggested.length > 0) {
    await s.owner.client.mutation(api.reports.confirmPrefill, {
      businessId: s.businessId,
      reportId: s.reportId,
      keys: suggested,
    })
  }
  await finaliseReport(
    s.owner.client,
    { businessId: s.businessId },
    s.reportId,
    'serviceReport',
    {
      ...(first!.data as Record<string, unknown>),
      safeToStart: true,
      treatments: [
        {
          _id: 'visit-one',
          treatment: ['Ants'],
          product: ['Fipforce HP (100 g/L FIPRONIL)'],
          quantity: ['100ml/10L'],
          method: ['Spray'],
        },
      ],
      risks: ['No Risk Safe Access Given'],
      riskActions: ['Kept the area clear during application'],
      housekeeping: ['Remove all rubbish from around the house'],
      nextVisit: '3 Months',
    },
  )

  const second = await createReport(
    s.owner.client,
    { businessId: s.businessId, propertyId: s.propertyId, jobId: s.jobId },
    'serviceReport',
  )

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

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/reports/${second}`)
  await builderReady(page)
  const start = await taps()

  // One tap takes last visit's treatment, risks, actions, housekeeping and
  // next-visit interval.
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(page.getByText(/^Copy from /)).toHaveCount(0)

  // What is left is what only today's technician knows, and passing each
  // section is what confirms the answers copied into it.
  await page.getByRole('button', { name: /CLIENT & SITE DETAILS/ }).first().click()
  // Waited for between taps, not just clicked twice: the footer button keeps
  // its role and its `Next:` prefix from screen to screen, so a second click
  // can land on the one the first is still replacing.
  await page.getByRole('button', { name: /^Next: 2\./ }).click()
  await expect(
    page.getByRole('heading', { name: /^2\. TREATMENT/ }),
  ).toBeVisible()
  await page.getByRole('button', { name: /^Next: 3\./ }).click()
  await expect(
    page.getByRole('heading', { name: /^3\. RISK ASSESSMENT/ }),
  ).toBeVisible()

  await page.getByRole('button', { name: /Yes to all/ }).click()
  await page
    .getByRole('group', { name: 'Is it safe to commence work?' })
    .getByRole('button', { name: 'Yes', exact: true })
    .click()
  await page.getByRole('button', { name: /^Next: 4\./ }).click()

  await page.getByRole('button', { name: "Technician's Signature — sign" }).click()
  await sign(page, "Technician's Signature")
  await expect(
    page.getByRole('button', { name: "Technician's Signature — signed, sign again" }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Finalise & lock' }).click()
  const confirm = page.getByRole('dialog')
  await expect(confirm.getByText('3 Months')).toBeVisible()
  await confirm.getByRole('button', { name: 'Finalise & lock' }).click()

  await expect
    .poll(async () => {
      const report = await s.owner.client.query(api.reports.get, {
        businessId: s.businessId,
        reportId: second,
      })
      return report!.status
    })
    .toBe('finalised')

  const used = (await taps()) - start
  console.info(`second-visit taps used: ${used}`)
  // Twelve at the time of writing, against the first visit's thirty. The
  // margin is the three pickers — product, quantity, method, three taps each —
  // and the risks and actions, all of which are now one Copy.
  expect(used).toBeLessThanOrEqual(16)
})

test.describe('the second visit to the same address', () => {
  test('offers what the last report said, and marks it until it is agreed to', async ({
    page,
  }) => {
    const { email, owner, businessId, slug, propertyId, reportId } =
      await startJobReport('fill-return')

    // The first visit: the full cost, paid once.
    const first = await owner.client.query(api.reports.get, { businessId, reportId })
    const suggested = Object.keys(first!.prefill ?? {})
    if (suggested.length > 0) {
      await owner.client.mutation(api.reports.confirmPrefill, {
        businessId,
        reportId,
        keys: suggested,
      })
    }
    await finaliseReport(owner.client, { businessId }, reportId, 'serviceReport', {
      ...(first!.data as Record<string, unknown>),
      safeToStart: true,
      treatments: [
        {
          _id: 'first-row',
          treatment: ['Ants'],
          product: ['Fipforce HP (100 g/L FIPRONIL)'],
          quantity: ['100ml/10L'],
          method: ['Spray'],
        },
      ],
      nextVisit: '3 Months',
      housekeeping: ['Remove all rubbish from around the house'],
    })

    const second = await createReport(
      owner.client,
      { businessId, propertyId },
      'serviceReport',
    )

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${second}`)
    await builderReady(page)

    // Named, not counted: "copy 6 answers" says nothing about whether you
    // want them.
    await expect(page.getByText(/^Copy from /)).toBeVisible()
    await expect(
      page.getByText(/Treatment, Product\(s\) and Quantities Applied/),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    // The offer goes when there is nothing left to offer — and waiting for it
    // is also waiting for the copy to land before navigating away from it.
    await expect(page.getByText(/^Copy from /)).toHaveCount(0)

    // The work arrives, already filled in...
    await page.goto(sectionUrl(slug, second, 'serviceReport', 'treatments'))
    await builderReady(page)
    await expect(
      page.getByRole('button', { name: /Product & Active Ingredient — Fipforce HP/ }),
    ).toBeVisible()

    // ...and marked, because a guess never prints under a signature until the
    // technician has passed the section it is on.
    await expect(page.getByText('Suggested').first()).toBeVisible()

    const copied = await owner.client.query(api.reports.get, {
      businessId,
      reportId: second,
    })
    const rows = (copied!.data as Record<string, unknown>).treatments as Array<{
      _id: string
    }>
    // A row of its own, not a shared one: two reports whose rows answer to the
    // same name is how an edit to one lands in the other.
    expect(rows[0]._id).not.toBe('first-row')
    expect(copied!.prefill!.treatments.source).toBe('lastVisit')
  })

  test('a first visit is offered nothing', async ({ page }) => {
    const { email, slug, reportId } = await startJobReport('fill-first')

    await signInViaUi(page, email)
    await page.goto(`/${slug}/reports/${reportId}`)
    await builderReady(page)

    // No history, no row to read and dismiss.
    await expect(page.getByText(/^Copy from /)).toHaveCount(0)
  })
})
