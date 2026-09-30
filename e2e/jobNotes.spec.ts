import { expect, test } from '@playwright/test'
import { api, clickUntil, setupBusinessWithSub, signInViaUi } from './fixtures'

/**
 * A job's notes are notes in Notes (30 Sept 2026): one card on the job, with
 * the site's notes first and this visit's under them, each written in the
 * same editor as the rest, and each found again on the client.
 */

test('a note written on a visit is in Notes, on the job and on its client', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('job-notes')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?jobId=${s.ownerJobId}`)
  const sheet = page.getByRole('dialog')
  const add = sheet.getByRole('button', { name: 'Add a visit note' })
  await expect(add).toBeEnabled()
  await add.click()

  // Opened as it is made, the caret on its first line: the first thing
  // typed is its title.
  const editor = sheet.locator('[contenteditable="true"]').first()
  await expect(editor).toBeFocused()
  await page.keyboard.type('Bring the long ladder')

  await expect
    .poll(
      async () =>
        (
          await s.owner.client.query(api.notes.listForJob, {
            businessId: s.businessId,
            jobId: s.ownerJobId,
          })
        ).map((n) => n.title),
      { timeout: 15_000 },
    )
    .toEqual(['Bring the long ladder'])

  // On the client too, saying which visit it was written on.
  await page.goto(`/${s.slug}/clients`)
  const client = page.getByRole('dialog')
  await clickUntil(
    page.getByRole('button', { name: /J\. Nguyen/ }).first(),
    () => expect(client).toBeVisible({ timeout: 2_000 }),
  )
  // Under Notes → From visits.
  await client.getByRole('tab', { name: 'Notes' }).click()
  await expect(
    client.getByRole('heading', { name: 'From visits · 1' }),
  ).toBeVisible()
  const row = client.getByRole('button', { name: /Bring the long ladder/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText(/Job #\d+ · Termite Inspection/)
  // Opened, it leads to the job it was written on.
  await row.click()
  await expect(
    client.getByRole('link', { name: /^Open job #\d+$/ }),
  ).toBeVisible()
})

/**
 * Deleting a note where it is read (30 Sept 2026): open, a note offers
 * "Delete note" to whoever wrote it and to the owner, asks first, and goes to
 * Recently deleted. A note made with "+" and left empty is cleared away.
 */
test('a note is deleted where it is read, by whoever wrote it', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('job-note-delete')
  await s.owner.client.mutation(api.notes.create, {
    businessId: s.businessId,
    template: 'blank',
    title: 'Gate is broken',
    jobId: s.ownerJobId,
  })
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?jobId=${s.ownerJobId}`)
  const sheet = page.getByRole('dialog')
  await expect(
    sheet.getByRole('button', { name: 'Add a visit note' }),
  ).toBeEnabled()

  await sheet.getByRole('button', { name: /^Gate is broken/ }).click()
  await sheet.getByRole('button', { name: 'Delete note' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Recently deleted')
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(
    sheet.getByRole('button', { name: /^Gate is broken/ }),
  ).toHaveCount(0)
  expect(
    await s.owner.client.query(api.notes.listForJob, {
      businessId: s.businessId,
      jobId: s.ownerJobId,
    }),
  ).toEqual([])
})

