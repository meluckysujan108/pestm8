import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  inviteAndJoin,
  licenceSelf,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
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
  // account he may work in (see viewMenu.spec.ts); the Settings hub's list is
  // for everyone else.
  await page.getByRole('button', { name: 'Whose jobs to show' }).click()
  await expect(page.getByText('Work in another account')).toBeVisible()
  await page.getByRole('menuitemradio', { name: /Kevin/ }).click()

  // The banner is the whole point: it says whose account this is, and that
  // what happens here is recorded.
  const banner = page.getByText(/Working in .*’s account/)
  await expect(banner).toBeVisible()
  await expect(page.getByText(/everything you do is recorded/)).toBeVisible()

  // The Settings hub drops every business row while switched — the server
  // has stopped honouring what they open — and says why, rather than leave
  // the owner wondering where his business went. His own rows stay. Scoped
  // to the page, not the sidebar.
  await page.goto(`/${slug}/settings`)
  const hub = page.getByRole('main')
  await expect(
    hub.getByText(
      'Switch back to your own account to change business settings.',
    ),
  ).toBeVisible()
  await expect(hub.getByRole('link', { name: /^My details/ })).toBeVisible()
  await expect(
    hub.getByRole('link', { name: /^Business details/ }),
  ).toHaveCount(0)
  await expect(hub.getByRole('link', { name: /^Team/ })).toHaveCount(0)
  await expect(hub.getByRole('link', { name: /^Reports/ })).toHaveCount(0)

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
  // retried until it takes rather than lost to a page still hydrating. It has
  // taken once the button is busy or gone — not once the banner has gone,
  // which can take longer than a retry waits, and a retry would then be
  // clicking a button that is already stopping the switch.
  await clickUntil(page.getByRole('button', { name: 'Switch back' }), () =>
    expect(
      page.getByRole('button', { name: 'Switch back', disabled: false }),
    ).toHaveCount(0, { timeout: 2_000 }),
  )
  await expect(banner).toBeHidden()
  // The same page, live: the team comes back without a reload.
  await expect(invite).toBeVisible()
  await expect(page.getByRole('link', { name: /^Kevin/ })).toBeVisible()

  // The switch was a real row, and stopping removed it — not just a client
  // flag that a reload would restore.
  const after = await owner.client.query(api.access.me, { businessId })
  expect(after.actingAs).toBeNull()
  expect(subMembershipId).toBeTruthy()
})

