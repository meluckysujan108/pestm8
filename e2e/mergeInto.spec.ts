import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Page } from '@playwright/test'
import type { Actor } from './fixtures'
import type { Id } from '../convex/_generated/dataModel'

/**
 * Two records for one customer, merged from the client sheet (the matching
 * plan's M8): the possible-duplicate line the server's check leaves when a
 * new client is saved past a match, its Merge… and Not the same, and
 * Details → Merge into… with its list. A subcontractor, who can't change
 * clients, is offered neither.
 *
 * The duplicate is made as a sheet makes it after Save anyway: through
 * `properties.create` with `matchCheck`, the client it matched dismissed,
 * so the server lets it through and notes the pair. Numbers are from ACMA's
 * ranges for fiction. On a phone's screen.
 */

const TZ = 'Australia/Perth'
const MOBILE = '0491 570 162'

/** The line on either Jane Nguyen's sheet: the other named by number where
 * the client list is in memory as it draws, bare where it isn't. */
const SAME_LINE =
  /May be the same customer as Jane Nguyen(?: #\d+)?: same name and mobile\./

test.use({ viewport: { width: 390, height: 844 } })
test.describe.configure({ timeout: 120_000 })

/** The client a site made by `properties.create` belongs to. */
async function clientOf(
  owner: Actor,
  businessId: Id<'businesses'>,
  propertyId: Id<'properties'>,
): Promise<Id<'clients'>> {
  const book = await owner.client.query(api.clients.directory, { businessId })
  const site = book.sites.find((s) => s._id === propertyId)
  if (!site) throw new Error(`no site ${propertyId} in the client list`)
  return site.clientId
}

/**
 * Jane Nguyen at 12 Wattle St, Bayswater, with her mobile; then Jane Nguyen
 * again, with the same mobile, at 4 Banksia Rd, Morley, saved past the
 * match; and Amy Lo, who is no one's duplicate.
 */
async function seedDuplicate(owner: Actor, businessId: Id<'businesses'>) {
  const firstSite = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Jane Nguyen',
    kind: 'person',
    phone: MOBILE,
    addressLine: '12 Wattle St',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const first = await clientOf(owner, businessId, firstSite)
  // Everyone the server's check could name, booked past: Jane, and in a
  // business with clients of its own (a subcontractor's below), them too.
  const book = await owner.client.query(api.clients.directory, { businessId })
  const secondSite = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Jane Nguyen',
    kind: 'person',
    phone: MOBILE,
    addressLine: '4 Banksia Rd',
    suburb: 'Morley',
    state: 'WA',
    postcode: '6062',
    matchCheck: { by: 'sheet', dismissed: book.clients.map((c) => c._id) },
  })
  const second = await clientOf(owner, businessId, secondSite)
  await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Amy Lo',
    kind: 'person',
    addressLine: '9 Rokeby Rd',
    suburb: 'Subiaco',
    state: 'WA',
    postcode: '6008',
  })
  // The server noted the pair, on the new client's sheet.
  const hints = await owner.client.query(api.clientMatchHints.forClient, {
    businessId,
    clientId: second,
  })
  expect(hints.map((h) => h.otherClientId)).toContain(first)
  return { first, firstSite, second, secondSite }
}

/** A business of the owner's own, with the duplicate in it. */
async function seedBusiness(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `${label} ${Date.now()}`, state: 'WA', timezone: TZ },
  )
  return {
    owner,
    businessId,
    slug,
    ...(await seedDuplicate(owner, businessId)),
  }
}

/** The Clients page, and the sheet of the Jane Nguyen in `suburb`. */
async function openJane(page: Page, slug: string, suburb: string) {
  await page.goto(`/${slug}/clients`)
  return openJaneHere(page, suburb)
}

/** The sheet of the Jane Nguyen in `suburb`, from the Clients page already
 * on screen: what this page has asked for so far is still in memory. */
async function openJaneHere(page: Page, suburb: string) {
  const sheet = page.getByRole('dialog', { name: 'Jane Nguyen', exact: true })
  // Settled on what the tap itself does: once the sheet is open the list
  // behind it is hidden, and a retried tap could never land.
  await clickUntil(
    page
      .getByRole('button', { name: /Jane Nguyen/ })
      .filter({ hasText: suburb })
      .first(),
    () => expect(sheet).toBeVisible({ timeout: 2_000 }),
  )
  await expect(sheet.getByRole('tab', { name: 'Jobs' })).toBeEnabled()
  return sheet
}

/** The merge sheet, over the client's. */
function mergeSheet(page: Page) {
  return page.getByRole('dialog', { name: /^Merge Jane Nguyen/ })
}

/** Its Merge…, once the preview has counted, and the confirm's Merge. */
async function confirmMerge(page: Page) {
  const ask = mergeSheet(page).getByRole('button', { name: 'Merge…' })
  await expect(ask).toBeEnabled()
  await ask.click()
  const confirm = page.getByRole('alertdialog', { name: /^Merge Jane Nguyen/ })
  await expect(confirm).toContainText('This can’t be undone.')
  await confirm.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(mergeSheet(page)).toBeHidden()
}

/** The first Jane has both sites, and the second is in the Recycle bin. */
async function expectMerged(
  owner: Actor,
  businessId: Id<'businesses'>,
  seeded: Awaited<ReturnType<typeof seedDuplicate>>,
) {
  const sites = await owner.client.query(api.properties.listByClient, {
    businessId,
    clientId: seeded.first,
  })
  expect(sites.map((s) => s._id).sort()).toEqual(
    [seeded.firstSite, seeded.secondSite].sort(),
  )
  const book = await owner.client.query(api.clients.directory, { businessId })
  expect(book.clients.map((c) => c._id)).not.toContain(seeded.second)
  expect(book.clients.map((c) => c._id)).toContain(seeded.first)
}

