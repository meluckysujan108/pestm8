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

  // The section opens on the owner's own notebook.
  await expect(page.getByText('No notes of your own yet')).toBeVisible()

  // One tap, a blank page: no menu of templates to choose from first.
  const add = page.getByRole('button', { name: 'New note' })
  await expect(add).toBeEnabled()
  await add.click()
  await expect(page.getByRole('menuitem')).toHaveCount(0)

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
  await expect(page.getByText('No notes of your own yet')).toBeVisible()
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
  expect(subNotes.page.map((n) => n.title)).toEqual([
    'Mix ratios for the truck',
  ])

  const ownerNotes = await s.owner.client.query(api.notes.list, {
    businessId: s.businessId,
    filter: 'all',
    paginationOpts: page,
  })
  expect(ownerNotes.page).toHaveLength(2)
})

test('a folder whose first page is all someone else’s does not read as empty', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('notes-firstpage')

  // One note of the technician's own, then a full page of the owner's on top
  // of it. `notes.list` applies visibility AFTER paginating, so the
  // technician's first page comes back empty with theirs still behind it —
  // and an empty page is not an empty folder.
  const mine = await s.sub.client.mutation(api.notes.create, {
    businessId: s.businessId,
    title: 'Wattle Street follow-up',
  })
  await s.sub.client.mutation(api.notes.softDelete, {
    businessId: s.businessId,
    noteId: mine,
  })
  for (let i = 0; i < 30; i++) {
    const id = await s.owner.client.mutation(api.notes.create, {
      businessId: s.businessId,
      title: `Owner note ${i}`,
    })
    await s.owner.client.mutation(api.notes.softDelete, {
      businessId: s.businessId,
      noteId: id,
    })
  }

  await signInViaUi(page, s.sub.email)
  const document = await page.goto(`/${s.slug}/notes?filter=trash`)

  // Asserted against the server-rendered markup, because the false empty
  // state heals a moment later when the list asks for the next page: by the
  // time the note is on screen there is nothing left to catch.
  expect(await document!.text()).not.toContain('Recently deleted is empty')
  await expect(page.getByText('Wattle Street follow-up')).toBeVisible()
  await expect(page.getByText('Recently deleted is empty')).toHaveCount(0)
})