test('the owner is in nobody else’s list of accounts', async ({ page }) => {
  const { sub, businessId, slug } = await setupBusinessWithSub(
    'switch-owner-hidden',
  )

  // A subcontractor with no grant has nobody to work in, and the owner is
  // never a candidate for anyone. He is visible as a person now (see
  // ownerTechnician.spec.ts) — visible is not the same as enterable.
  expect(
    await sub.client.query(api.accountSwitches.targets, { businessId }),
  ).toEqual([])

  // And Settings, where everyone but the owner starts a switch, offers none.
  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/settings`)
  const hub = page.getByRole('main')
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeEnabled()
  await expect(hub.getByRole('link', { name: /^My details/ })).toBeVisible()
  await expect(hub.getByText('Work in another account')).toHaveCount(0)
  await expect(hub.getByText(/Terence/)).toHaveCount(0)
})

/**
 * Everyone but the owner starts a switch from the Settings hub: a contractor
 * into their own crew, a granted subcontractor into their contractor. The
 * owner has the view menu, and nobody has the header's old account menu.
 */
test('a contractor works in their crew’s account from Settings, then comes back', async ({
  page,
}) => {
  const { owner, sub, businessId, slug, subMembershipId } =
    await setupBusinessWithSub('switch-crew')

  // Kevin runs a crew of one: Mia, who answers to him rather than the owner.
  await owner.client.mutation(api.memberships.setRole, {
    businessId,
    membershipId: subMembershipId,
    role: 'contractor',
  })
  const mia = await signUpActor(
    uniqueEmail('mia-switch-crew'),
    FIXTURE_PASSWORD,
    'Mia',
  )
  await inviteAndJoin(owner, mia, businessId)
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const miaMembershipId = members.find((m) => m.email === mia.email)!._id
  await owner.client.mutation(api.team.assignTo, {
    businessId,
    membershipId: miaMembershipId,
    parentMembershipId: subMembershipId,
  })

  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/settings`)
  const hub = page.getByRole('main')
  await expect(hub.getByText('Work in another account')).toBeVisible()
  // Disabled until hydrated, so this waits rather than tapping dead markup.
  const mias = hub.getByRole('button', { name: /^Mia/ })
  await expect(mias).toBeEnabled()
  await mias.click()

  // Straight to the schedule, where her work is, under the banner that says
  // whose account this is.
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule`))
  const banner = page.getByText(/Working in Mia’s account/)
  await expect(banner).toBeVisible()

  // No second hop from inside her account: the list is gone, and the way
  // out is the banner.
  await page.goto(`/${slug}/settings`)
  await expect(hub.getByRole('link', { name: /^My details/ })).toBeVisible()
  await expect(hub.getByText('Work in another account')).toHaveCount(0)

  await clickUntil(page.getByRole('button', { name: 'Switch back' }), () =>
    expect(
      page.getByRole('button', { name: 'Switch back', disabled: false }),
    ).toHaveCount(0, { timeout: 2_000 }),
  )
  await expect(banner).toBeHidden()
  // The same page, live: the list comes back without a reload.
  await expect(hub.getByRole('button', { name: /^Mia/ })).toBeVisible()
})

/**
 * The other way up: a subcontractor their contractor has let in ("can work in
 * my account") finds that contractor in the same list. Nothing about the
 * list is per-role on the page — the server decides who is in it — so this
 * is the grant reaching the screen, not a second implementation.
 */
test('a granted subcontractor finds their contractor’s account in Settings', async ({
  page,
}) => {
  const { owner, businessId, slug, subMembershipId } =
    await setupBusinessWithSub('switch-up')

  await owner.client.mutation(api.memberships.setRole, {
    businessId,
    membershipId: subMembershipId,
    role: 'contractor',
  })
  const mia = await signUpActor(
    uniqueEmail('mia-switch-up'),
    FIXTURE_PASSWORD,
    'Mia',
  )
  await inviteAndJoin(owner, mia, businessId)
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const miaMembershipId = members.find((m) => m.email === mia.email)!._id
  await owner.client.mutation(api.team.assignTo, {
    businessId,
    membershipId: miaMembershipId,
    parentMembershipId: subMembershipId,
  })
  await owner.client.mutation(api.memberships.setGrants, {
    businessId,
    membershipId: miaMembershipId,
    grants: {
      switchInto: subMembershipId,
      clientDirectory: false,
      prices: false,
      otherSchedules: false,
    },
  })

  await signInViaUi(page, mia.email)
  await page.goto(`/${slug}/settings`)
  const hub = page.getByRole('main')
  await expect(hub.getByText('Work in another account')).toBeVisible()
  // Kevin, and only Kevin: never the owner, never a teammate.
  await expect(hub.getByRole('button', { name: /^Kevin/ })).toBeEnabled()
  await expect(hub.getByRole('button', { name: /Contractor$/ })).toHaveCount(1)
  await expect(hub.getByText(/Terence/)).toHaveCount(0)

  await hub.getByRole('button', { name: /^Kevin/ }).click()
  await expect(page.getByText(/Working in Kevin’s account/)).toBeVisible()
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

  // The caption under his name on the team list is what the owner actually
  // reads, and it is rendered from the live query rather than from the select
  // just moved.
  await page.getByRole('link', { name: 'Team', exact: true }).click()
  await expect(page.getByRole('link', { name: /^Kevin/ })).toContainText(
    /Contractor/,
  )
})
