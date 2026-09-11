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
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule$`))

  // --- add a client --------------------------------------------------------
  await page.goto(`/${slug}/clients`)
  await expect(page.getByText('No clients yet')).toBeVisible()

  const newProperty = page.getByRole('button', { name: 'New client' })
  await expect(newProperty).toBeEnabled()
  await newProperty.click()

  const propertySheet = page.getByRole('dialog')
  await expect(propertySheet.getByText('New client')).toBeVisible()

  await propertySheet.getByLabel('Client name').fill('J. Nguyen')
  await propertySheet.getByLabel('Street address').fill('12 Wattle Street')
  await propertySheet.getByLabel('Suburb').fill('Bayswater')
  await propertySheet.getByLabel('Postcode').fill('6053')
  await propertySheet.getByLabel('Phone (optional)').fill('0412345678')
  await propertySheet.getByRole('button', { name: 'Save client' }).click()

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

  await jobSheet.getByLabel('Job type').click()
  await page.getByRole('button', { name: 'Termite Inspection', exact: true }).click()
  await jobSheet.getByLabel('Start').fill('09:30')
  await jobSheet.getByLabel('Price (AUD)').fill('380')
  await jobSheet.getByRole('button', { name: 'Book job' }).click()

  // --- it appears on the day ---------------------------------------------
  const card = page.getByRole('button', { name: /Termite Inspection/ })
  await expect(card).toBeVisible()
  await expect(page.getByText('$380')).toBeVisible()
  // Scoped to the card: the desktop day panel also has a "Booked" status
  // filter, so an unscoped match is ambiguous about which one is being
  // asserted — and it is the card's status pill that matters here.
  await expect(card.getByText('Booked')).toBeVisible()

  // --- open and complete it ----------------------------------------------
  await card.click()

  const detail = page.getByRole('dialog')
  // Full street address here, unlike the list row.
  await expect(detail.getByText('12 Wattle Street')).toBeVisible()
  // Short labels (not "Hold to call") since Call/Text/Email now share one
  // row — the hold-to-confirm behaviour itself is unchanged (§2.3).
  await expect(detail.getByRole('button', { name: /^Call /i })).toBeVisible()

  // Status is changed from a menu on the pill itself, not a dedicated button.
  await detail.getByRole('button', { name: 'Change job status' }).click()
  await page.getByRole('menuitem', { name: 'Completed' }).click()

  await expect(detail.getByText('Completed')).toBeVisible()

  // --- and analytics reflects it ------------------------------------------
  await page.goto(`/${slug}/analytics`)
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

/** One owner, one property, one job today — the setup both card tests need. */
async function seedOneJob(prefix: string) {
  const email = uniqueEmail(prefix)
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `${prefix} ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )

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

  return { email, slug }
}

/**
 * Pins the amended §2.3 rule: the rich `board` card carries the full street
 * address, the compact `list` row carries the suburb alone. The distinction is
 * deliberate and easy to erase by accident, so it is asserted rather than
 * trusted to the comment in `JobCard.tsx`.
 */
test('the board card shows the full address and the list row shows only the suburb', async ({
  page,
}) => {
  const { email, slug } = await seedOneJob('cardvariant')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  const view = page.getByRole('tablist', { name: 'View' })
  const card = page.getByRole('button', { name: /Termite Inspection/ })
  await expect(card).toBeVisible()

  // Board is the default.
  await expect(page.getByText('12 Wattle Street')).toBeVisible()

  await view.getByRole('tab', { name: 'List' }).click()
  await expect(page.getByText('12 Wattle Street')).toHaveCount(0)
  // The suburb survives the switch — it is the address line that is dropped,
  // not location information altogether.
  await expect(card.getByText('Bayswater')).toBeVisible()

  await view.getByRole('tab', { name: 'Board' }).click()
  await expect(page.getByText('12 Wattle Street')).toBeVisible()
})

/**
 * The chosen view lives in a search param rather than component state (§5.1),
 * so it has to survive a reload — the same promise `?date=` already makes.
 */
test('the chosen card view is kept in the URL and survives a reload', async ({
  page,
}) => {
  const { email, slug } = await seedOneJob('cardview')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  await page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name: 'List' }).click()
  await expect(page).toHaveURL(/view=list/)

  await page.reload()
  await expect(page.getByRole('button', { name: /Termite Inspection/ })).toBeVisible()
  await expect(page.getByText('12 Wattle Street')).toHaveCount(0)

  // A view the mobile layout cannot render must not leave the page blank; it
  // falls back to board rather than showing a data grid on a phone.
  await page.goto(`/${slug}/schedule?view=table`)
  await expect(page.getByRole('button', { name: /Termite Inspection/ })).toBeVisible()
})

/**
 * Deliberately tolerant: the forecast comes from a live third-party API, so
 * this asserts the strip reaches one of its two defined states rather than a
 * particular temperature. `e2e/weather.spec.ts` covers the forecast itself.
 */
test('a board card renders a weather panel for its own suburb', async ({
  page,
}) => {
  const { email, slug } = await seedOneJob('cardweather')

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  const card = page.getByRole('button', { name: /Termite Inspection/ })
  // The forecast now arrives asynchronously behind a placeholder rather than
  // rendering "No forecast" synchronously on first paint, so wait for the
  // placeholder to resolve before asserting. Without this the assertion races
  // a live geocode + forecast round trip and passes or fails on timing.
  await expect(card.getByTestId('weather-pending')).toHaveCount(0)
  await expect(card).toContainText(/\d+°|No forecast/)
})
