import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  expectRejected,
  inviteAndJoin,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Page } from '@playwright/test'

/**
 * "Bring your clients across": a client list from another app, read in the
 * browser, matched, reviewed and imported — and taken back again with Undo.
 * What the page promised is checked against the server, not just the
 * screen: the right address went in, the ABN landed on the business.
 */

/** An owner and a business, straight from the API — no set-up flow, so
 * sign-in lands on the schedule. */
async function owner(label: string) {
  const actor = await signUpActor(uniqueEmail(label), FIXTURE_PASSWORD, 'Jo')
  const { businessId, slug } = await actor.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )
  return { actor, businessId, slug }
}

function fixture(name: string) {
  return {
    name,
    mimeType: 'text/csv',
    buffer: readFileSync(
      new URL(`./fixtures/imports/${name}`, import.meta.url),
    ),
  }
}

/** Chooses a file on the import page. The picker's input is set directly,
 * but only once the page has hydrated — its change handler is React's, and
 * a file set before that is dropped without a word — which is when "Choose
 * a file" wakes up. */
async function chooseFile(page: Page, name: string) {
  await expect(
    page.getByRole('button', { name: 'Choose a file' }),
  ).toBeEnabled()
  await page
    .locator('input[type="file"][accept*=".csv"]')
    .setInputFiles(fixture(name))
  await expect(
    page.getByRole('heading', { name: 'Match your columns' }),
  ).toBeVisible()
}

