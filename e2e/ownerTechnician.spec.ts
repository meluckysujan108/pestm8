import { expect, test } from '@playwright/test'
import { api, setupBusinessWithSub, signInViaUi } from './fixtures'

/**
 * The owner works jobs himself, so he is a person on everyone's roster rather
 * than an administrator hidden behind the business's name — and the rest of
 * the team has to be able to book around him without a form offering them
 * something the server will refuse.
 *
 * Runs on the phone layout too (playwright.config.ts): the phone is where a
 * subcontractor books their own return visit.
 */

test('a subcontractor who can see the schedule sees the owner by name', async ({
  page,
}) => {
  const { owner, sub, businessId, slug, subMembershipId } =
    await setupBusinessWithSub('owner-visible')

  // The fixture's job is the owner's; a subcontractor only has it in view once
  // they may see everyone's schedule.
  await owner.client.mutation(api.memberships.setGrants, {
    businessId,
    membershipId: subMembershipId,
    grants: {
      switchInto: null,
      clientDirectory: false,
      prices: false,
      otherSchedules: true,
    },
  })

  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/schedule`)

  // Each layout names people in its own place: the desktop month card's team
  // legend, and the phone's staff filter (which opens on your own jobs, so the
  // owner is one of two choices there). The desktop filter hides itself on a
  // day with one technician, which this is.
  const isPhone = (page.viewportSize()?.width ?? 1280) < 1024
  // Scoped, because the business's name is on screen elsewhere (the sidebar's
  // business switcher) and the check below is only about who a job is for.
  let names = page.getByText('Team this month').locator('xpath=..')
  if (isPhone) {
    await page.getByRole('button', { name: 'Filter by staff' }).click()
    names = page.getByRole('dialog')
  }
  await expect(names.getByText('Terence')).toBeVisible()
  // Not the business standing in for him, which is what it used to say.
  await expect(names.getByText(/owner-visible/)).toBeHidden()
})

/**
 * The hazard that set the release order. The form used to preselect the
 * roster's first row — the oldest member, which is the owner — and a
 * subcontractor may only book themselves, so every booking would have been
 * refused the day the owner joined their roster.
 */
test('a subcontractor’s new job is theirs, with no one else to pick', async ({
  page,
}) => {
  const { sub, businessId, slug, subMembershipId } =
    await setupBusinessWithSub('owner-book')

  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/schedule`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Assigned to you')).toBeVisible()
  await sheet.getByLabel('Job type').click()
  await page
    .getByRole('button', { name: 'Termite Inspection', exact: true })
    .click()
  await sheet.getByLabel('Start').fill('15:30')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
  }).format(new Date())
  const jobs = await sub.client.query(api.jobs.listDay, {
    businessId,
    dayKey: today,
  })
  expect(
    jobs.some(
      (j) =>
        j.assignedMembershipId === subMembershipId &&
        j.jobType === 'Termite Inspection',
    ),
  ).toBe(true)
})

test('the client book is open to everyone in the business', async ({
  page,
}) => {
  // The fixture's only client has a job for the owner and none for Kevin, so
  // under the old toggle he would not have seen them at all.
  const { sub, slug } = await setupBusinessWithSub('owner-clients')

  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/clients`)
  await expect(page.getByText('J. Nguyen').first()).toBeVisible()
})
