import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * The Phase 2 core loop (§6.2), driven through the UI rather than the API:
 * add a property, book work against it, see it on the day, open it, complete it.
 * This is the path the design partner replaces his wall calendar with, so it is
 * worth asserting end to end rather than per-function.
 */
test('an owner can add a property, book a job, and complete it', async ({
  page,
}) => {
  const email = uniqueEmail('loop-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `Loop ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  await signInViaUi(page, email)
  await expect(page).toHaveURL(new RegExp(`/${slug}/dashboard$`))

  // --- add a property -----------------------------------------------------
  await page.goto(`/${slug}/clients`)
  await expect(page.getByText('No properties yet')).toBeVisible()

  const newProperty = page.getByRole('button', { name: 'New property' })
  await expect(newProperty).toBeEnabled()
  await newProperty.click()

  const propertySheet = page.getByRole('dialog')
  await expect(propertySheet.getByText('New property')).toBeVisible()

  await propertySheet.getByLabel('Client name').fill('J. Nguyen')
  await propertySheet.getByLabel('Street address').fill('12 Wattle Street')
  await propertySheet.getByLabel('Suburb').fill('Bayswater')
  await propertySheet.getByLabel('Postcode').fill('6053')
  await propertySheet.getByLabel('Phone (optional)').fill('0412345678')
  await propertySheet.getByRole('button', { name: 'Save property' }).click()

  await expect(page.getByText('12 Wattle Street')).toBeVisible()
  // Rows show the suburb; the street address belongs to the detail view (§2.3).
  await expect(page.getByText('Bayswater')).toBeVisible()

  // --- book a job ---------------------------------------------------------
  await page.goto(`/${slug}/schedule`)
  await expect(page.getByText('Nothing booked')).toBeVisible()

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const jobSheet = page.getByRole('dialog')
  await expect(jobSheet.getByText('New job')).toBeVisible()

  await jobSheet.getByLabel('Job type').selectOption('Termite Inspection')
  await jobSheet.getByLabel('Start').fill('09:30')
  await jobSheet.getByLabel('Price (AUD)').fill('380')
  await jobSheet.getByRole('button', { name: 'Book job' }).click()

  // --- it appears on the day ---------------------------------------------
  const card = page.getByRole('button', { name: /Termite Inspection/ })
  await expect(card).toBeVisible()
  await expect(page.getByText('$380')).toBeVisible()
  await expect(page.getByText('Booked')).toBeVisible()

  // --- open and complete it ----------------------------------------------
  await card.click()

  const detail = page.getByRole('dialog')
  // Full street address here, unlike the list row.
  await expect(detail.getByText('12 Wattle Street')).toBeVisible()
  await expect(detail.getByText('Hold to call')).toBeVisible()

  await detail.getByRole('button', { name: 'Mark completed' }).click()

  await expect(page.getByText('Awaiting invoice')).toBeVisible()

  // --- and the dashboard reflects it -------------------------------------
  await page.goto(`/${slug}/dashboard`)
  await expect(page.getByText('$380')).toBeVisible()
  await expect(
    page.getByText('1 job completed and not yet billed'),
  ).toBeVisible()
})

test('a subcontractor sees only their own day', async ({ page }) => {
  const ownerEmail = uniqueEmail('scope-owner')
  const subEmail = uniqueEmail('scope-sub')
  const owner = await signUpActor(ownerEmail, FIXTURE_PASSWORD, 'Terence')
  const sub = await signUpActor(subEmail, FIXTURE_PASSWORD, 'Kevin')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `Scope ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )

  const subUser = await sub.client.query(api.auth.getCurrentUser, {})
  await owner.client.mutation(api.memberships.invite, {
    businessId,
    userId: subUser!._id,
    role: 'subcontractor',
  })
  await sub.client.mutation(api.memberships.accept, { businessId })

  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })

  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const ownerMembershipId = members.find((m) => m.role === 'owner')!._id

  await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: ownerMembershipId,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: Date.now(),
    durationMinutes: 90,
  })

  // The subcontractor's schedule is empty: the owner's job is never sent to
  // their client, not merely hidden once it arrives.
  await signInViaUi(page, subEmail)
  await page.goto(`/${slug}/schedule`)
  await expect(page.getByText('Nothing booked')).toBeVisible()
  await expect(page.getByText('Termite Inspection')).toHaveCount(0)
})
