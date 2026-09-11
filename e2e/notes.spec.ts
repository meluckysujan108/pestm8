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

test('an owner can write a note, see it in the list, and move it to Recently Deleted', async ({
  page,
}) => {
  const email = uniqueEmail('notes-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `Notes ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/notes`)

  await expect(page.getByText('No notes yet')).toBeVisible()

  const add = page.getByRole('button', { name: 'New note' })
  await expect(add).toBeEnabled()
  await add.click()
  await page.getByRole('menuitem', { name: /Blank note/ }).click()

  // No save button: the first line is the title, and the list follows the
  // body as it is typed.
  const body = page.locator('.note-editor')
  await expect(body).toBeVisible()
  await body.click()
  await page.keyboard.type('Gate code 4821')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Dog is friendly.')

  const row = page.getByRole('button', { name: /Gate code 4821/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Dog is friendly.')

  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByText('No notes yet')).toBeVisible()
})

test('a subcontractor cannot delete a note they did not write', async () => {
  const s = await setupBusinessWithSub('notes-scope')

  const noteId = await s.owner.client.mutation(api.notes.create, {
    businessId: s.businessId,
    title: 'Owner-only note',
  })

  await s.owner.client.mutation(api.memberships.setCanViewAllJobs, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    canViewAllJobs: true,
  })

  // Visibility is not authorship, the same rule reports use.
  await expectRejected(
    () =>
      s.sub.client.mutation(api.notes.remove, {
        businessId: s.businessId,
        noteId,
      }),
    'NO_ACCESS',
  )
})

test('team notes are shared knowledge; job notes follow job visibility', async () => {
  const s = await setupBusinessWithSub('notes-visibility')

  await s.owner.client.mutation(api.notes.create, {
    businessId: s.businessId,
    title: 'Mix ratios for the truck',
  })
  await s.owner.client.mutation(api.notes.create, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    title: 'Only on my own job',
  })

  const page = { numItems: 20, cursor: null }
  const subNotes = await s.sub.client.query(api.notes.list, {
    businessId: s.businessId,
    filter: 'all',
    paginationOpts: page,
  })
  expect(subNotes.page.map((n) => n.title)).toEqual(['Mix ratios for the truck'])

  const ownerNotes = await s.owner.client.query(api.notes.list, {
    businessId: s.businessId,
    filter: 'all',
    paginationOpts: page,
  })
  expect(ownerNotes.page).toHaveLength(2)
})
