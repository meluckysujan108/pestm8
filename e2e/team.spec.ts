import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * The design partner's actual setup: Terence invites Kevin, Kevin joins, and
 * Terence later grants read visibility of the whole schedule. Without this
 * flow there is no way to get a second person into a business at all.
 */
test('an owner invites a subcontractor who then joins', async ({ page }) => {
  const ownerEmail = uniqueEmail('team-owner')
  const subEmail = uniqueEmail('team-sub')

  const owner = await signUpActor(ownerEmail, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `Team ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )

  await signInViaUi(page, ownerEmail)
  await page.goto(`/${slug}/settings?seg=team`)

  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()

  const inviteButton = page.getByRole('button', { name: 'Invite' })
  await expect(inviteButton).toBeEnabled()
  await page.getByLabel('Email address').fill(subEmail)
  await inviteButton.click()

  await expect(page.getByText(subEmail)).toBeVisible()

  // Kevin signs up with the invited address and lands inside the business
  // rather than being asked to create one of his own.
  const sub = await signUpActor(subEmail, FIXTURE_PASSWORD, 'Kevin')
  await sub.client.mutation(api.memberships.claimInvitations, {})

  const subBusinesses = await sub.client.query(api.businesses.listForUser, {})
  expect(subBusinesses.map((b) => b.slug)).toContain(slug)
  expect(subBusinesses.find((b) => b.slug === slug)!.role).toBe('subcontractor')

  // Joining does not confer visibility of anyone else's work.
  expect(subBusinesses.find((b) => b.slug === slug)!.canViewAllJobs).toBe(false)

  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  // The roster shows people, not user ids.
  expect(members.map((m) => m.email)).toContain(subEmail)
  expect(members.find((m) => m.email === subEmail)!.name).toBe('Kevin')
})

test('an owner grants view-all access from settings', async ({ page }) => {
  const ownerEmail = uniqueEmail('grant-owner')
  const subEmail = uniqueEmail('grant-sub')

  const owner = await signUpActor(ownerEmail, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `Grant ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  await owner.client.mutation(api.memberships.inviteByEmail, {
    businessId,
    email: subEmail,
    role: 'subcontractor',
  })

  const sub = await signUpActor(subEmail, FIXTURE_PASSWORD, 'Kevin')
  await sub.client.mutation(api.memberships.claimInvitations, {})

  await signInViaUi(page, ownerEmail)
  await page.goto(`/${slug}/settings?seg=team`)

  const toggle = page.getByRole('switch').first()
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('data-state', 'unchecked')

  await toggle.click()
  await expect(toggle).toHaveAttribute('data-state', 'checked')

  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  expect(members.find((m) => m.email === subEmail)!.canViewAllJobs).toBe(true)
})

test('a subcontractor cannot invite or see the team roster controls', async ({
  page,
}) => {
  const ownerEmail = uniqueEmail('noinvite-owner')
  const subEmail = uniqueEmail('noinvite-sub')

  const owner = await signUpActor(ownerEmail, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `NoInvite ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )
  await owner.client.mutation(api.memberships.inviteByEmail, {
    businessId,
    email: subEmail,
    role: 'subcontractor',
  })

  const sub = await signUpActor(subEmail, FIXTURE_PASSWORD, 'Kevin')
  await sub.client.mutation(api.memberships.claimInvitations, {})

  // Rejected at the function, not merely hidden from the segmented control.
  await expectRejected(
    () =>
      sub.client.mutation(api.memberships.inviteByEmail, {
        businessId,
        email: 'someone@example.com',
        role: 'subcontractor',
      }),
    'NO_ACCESS',
  )

  await signInViaUi(page, subEmail)
  await page.goto(`/${slug}/settings`)

  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Team' })).toHaveCount(0)
})