test('a Jobber export goes in, lands on the clients page, and Undo takes it back', async ({
  page,
}) => {
  const { actor, businessId, slug } = await owner('import-jobber')
  await signInViaUi(page, actor.email)

  // An empty clients page offers the list as well as one client at a time.
  await page.goto(`/${slug}/clients`)
  await expect(page.getByRole('link', { name: 'Import clients' })).toBeVisible()
  await clickUntil(page.getByRole('link', { name: 'Import a list' }), () =>
    expect(page).toHaveURL(new RegExp(`/${slug}/clients/import`), {
      timeout: 5_000,
    }),
  )
  await expect(
    page.getByRole('heading', { name: 'Bring your clients across' }),
  ).toBeVisible()

  await chooseFile(page, 'jobber-clients.csv')
  await expect(page.getByText('Looks like a Jobber export')).toBeVisible()
  // Jobber's billing address is the invoice's; the service address is the
  // site.
  await expect(
    page.getByLabel('Service Street 1', { exact: true }),
  ).toHaveValue('street')
  await expect(
    page.getByLabel('Billing Street 1', { exact: true }),
  ).toHaveValue('')

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(
    page.getByRole('heading', { name: 'Check what’s coming in' }),
  ).toBeVisible()

  // Two rows of one client are one client with two sites; the NT postcode
  // Excel shortened is put back; the row with no address can't go in.
  const jane = page.getByRole('listitem', { name: 'Jane Citizen' })
  await expect(jane).toContainText('12 Wattle Street, Bayswater WA 6053')
  await expect(jane).toContainText('7 Banksia Road, Morley WA 6062')
  await expect(jane).toContainText('Gate code 1234')
  const topEnd = page.getByRole('listitem', {
    name: 'Top End Holdings Pty Ltd',
  })
  await expect(topEnd).toContainText('Postcode 810 → 0810')
  await expect(topEnd).toContainText('Sam Lee')
  const bob = page.getByRole('listitem', { name: 'Bob Walker' })
  await expect(bob).toContainText(/Can.t import/)
  await expect(bob).toContainText('No address')

  await page.getByRole('button', { name: 'Import 2 clients' }).click()
  await expect(
    page.getByRole('heading', {
      name: '2 clients and 3 sites are in PestM8',
    }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('1 site note')).toBeVisible()
  await expect(page.getByText(/1 client couldn.t be imported/)).toBeVisible()
  await expect(page.getByText('Bob Walker', { exact: true })).toBeVisible()

  await clickUntil(page.getByRole('link', { name: 'Go to clients' }), () =>
    expect(page).toHaveURL(new RegExp(`/${slug}/clients/?$`), {
      timeout: 5_000,
    }),
  )
  await expect(page.getByText('Jane Citizen')).toBeVisible()
  await expect(page.getByText('Top End Holdings Pty Ltd')).toBeVisible()

  // What went in: three sites, the NT postcode whole again, the notes column
  // as a pinned note on its site, and the business's contact its primary
  // contact.
  const sites = await actor.client.query(api.properties.list, { businessId })
  expect(sites).toHaveLength(3)
  const nightcliff = sites.find((s) => s.suburb === 'Nightcliff')
  expect(nightcliff?.postcode).toBe('0810')
  const pinned = await actor.client.query(api.notes.listPinned, { businessId })
  expect(
    pinned.find((n) => n.addressLine === '12 Wattle Street')?.preview,
  ).toContain('Gate code 1234')
  const contacts = await actor.client.query(api.clientContacts.list, {
    businessId,
    clientId: nightcliff!.clientId,
  })
  expect(contacts.find((c) => c.isPrimary)?.name).toBe('Sam Lee')

  // Undo, from Recent imports.
  await page.goto(`/${slug}/clients/import`)
  const undo = page.getByRole('button', { name: 'Undo jobber-clients.csv' })
  await expect(undo).toBeEnabled()
  const dialog = page.getByRole('alertdialog', { name: 'Undo this import?' })
  await clickUntil(undo, () => expect(dialog).toBeVisible({ timeout: 3_000 }))
  await dialog.getByRole('button', { name: 'Undo import' }).click()
  await expect(page.getByText('Undone', { exact: true })).toBeVisible({
    timeout: 30_000,
  })

  await expect
    .poll(
      async () =>
        (await actor.client.query(api.clients.list, { businessId })).length,
      { timeout: 30_000 },
    )
    .toBe(0)
  expect(
    await actor.client.query(api.properties.list, { businessId }),
  ).toHaveLength(0)
})

test('a Xero export uses the street address, not the postal one, and the ABN lands on the business', async ({
  page,
}) => {
  const { actor, businessId, slug } = await owner('import-xero')
  await signInViaUi(page, actor.email)

  await page.goto(`/${slug}/clients/import`)
  await chooseFile(page, 'xero-contacts.csv')
  await expect(page.getByText('Looks like a Xero export')).toBeVisible()
  await expect(page.getByLabel('SAAddressLine1', { exact: true })).toHaveValue(
    'street',
  )
  await expect(page.getByLabel('POAddressLine1', { exact: true })).toHaveValue(
    '',
  )
  await expect(page.getByLabel('TaxNumber', { exact: true })).toHaveValue('abn')

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(
    page.getByRole('listitem', { name: 'Harbourside Cafe' }),
  ).toContainText('ABN 51 824 753 556')
  await page.getByRole('button', { name: 'Import 2 clients' }).click()
  await expect(
    page.getByRole('heading', {
      name: '2 clients and 2 sites are in PestM8',
    }),
  ).toBeVisible({ timeout: 30_000 })

  const clients = await actor.client.query(api.clients.list, { businessId })
  const cafe = clients.find((c) => c.name === 'Harbourside Cafe')
  expect(cafe?.kind).toBe('business')
  expect(cafe?.abn).toBe('51824753556')
  const priya = clients.find((c) => c.name === 'Priya Sharma')
  expect(priya?.kind).toBe('person')
  expect(priya?.abn).toBeUndefined()

  const sites = await actor.client.query(api.properties.list, { businessId })
  const cafeSite = sites.find((s) => s.clientId === cafe?._id)
  expect(cafeSite?.addressLine).toBe('8 Mews Road')
  expect(cafeSite?.suburb).toBe('Fremantle')
  expect(cafeSite?.postcode).toBe('6160')
  expect(sites.some((s) => /PO Box/i.test(s.addressLine))).toBe(false)

  const contacts = await actor.client.query(api.clientContacts.list, {
    businessId,
    clientId: cafe!._id,
  })
  expect(contacts.find((c) => c.isPrimary)?.name).toBe('Mia Chen')
})

test('a subcontractor is not offered an import, and the server refuses one', async ({
  page,
}) => {
  const { actor, businessId, slug } = await owner('import-sub')
  const sub = await signUpActor(
    uniqueEmail('import-sub-kevin'),
    FIXTURE_PASSWORD,
    'Kevin',
  )
  await inviteAndJoin(actor, sub, businessId)

  // The rule that matters is the server's.
  await expectRejected(
    () =>
      sub.client.mutation(api.clientImports.start, {
        businessId,
        fileName: 'clients.csv',
      }),
    'NO_ACCESS',
  )

  await signInViaUi(page, sub.email)
  await page.goto(`/${slug}/clients`)
  await expect(page.getByRole('button', { name: 'New client' })).toBeEnabled()
  await expect(page.getByRole('link', { name: 'Import clients' })).toHaveCount(
    0,
  )

  await page.goto(`/${slug}/clients/import`)
  await expect(
    page.getByText('Importing is for the owner and contractors'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose a file' })).toHaveCount(
    0,
  )
})
