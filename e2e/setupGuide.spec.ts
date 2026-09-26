import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { getTemplate } from '../src/lib/reportTemplates'

/**
 * After set-up: the guide at the top of the schedule, the empty screens that
 * say what to do, and the licence a certificate needs, asked for where the
 * certificate is — not at its last step.
 */

/** An owner fresh out of set-up, signed in on the schedule. */
async function freshOwner(label: string) {
  const owner = await signUpActor(uniqueEmail(label), FIXTURE_PASSWORD, 'Jo')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
      withSetup: true,
    },
  )
  await owner.client.mutation(api.businesses.setSetup, {
    businessId,
    finished: true,
  })
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const membershipId = members.find((m) => m.role === 'owner')!._id
  return { owner, businessId, slug, membershipId }
}

test('the set-up guide ticks itself, opens New Job, and can be put away and brought back', async ({
  page,
}) => {
  const { owner, businessId, slug, membershipId } = await freshOwner('guide')
  await signInViaUi(page, owner.email)
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule`))

  const card = page.getByRole('button', { name: /^Set-up guide: / })
  await expect(card).toHaveAccessibleName('Set-up guide: 1 of 5 done')

  // Done elsewhere, ticked here — the guide reads the business, live.
  await owner.client.mutation(api.memberships.setLicence, {
    businessId,
    membershipId,
    licenceNumber: 'PMT-4471',
  })
  await expect(card).toHaveAccessibleName('Set-up guide: 2 of 5 done')

  // An empty day says what to do about it.
  await expect(page.getByRole('button', { name: 'Book a job' })).toBeVisible()

  // The checklist, and its first job straight into New Job.
  await clickUntil(card, () =>
    expect(page.getByRole('heading', { name: 'Get set up' })).toBeVisible({
      timeout: 3_000,
    }),
  )
  await expect(
    page.getByRole('button', { name: /Add your licence number \(done\)/ }),
  ).toBeDisabled()
  await page.getByRole('button', { name: /Book your first job/ }).click()
  await expect(page.getByRole('heading', { name: 'New job' })).toBeVisible()

  // Put away…
  await page.reload()
  await clickUntil(card, () =>
    expect(page.getByRole('heading', { name: 'Get set up' })).toBeVisible({
      timeout: 3_000,
    }),
  )
  await page.getByRole('button', { name: 'Hide the guide' }).click()
  await expect(card).toHaveCount(0)

  // …and brought back from Settings, to the schedule where it lives.
  await page.goto(`/${slug}/settings`)
  const row = page.getByRole('button', { name: /Set-up guide/ })
  await expect(row).toContainText('2 of 5 done')
  await clickUntil(row, () =>
    expect(page).toHaveURL(new RegExp(`/${slug}/schedule`), { timeout: 3_000 }),
  )
  await expect(card).toBeVisible()
})

test('empty screens offer the one thing to do', async ({ page }) => {
  const { owner, slug } = await freshOwner('empty')
  await signInViaUi(page, owner.email)

  await page.goto(`/${slug}/clients`)
  await clickUntil(page.getByRole('button', { name: 'Add a client' }), () =>
    expect(page.getByRole('heading', { name: 'New client' })).toBeVisible({
      timeout: 3_000,
    }),
  )

  // A new report with nowhere to be about: add the client right there.
  await page.goto(`/${slug}/reports/new`)
  await expect(
    page
      .getByRole('heading', { name: 'No properties yet' })
      .or(page.getByText('No properties yet')),
  ).toBeVisible()
  await clickUntil(page.getByRole('button', { name: 'Add a client' }), () =>
    expect(page.getByRole('heading', { name: 'New client' })).toBeVisible({
      timeout: 3_000,
    }),
  )
})

test('a certificate’s author adds their licence on the draft, before finishing', async ({
  page,
}) => {
  const { owner, businessId, slug, membershipId } = await freshOwner('cert')
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const reportId = await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId,
    template: 'termiteManagementCert',
    legalBasis: getTemplate('termiteManagementCert').legalBasis,
    data: {},
  })

  await signInViaUi(page, owner.email)
  await page.goto(`/${slug}/reports/${reportId}`)

  const notice = page.getByText('Add your licence number before you finish')
  await expect(notice).toBeVisible()
  const save = page.getByRole('button', { name: 'Save', exact: true })
  const field = page.getByLabel('Pest management technician licence')
  // The notice is in the server's render, so it can be typed into before the
  // page hydrates — which wipes the field. Typed again until it holds, which
  // is when Save wakes up.
  await expect(async () => {
    await field.fill('PMT-4471')
    await expect(save).toBeEnabled({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  await clickUntil(save, () =>
    expect(notice).toHaveCount(0, { timeout: 5_000 }),
  )

  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  expect(members.find((m) => m._id === membershipId)?.licenceNumber).toBe(
    'PMT-4471',
  )
})
