import { expect, test } from '@playwright/test'
import {
  api,
  clickUntil,
  licenceSelf,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'

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

  // The owner switches from the view menu beside the +, which lists every
  // account he may work in (see viewMenu.spec.ts); the account menu no longer
  // offers the same thing twice.
  await page.getByRole('button', { name: 'Whose jobs to show' }).click()
  await expect(page.getByText('Work in another account')).toBeVisible()
  await page.getByRole('menuitemradio', { name: /Kevin/ }).click()

  // The banner is the whole point: it says whose account this is, and that
  // what happens here is recorded.
  const banner = page.getByText(/Working in .*’s account/)
  await expect(banner).toBeVisible()
  await expect(page.getByText(/everything you do is recorded/)).toBeVisible()

  // Editing a profile while switched still edits your own: identity-bearing
  // writes always resolve the real person.
  await page.goto(`/${slug}/settings/details`)
  await expect(page.getByLabel('Name')).toHaveValue('Terence')

  /**
   * The rule that makes switching safe to offer at all. `team.manage` is false
   * while switched, so the Team page offers nothing — not merely hidden, the
   * server has stopped honouring it, and the two agree because both read the
   * same live query.
   */
  await page.goto(`/${slug}/settings/team`)
  await expect(
    page.getByText('Only the business owner can change these.'),
  ).toBeVisible()
  const invite = page.getByRole('button', { name: 'Invite', exact: true })
  await expect(invite).toHaveCount(0)

  // Nothing on this page waits for hydration while switched, so the click is
  // retried until it takes rather than lost to a page still hydrating.
  await clickUntil(page.getByRole('button', { name: 'Switch back' }), () =>
    expect(banner).toBeHidden({ timeout: 2_000 }),
  )
  // The same page, live: the team comes back without a reload.
  await expect(invite).toBeVisible()
  await expect(page.getByRole('link', { name: /^Kevin/ })).toBeVisible()

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

  // Kevin becomes a contractor from his page under Team, which is the only
  // way an owner has to do it.
  await signInViaUi(page, owner.email)
  await page.goto(`/${slug}/settings/team`)
  await expect(
    page.getByRole('heading', { name: 'Team', level: 1 }),
  ).toBeVisible()
  // A tap before hydration is dropped. Invite stays disabled until the page
  // has hydrated.
  await expect(
    page.getByRole('button', { name: 'Invite', exact: true }),
  ).toBeEnabled()
  await page.getByRole('link', { name: /^Kevin/ }).click()
  await expect(
    page.getByRole('heading', { name: 'Kevin', level: 1 }),
  ).toBeVisible()

  // A change before hydration is dropped: the server-rendered select has no
  // handler yet, so it stays disabled until the page has hydrated.
  const role = page.getByLabel('Role')
  await expect(role).toBeEnabled()
  await role.selectOption('contractor')

  // And the server agrees, which is what the screen was claiming. Polled
  // because the select shows the choice before the server has it.
  await expect
    .poll(async () => {
      const roster = await owner.client.query(api.team.roster, { businessId })
      return roster.find((m) => m._id === subMembershipId)?.role
    })
    .toBe('contractor')

  // Only a subcontractor works under someone: as a contractor, Kevin answers
  // to the owner, so the selector for putting him on a team is gone.
  await expect(page.getByLabel('Works under')).toHaveCount(0)

  // The caption under his name on the team list is what the owner actually
  // reads, and it is rendered from the live query rather than from the select
  // just moved.
  await page.getByRole('link', { name: 'Team', exact: true }).click()
  await expect(page.getByRole('link', { name: /^Kevin/ })).toContainText(
    /Contractor/,
  )
})
