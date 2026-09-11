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

test('an owner can add and delete a note', async ({ page }) => {
  const email = uniqueEmail('notes-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `Notes ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/notes`)

  await expect(page.getByText('No notes yet')).toBeVisible()

  const add = page.getByRole('button', { name: 'Add note' })
  await page.getByLabel('Note').fill('Gate code 4821. Dog is friendly.')
  await expect(add).toBeEnabled()
  await add.click()

  await expect(page.getByText('Gate code 4821. Dog is friendly.')).toBeVisible()

  await page.getByRole('button', { name: 'Delete note' }).click()
  await expect(page.getByText('Gate code 4821. Dog is friendly.')).toHaveCount(
    0,
  )
})

test('a subcontractor cannot delete a note they did not write', async () => {
  const s = await setupBusinessWithSub('notes-scope')

  const noteId = await s.owner.client.mutation(api.notes.create, {
    businessId: s.businessId,
    text: 'Owner-only note',
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

test('notes are scoped like jobs are', async () => {
  const s = await setupBusinessWithSub('notes-visibility')

  await s.owner.client.mutation(api.notes.create, {
    businessId: s.businessId,
    text: 'Owner-only note',
  })

  // Default subcontractor sees their own notes, not the whole business board.
  const subNotes = await s.sub.client.query(api.notes.list, {
    businessId: s.businessId,
  })
  expect(subNotes).toHaveLength(0)

  const ownerNotes = await s.owner.client.query(api.notes.list, {
    businessId: s.businessId,
  })
  expect(ownerNotes).toHaveLength(1)
})
