import { expect, test } from '@playwright/test'
import { api, setupBusinessWithSub, signInViaUi } from './fixtures'

/**
 * Prompt 5.3: the Notes section is mainly personal notes. "+" is a blank page
 * of your own; it is yours and the owner's to read, and only yours to write.
 */

test('a technician’s note is theirs: blank on +, no tags, and said so', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('personal-tech')

  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/notes`)
  await expect(page.getByText('No notes of your own yet')).toBeVisible()

  const add = page.getByRole('button', { name: 'New note' })
  await expect(add).toBeEnabled()
  await add.click()

  const body = page.locator('.note-editor')
  await expect(body).toBeVisible()
  await expect(
    page.getByText('Personal · only you and the owner can see this'),
  ).toBeVisible()
  // Nobody can be tagged into a note they could not open, and it is not put
  // on a job until it is shared.
  await expect(
    page.getByRole('button', { name: 'Mention a teammate' }),
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Attach to job' })).toHaveCount(
    0,
  )

  // A page just made is for typing on: the cursor is already in its title.
  await expect(body).toBeFocused()
  await page.keyboard.type('Van stock')
  await expect(body.getByRole('heading', { level: 1 })).toHaveText('Van stock')
  await page.keyboard.press('Enter')
  // "@" is just a character here: no list of teammates opens.
  await page.keyboard.type('Order more bait @Ter')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(page.getByText('No one by that name')).toHaveCount(0)

  const row = page.getByRole('button', { name: /Van stock/ })
  await expect(row).toBeVisible()
  await expect(row.getByLabel('Personal')).toBeVisible()

  // The body reached the server as a personal note.
  await expect
    .poll(async () =>
      (
        await s.sub.client.query(api.notes.list, {
          businessId: s.businessId,
          filter: 'mine',
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((n) => n.title),
    )
    .toEqual(['Van stock'])
  const { page: mine } = await s.sub.client.query(api.notes.list, {
    businessId: s.businessId,
    filter: 'mine',
    paginationOpts: { numItems: 10, cursor: null },
  })
  expect(mine[0].private).toBe(true)
})

test('the owner reads the team’s personal notes in God view, and cannot change them', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('personal-owner')
  const noteId = await s.sub.client.mutation(api.notes.create, {
    businessId: s.businessId,
    visibility: 'private',
    title: 'Kevin’s van list',
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/notes`)
  const add = page.getByRole('button', { name: 'New note' })
  await expect(add).toBeEnabled()

  // Not in his own notebook or the team's folders…
  await expect(page.getByText('Kevin’s van list')).toHaveCount(0)
  // …but in the folder God view gives him.
  const folders = page.getByRole('navigation', { name: 'Notes folders' })
  await folders.getByRole('button', { name: 'Everyone’s notes' }).click()
  const row = page.getByRole('button', { name: /Kevin’s van list/ })
  await expect(row).toContainText('Kevin')
  await row.click()

  await expect(
    page.getByText('Kevin’s personal note · read-only'),
  ).toBeVisible()
  const body = page.locator('.note-editor')
  await expect(body).toBeVisible()
  await expect(body).toHaveAttribute('contenteditable', 'false')
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Pin note' })).toHaveCount(0)
  // Opening it read-only must not trip the editor into a refused write.
  await expect(
    page.getByText('This note can no longer be edited from here.'),
  ).toHaveCount(0)
  await page.waitForTimeout(1500)
  await expect(
    page.getByText('This note can no longer be edited from here.'),
  ).toHaveCount(0)

  // In "Just my jobs" the folder is not offered.
  await page.getByRole('button', { name: 'Whose jobs to show' }).click()
  await page.getByRole('menuitemradio', { name: /Just my jobs/ }).click()
  await expect(
    folders.getByRole('button', { name: 'Everyone’s notes' }),
  ).toHaveCount(0)

  // The note itself is untouched.
  const after = await s.sub.client.query(api.notes.get, {
    businessId: s.businessId,
    noteId,
  })
  expect(after?.title).toBe('Kevin’s van list')
})

test('sharing a personal note hands it to the team', async ({ page }) => {
  const s = await setupBusinessWithSub('personal-share')
  const noteId = await s.sub.client.mutation(api.notes.create, {
    businessId: s.businessId,
    visibility: 'private',
    title: 'Bait station map',
  })

  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/notes?noteId=${noteId}`)
  await expect(page.getByRole('button', { name: 'New note' })).toBeEnabled()
  await expect(
    page.getByText('Personal · only you and the owner can see this'),
  ).toBeVisible()

  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Share with team…' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Everyone in the business')
  await confirm.getByRole('button', { name: 'Share' }).click()

  await expect(
    page.getByText('Personal · only you and the owner can see this'),
  ).toHaveCount(0)
  const team = await s.owner.client.query(api.notes.list, {
    businessId: s.businessId,
    filter: 'team',
    paginationOpts: { numItems: 10, cursor: null },
  })
  expect(team.page.map((n) => n._id)).toContain(noteId)

  // And back: only a note about nothing in particular can be made personal.
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Make personal' }).click()
  await expect(
    page.getByText('Personal · only you and the owner can see this'),
  ).toBeVisible()
})

test('a job’s sheet keeps its site notes and no longer has visit notes', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('personal-jobsheet')

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?jobId=${s.ownerJobId}`)
  const sheet = page.getByRole('dialog')
  await expect(
    sheet.getByRole('heading', { name: 'Before you arrive' }),
  ).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Site note' })).toBeVisible()
  await expect(
    sheet.getByRole('heading', { name: 'Notes for this visit' }),
  ).toHaveCount(0)
})