test('a note someone else wrote offers no Delete', async ({ page }) => {
  const s = await setupBusinessWithSub('job-note-nodelete')
  const kevinsJob = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: Date.now(),
    durationMinutes: 60,
  })
  await s.owner.client.mutation(api.notes.create, {
    businessId: s.businessId,
    template: 'blank',
    title: 'Owner’s instructions',
    jobId: kevinsJob,
  })
  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/schedule?jobId=${kevinsJob}`)
  const sheet = page.getByRole('dialog')
  const row = sheet.getByRole('button', { name: /^Owner’s instructions/ })
  await expect(row).toBeEnabled()
  await clickUntil(row, () =>
    expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 }),
  )
  await expect(sheet.getByRole('button', { name: 'Delete note' })).toHaveCount(
    0,
  )
})

test('a visit note made and closed with nothing in it is cleared away', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('job-note-empty')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?jobId=${s.ownerJobId}`)
  const sheet = page.getByRole('dialog')
  const add = sheet.getByRole('button', { name: 'Add a visit note' })
  await expect(add).toBeEnabled()
  await add.click()
  await expect(sheet.locator('[contenteditable="true"]').first()).toBeFocused()

  // Closed again, untouched.
  await sheet.getByRole('button', { name: /^New note/ }).click()
  await expect
    .poll(
      async () =>
        (
          await s.owner.client.query(api.notes.listForJob, {
            businessId: s.businessId,
            jobId: s.ownerJobId,
          })
        ).length,
      { timeout: 15_000 },
    )
    .toBe(0)
  // Its row went from under the focus: on to what the section offers next.
  await expect(
    sheet.getByRole('button', { name: 'Add a site note' }),
  ).toBeFocused()
})

test('a visit note typed in and emptied again is cleared away as the sheet closes', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('job-note-emptied')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?jobId=${s.ownerJobId}`)
  const sheet = page.getByRole('dialog')
  const add = sheet.getByRole('button', { name: 'Add a visit note' })
  await expect(add).toBeEnabled()
  await add.click()
  await expect(sheet.locator('[contenteditable="true"]').first()).toBeFocused()

  // Typed, rubbed out to a space, and the whole sheet closed at once: the
  // row is cleaned up before the editor inside it, so the clean-up waits
  // for the editor's save.
  await page.keyboard.type(' x')
  await page.keyboard.press('Backspace')
  await sheet.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect
    .poll(
      async () =>
        (
          await s.owner.client.query(api.notes.listForJob, {
            businessId: s.businessId,
            jobId: s.ownerJobId,
          })
        ).length,
      { timeout: 15_000 },
    )
    .toBe(0)
})

test('a visit note typed in is kept, closed and opened however quickly', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('job-note-typed')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?jobId=${s.ownerJobId}`)
  const sheet = page.getByRole('dialog')
  const add = sheet.getByRole('button', { name: 'Add a visit note' })
  await expect(add).toBeEnabled()
  await add.click()
  const editor = sheet.locator('[contenteditable="true"]').first()
  await expect(editor).toBeFocused()

  // Typed, and closed at once, then opened and closed again as quickly:
  // never taken for an empty note.
  await page.keyboard.type('Ring first')
  const row = sheet.getByRole('button', { name: /^(New note|Ring first)/ })
  await row.click()
  await row.click()
  await row.click()
  await page.waitForTimeout(2_000)
  const notes = () =>
    s.owner.client.query(api.notes.listForJob, {
      businessId: s.businessId,
      jobId: s.ownerJobId,
    })
  expect(await notes()).toHaveLength(1)
  await row.click()
  await expect(editor).toContainText('Ring first')
})

test('a note closed straight after typing is listed by what it says', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('job-note-quick-close')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?jobId=${s.ownerJobId}`)
  const sheet = page.getByRole('dialog')
  const add = sheet.getByRole('button', { name: 'Add a visit note' })
  await expect(add).toBeEnabled()
  await add.click()
  await expect(sheet.locator('[contenteditable="true"]').first()).toBeFocused()

  // Each edit is sent as it is typed, and the whole note saved 0.8 s after
  // typing stops. Closed before either is done, it is saved once its last
  // edits have landed.
  await page.keyboard.type('Ring first')
  await sheet.getByRole('button', { name: /^New note/ }).click()
  await expect
    .poll(
      async () =>
        (
          await s.owner.client.query(api.notes.listForJob, {
            businessId: s.businessId,
            jobId: s.ownerJobId,
          })
        ).map((n) => n.title),
      { timeout: 15_000 },
    )
    .toEqual(['Ring first'])
})
