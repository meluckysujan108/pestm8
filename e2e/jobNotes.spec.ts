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
  const row = client.getByRole('button', { name: /Bring the long ladder/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText(/Job #\d+ · Termite Inspection/)
})
