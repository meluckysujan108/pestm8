import { expect, test } from '@playwright/test'
import { api, clickUntil, setupBusinessWithSub, signInViaUi } from './fixtures'

/**
 * The Job section (Phase 2): its own tab, holding a list of every job newest
 * first, and a Recurring Job view alongside it that the next phase fills in.
 * The section is reached from the More menu on a phone and from the sidebar on
 * a desktop, which is what the burger split is for.
 */

async function seedTwoJobs(label: string) {
  const s = await setupBusinessWithSub(label)

  // Booked second, due later: the list is ordered by when each was booked.
  const laterJobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest Control',
    price: 22000,
    scheduledAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
    durationMinutes: 60,
  })
  return { ...s, laterJobId }
}

test('the Job tab lists every job newest first, with its status', async ({
  page,
}) => {
  const s = await seedTwoJobs('job-list')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job`)

  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()

  const cards = page.getByRole('button', {
    name: /General Pest Control|Termite Inspection/,
  })
  await expect(cards).toHaveCount(2)
  // The one booked last is at the top, though it is due a fortnight later.
  await expect(cards.first()).toContainText('General Pest Control')
  // Every row carries its status; a job booked by hand starts Pending.
  await expect(cards.first().getByText('Pending')).toBeVisible()
})

test('the status filter narrows the list and survives a reload', async ({
  page,
}) => {
  const s = await seedTwoJobs('job-filter')
  await s.owner.client.mutation(api.jobs.cancel, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job`)

  const cards = page.getByRole('button', {
    name: /General Pest Control|Termite Inspection/,
  })
  await expect(cards).toHaveCount(2)

  // The chip's options are buttons in a popover, as FilterDropdown renders
  // everywhere else in the app. Scoped to that popover and exact: a job card's
  // own accessible name contains its status pill, so an unscoped "Cancelled"
  // would also match the cancelled job's card — and clicking THAT opens the
  // detail sheet instead of filtering.
  const cancelledOption = page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancelled', exact: true })
  await clickUntil(page.getByRole('button', { name: 'Filter by status' }), () =>
    expect(cancelledOption).toBeVisible({ timeout: 2_000 }),
  )
  await cancelledOption.click()

  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Termite Inspection')
  await expect(page).toHaveURL(/status=cancelled/)

  // The filter is in the URL, so it is still there after a reload (§5.1).
  await page.reload()
  await expect(cards).toHaveCount(1)
})

test('Recurring Job is a view of its own within the section', async ({
  page,
}) => {
  const s = await seedTwoJobs('job-recurring')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job`)

  const views = page.getByRole('tablist', { name: 'View' })
  // Exact: "Job" is a substring of "Recurring Job", and a name match is a
  // substring match unless told otherwise.
  await expect(
    views.getByRole('tab', { name: 'Job', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')

  await clickUntil(views.getByRole('tab', { name: 'Recurring Job' }), () =>
    expect(page).toHaveURL(new RegExp(`/${s.slug}/job/recurring$`), {
      timeout: 2_000,
    }),
  )
  await expect(
    views.getByRole('tab', { name: 'Recurring Job' }),
  ).toHaveAttribute('aria-selected', 'true')
  // The header stays: it is the section's, not the view's.
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()
})

test('the phone reaches Job through the More menu', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone layout only')

  const s = await seedTwoJobs('job-more')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)

  const dock = page.getByRole('navigation').last()
  // Job is not one of the four daily destinations.
  await expect(dock.getByRole('link', { name: 'Jobs' })).toHaveCount(0)

  await clickUntil(dock.getByRole('button', { name: 'More' }), () =>
    expect(
      page.getByRole('dialog').getByRole('link', { name: 'Jobs' }),
    ).toBeVisible({
      timeout: 2_000,
    }),
  )
  await page.getByRole('dialog').getByRole('link', { name: 'Jobs' }).click()

  await expect(page).toHaveURL(new RegExp(`/${s.slug}/job$`))
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()
})