test('the owner merges a duplicate from its line: the client there first is kept, with both sites', async ({
  page,
}) => {
  const s = await seedBusiness('merge-line')
  await signInViaUi(page, s.owner.email)
  const sheet = await openJane(page, s.slug, 'Morley')

  const lines = sheet.getByRole('list', { name: 'Possible duplicates' })
  await expect(lines).toContainText(SAME_LINE)
  await lines.getByRole('button', { name: 'Merge…' }).click()

  // The pair: the Jane Nguyen there first is kept, the new one goes.
  const merge = mergeSheet(page)
  await expect(merge).toBeVisible()
  await expect(
    merge.getByRole('button', { name: /^Keep Jane Nguyen/ }),
  ).toBeVisible()
  await expect(merge).toContainText('Goes to the Recycle bin')
  await confirmMerge(page)

  // The sheet gives way to the client kept, saying what was merged.
  await expect(
    sheet.getByRole('status').filter({ hasText: /^Merged — / }),
  ).toBeVisible()
  await expect(
    sheet.getByRole('list', { name: 'Possible duplicates' }),
  ).toHaveCount(0)
  await expectMerged(s.owner, s.businessId, s)

  // And the other is gone from Clients.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('button', { name: /Jane Nguyen/ })).toHaveCount(1)
})

test('Not the same sets the line aside, and the two stay', async ({ page }) => {
  const s = await seedBusiness('merge-different')
  await signInViaUi(page, s.owner.email)
  const sheet = await openJane(page, s.slug, 'Morley')

  const lines = sheet.getByRole('list', { name: 'Possible duplicates' })
  await expect(lines).toContainText(SAME_LINE)

  // The other Jane's sheet, opened next to compare, has it too: the line
  // asked for her lines with her record, so her sheet draws with both.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  const other = await openJaneHere(page, 'Bayswater')
  const otherLines = other.getByRole('list', { name: 'Possible duplicates' })
  await expect(otherLines).toContainText(SAME_LINE)

  // It asks first: the answer can't be taken back. Its buttons take no tap
  // for a moment as it comes up, which the click waits out.
  await otherLines.getByRole('button', { name: 'Not the same' }).click()
  const ask = page.getByRole('alertdialog', {
    name: /^Not the same customer as Jane Nguyen/,
  })
  await expect(ask).toContainText('It can’t be brought back')
  await ask.getByRole('button', { name: 'Not the same' }).click()
  await expect(ask).toBeHidden()

  // Answered, the line stays where it was, saying so, until the sheet is
  // next opened.
  await expect(otherLines.getByRole('status')).toHaveText(
    /^Saved — not the same customer as Jane Nguyen(?: #\d+)?\.$/,
  )
  await expect(
    otherLines.getByRole('button', { name: 'Not the same' }),
  ).toBeDisabled()

  await expect
    .poll(() =>
      s.owner.client.query(api.clientMatchHints.forClient, {
        businessId: s.businessId,
        clientId: s.second,
      }),
    )
    .toEqual([])
  const book = await s.owner.client.query(api.clients.directory, {
    businessId: s.businessId,
  })
  expect(book.clients.map((c) => c._id)).toEqual(
    expect.arrayContaining([s.first, s.second]),
  )

  // Opened again, neither sheet has it: the other Jane's, and the one
  // where it was answered.
  await page.keyboard.press('Escape')
  await expect(other).toBeHidden()
  const again = await openJaneHere(page, 'Morley')
  await expect(
    again.getByRole('list', { name: 'Possible duplicates' }),
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(again).toBeHidden()
  const answered = await openJaneHere(page, 'Bayswater')
  await expect(
    answered.getByRole('list', { name: 'Possible duplicates' }),
  ).toHaveCount(0)
})

test('Merge into… from Details: the client alike first in the list, then everyone', async ({
  page,
}) => {
  const s = await seedBusiness('merge-into')
  await signInViaUi(page, s.owner.email)
  const sheet = await openJane(page, s.slug, 'Morley')

  await sheet.getByRole('tab', { name: 'Details' }).click()
  await sheet.getByRole('button', { name: 'Merge into…' }).click()

  const merge = page.getByRole('dialog', { name: 'Merge Jane Nguyen into…' })
  await expect(merge).toBeVisible()
  const headings = merge.getByRole('heading', { level: 3 })
  await expect(headings).toHaveText([
    'May be the same customer',
    'Everyone, A–Z',
  ])
  // Never the client being merged.
  await expect(
    merge.getByRole('button', { name: /^Jane Nguyen — Morley/ }),
  ).toHaveCount(0)
  await expect(merge.getByRole('button', { name: /^Amy Lo/ })).toBeVisible()

  await merge.getByRole('button', { name: /^Jane Nguyen — Bayswater/ }).click()
  await expect(mergeSheet(page)).toContainText('Kept')
  await confirmMerge(page)

  await expect(
    sheet.getByRole('status').filter({ hasText: /^Merged — / }),
  ).toBeVisible()
  await expectMerged(s.owner, s.businessId, s)
})

test('a subcontractor’s client sheet has no possible-duplicate line and no Merge into…', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('merge-sub')
  await seedDuplicate(s.owner, s.businessId)

  await signInViaUi(page, s.sub.email)
  const sheet = await openJane(page, s.slug, 'Morley')
  await sheet.getByRole('tab', { name: 'Details' }).click()
  await expect(sheet.getByText('Client number')).toBeVisible()

  await expect(
    sheet.getByRole('list', { name: 'Possible duplicates' }),
  ).toHaveCount(0)
  await expect(sheet.getByText(/May be the same customer/)).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Merge into…' })).toHaveCount(
    0,
  )
})
