import { expect, test } from '@playwright/test'
import { api, licenceSelf, setupBusinessWithSub, signInViaUi } from './fixtures'

/**
 * Working inside somebody else's account, through the browser.
 *
 * The unit tests prove the rules against a real database; nothing proved that
 * a person can actually reach them. These are the journeys in between — the
 * banner appearing, the administration disappearing, the way back out — each
 * of which is a place the model and the interface could disagree without
 * either one being wrong on its own.
 *
 * `viewAs.spec.ts` covers the older read-only lens and stays as it is: the two
 * features exist side by side until the legacy column is dropped, and the
 * suite should notice if either stops working.
 */

test('an owner works in a subcontractor’s account, then comes back out', async ({
  page,
}) => {
  const { owner, businessId, slug, subMembershipId } =
    await setupBusinessWithSub('switch-journey')

  await signInViaUi(page, owner.email)
  await page.goto(`/${slug}/schedule`)

  // Nothing is claimed about the account before a switch starts.
  await expect(page.getByText(/Working in/)).toBeHidden()

  await page.getByRole('button', { name: 'Account menu' }).click()
  await expect(page.getByText('Work in another account')).toBeVisible()
  await page.getByRole('button', { name: /Kevin/ }).click()

  // The banner is the whole point: it says whose account this is, and that
  // what happens here is recorded.
  const banner = page.getByText(/Working in .*’s account/)
  await expect(banner).toBeVisible()
  await expect(page.getByText(/everything you do is recorded/)).toBeVisible()

  /**
   * The rule that makes switching safe to offer at all. `team.manage` is false
   * while switched, so the Team tab is not merely hidden — the server has
   * stopped honouring it, and the two agree because both read the same live
   * query.
   */
  await page.goto(`/${slug}/settings`)
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Team' })).toBeHidden()

  // Editing a profile while switched still edits your own: identity-bearing
  // writes always resolve the real person.
  await expect(page.getByLabel('Name')).toHaveValue('Terence')

  await page.getByRole('button', { name: 'Switch back' }).click()
  await expect(banner).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Team' })).toBeVisible()

  // The switch was a real row, and stopping removed it — not just a client
  // flag that a reload would restore.
  const after = await owner.client.query(api.access.me, { businessId })
  expect(after.actingAs).toBeNull()
  expect(subMembershipId).toBeTruthy()
})

test('the owner is in nobody else’s account menu', async ({ page }) => {
  const { sub, slug } = await setupBusinessWithSub('switch-owner-hidden')

  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/schedule`)
  await page.getByRole('button', { name: 'Account menu' }).click()

  // A subcontractor with no grant has nobody to work in, and the owner is
  // never a candidate for anyone. He is visible as a person now (see
  // ownerTechnician.spec.ts) — visible is not the same as enterable.
  await expect(page.getByText('Your account')).toBeVisible()
  await expect(page.getByText('Work in another account')).toBeHidden()
  await expect(page.getByText(/Terence/)).toBeHidden()
})

test('a price hidden from someone is hidden everywhere they look', async ({
  page,
}) => {
  const { owner, sub, businessId, slug, propertyId, subMembershipId } =
    await setupBusinessWithSub('switch-prices')

  await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: subMembershipId,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: Date.now(),
    durationMinutes: 90,
  })

  // The toggle only bites once it is off; a legacy row resolves to "can see
  // prices", so a test that skipped this would pass without hiding anything.
  await owner.client.mutation(api.memberships.setGrants, {
    businessId,
    membershipId: subMembershipId,
    grants: {
      switchInto: null,
      clientDirectory: true,
      prices: false,
      otherSchedules: true,
    },
  })

  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/schedule`)

  // An em dash, not "$0" — a zero reads as a real price and nobody questions
  // it — and not "$NaN", which is what dropping the field would produce.
  await expect(page.getByText('$380').first()).toBeHidden()
  await expect(page.getByText('$NaN')).toHaveCount(0)

  // The aggregate is the leak the row-level redaction misses: a month with one
  // completed job makes the revenue total that job's price, to the cent.
  await page.goto(`/${slug}/analytics`)
  await expect(page.getByText('$NaN')).toHaveCount(0)
  await expect(page.getByText('$380')).toHaveCount(0)
})

test('an owner builds a contractor a team, and the team works in their account', async ({
  page,
}) => {
  const { owner, businessId, slug, subMembershipId } =
    await setupBusinessWithSub('switch-contractor')
  await licenceSelf(owner, businessId)

  // Kevin becomes a contractor from the Team screen, which is the only way an
  // owner has to do it.
  await signInViaUi(page, owner.email)
  await page.goto(`/${slug}/settings?seg=team`)
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()

  await page.getByLabel('Role').selectOption('contractor')

  // The caption under their name is what the owner actually reads, and it is
  // rendered from the live query rather than from the select they just moved.
  await expect(page.getByText(/^contractor/i).first()).toBeVisible()

  // And the server agrees, which is what the screen was claiming. Polled
  // because the assertion above can settle on the optimistic render.
  await expect
    .poll(async () => {
      const roster = await owner.client.query(api.team.roster, { businessId })
      return roster.find((m) => m._id === subMembershipId)?.role
    })
    .toBe('contractor')

  // A contractor can have a team, which is the whole reason the role was held
  // back until now — so the selector for putting someone on one appears.
  await expect(page.getByLabel('Works under')).toHaveCount(0)
})
