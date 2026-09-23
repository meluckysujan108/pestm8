import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  inviteAndJoin,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * The design partner's actual setup: Terence invites Kevin, Kevin joins, and
 * Terence later grants read visibility of the whole schedule.
 *
 * Joining is a link, not an email address. This used to assert the opposite —
 * that signing up with an invited address was enough — which is precisely the
 * behaviour that let anyone who registered that address first into the
 * business.
 */
test('an owner invites a subcontractor, who joins with the link', async ({
  page,
}) => {
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

  const createLink = page.getByRole('button', { name: 'Create link' })
  await expect(createLink).toBeEnabled()
  await page.getByLabel('Email address').fill(subEmail)
  await createLink.click()

  // The link is shown exactly once, because only its hash is stored.
  const linkText = page.getByText(/\/join\//)
  await expect(linkText).toBeVisible()
  const url = (await linkText.innerText()).trim()
  const token = url.split('/join/')[1]
  expect(token).toBeTruthy()

  // And the invite shows as outstanding until it is used. The address appears
  // twice on this screen — in the link card and in the waiting list — so this
  // asks for the exact-match one, which is the list row.
  await expect(page.getByText(subEmail, { exact: true })).toBeVisible()

  // Kevin signs up and redeems the link he was sent.
  const sub = await signUpActor(subEmail, FIXTURE_PASSWORD, 'Kevin')
  await sub.client.action(api.invitations.redeem, { token })

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

  // The link is spent: a second person with the same address cannot reuse it.
  const impostor = await signUpActor(
    uniqueEmail('team-impostor'),
    FIXTURE_PASSWORD,
    'Impostor',
  )
  await expectRejected(
    () => impostor.client.action(api.invitations.redeem, { token }),
    'INVITE_ALREADY_USED',
  )
})

test('signing up with an invited address is not enough to get in', async () => {
  const ownerEmail = uniqueEmail('squat-owner')
  const subEmail = uniqueEmail('squat-sub')

  const owner = await signUpActor(ownerEmail, FIXTURE_PASSWORD, 'Terence')
  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `Squat ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  await owner.client.action(api.invitations.create, {
    businessId,
    email: subEmail,
    role: 'subcontractor',
  })

  // The old attack: register the invited address and wait to be let in.
  const squatter = await signUpActor(subEmail, FIXTURE_PASSWORD, 'Not Kevin')
  await expect(
    squatter.client.mutation(api.memberships.claimInvitations, {}),
  ).resolves.toEqual([])

  const businesses = await squatter.client.query(api.businesses.listForUser, {})
  expect(businesses).toHaveLength(0)

  await expectRejected(
    () =>
      squatter.client.query(api.memberships.listForBusiness, { businessId }),
    'NO_ACCESS',
  )
})

test('an owner grants view-all access from settings', async ({ page }) => {
  const ownerEmail = uniqueEmail('grant-owner')
  const subEmail = uniqueEmail('grant-sub')

  const owner = await signUpActor(ownerEmail, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `Grant ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  const sub = await signUpActor(subEmail, FIXTURE_PASSWORD, 'Kevin')
  await inviteAndJoin(owner, sub, businessId)

  await signInViaUi(page, ownerEmail)
  await page.goto(`/${slug}/settings?seg=team`)
  // A tap before hydration is dropped: the server-rendered switch has no
  // handler yet. Create link stays disabled until the page has hydrated.
  await expect(page.getByRole('button', { name: 'Create link' })).toBeEnabled()

  const toggle = page.getByRole('switch').first()
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('data-state', 'unchecked')
  // Retired: the client book is open to everyone in the business.
  await expect(page.getByText('Can see all clients')).toBeHidden()

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
  const sub = await signUpActor(subEmail, FIXTURE_PASSWORD, 'Kevin')
  await inviteAndJoin(owner, sub, businessId)

  // Rejected at the function, not merely hidden from the segmented control.
  await expectRejected(
    () =>
      sub.client.action(api.invitations.create, {
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

test('nobody can be invited as an owner', async () => {
  const owner = await signUpActor(
    uniqueEmail('ownerinvite-owner'),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `OwnerInvite ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  await expectRejected(
    () =>
      owner.client.action(api.invitations.create, {
        businessId,
        email: uniqueEmail('would-be-owner'),
        role: 'owner',
      }),
    'OWNER_INVITE_FORBIDDEN',
  )
})
