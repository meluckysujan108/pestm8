import { expect, test } from '@playwright/test'
import { api, clickUntil, setupBusinessWithSub, signInViaUi } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * A job for more than one person (asked for 30 Sept 2026: "Terence owner and
 * Kevin subcontractor both can work on the same job"). The owner leads; Kevin
 * is also going — and finds it on his own schedule, and may work it.
 */

async function openJob(page: Page, slug: string) {
  await page.goto(`/${slug}/schedule`)
  const detail = page.getByRole('dialog')
  await clickUntil(page.getByText('Termite Inspection').first(), () =>
    expect(detail).toBeVisible({ timeout: 2_000 }),
  )
  return detail
}

test('the owner puts Kevin on his job from Edit → Also going', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('shared-add')
  await signInViaUi(page, s.owner.email)
  const detail = await openJob(page, s.slug)

  await detail.getByRole('button', { name: 'Edit job details' }).click()
  await detail.getByRole('button', { name: 'Also going' }).click()
  const picker = page.getByRole('dialog', { name: 'Also going' })
  await picker.getByRole('checkbox', { name: /Kevin/ }).click()
  await picker.getByRole('button', { name: 'Done' }).click()
  await expect(picker).toBeHidden()
  await detail.getByRole('button', { name: 'Save' }).click()
  await expect(detail.getByText('Editing job #')).toBeHidden()

  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(job?.alsoGoing.map((p) => p._id)).toEqual([s.subMembershipId])
  // The sheet names them both.
  await expect(detail.getByText('Kevin')).toBeVisible()
})

test('Kevin, also going, finds the job on his schedule and may work it', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('shared-kevin')
  await s.owner.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    alsoGoing: [s.subMembershipId],
  })

  await signInViaUi(page, s.sub.email)
  const detail = await openJob(page, s.slug)
  // Not the read-only notice a colleague's job gets: he is on this one.
  await expect(
    detail.getByText('This job is assigned to someone else'),
  ).toHaveCount(0)
  await expect(
    detail.getByRole('button', { name: 'Edit job details' }),
  ).toBeVisible()

  // And through the API, as his phone would ask: it is his to see and change.
  const job = await s.sub.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(job?.canEdit).toBe(true)
  await s.sub.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    durationMinutes: 120,
  })
})

test('a subcontractor not on the job still cannot open it', async () => {
  const s = await setupBusinessWithSub('shared-none')
  const job = await s.sub.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(job).toBeNull()
})
