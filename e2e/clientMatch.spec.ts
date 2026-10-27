import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseJobTypes,
  clickUntil,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Page } from '@playwright/test'
import type { Actor } from './fixtures'
import type { Id } from '../convex/_generated/dataModel'

/**
 * Is the caller already a client? Part 1, search first (the matching plan's
 * M2): New Job's pickers find a caller by the email or number they give,
 * through the match index where their words wouldn't; a number nobody has
 * is the way in to a new client, with it in Phone; with no signal the same
 * runs over the copy kept on the phone, and says newer clients show with
 * signal; the Clients page finds a client by their own mobile; and a client
 * with no site yet is found by name and number and booked at a new site.
 *
 * Numbers are from ACMA's ranges for fiction: 0491 570 156 is nobody's.
 * On a phone's screen, as the pickers are used.
 */

const TZ = 'Australia/Perth'

/** Further on than KEPT_PAGE_AGE_MS (src/lib/offline/useKept.ts), so the
 * page the service worker serves counts as its own copy (keptCopy.spec.ts). */
const PAGE_AGE_MS = 3 * 60_000

/** Long enough for the client list to come live and be written to the
 * phone (a write 5 s after its answer). */
const KEEP_TIMEOUT = 30_000

const UNKNOWN = '0491 570 156'
const JANE_MOBILE = '0491 570 157'
const JANE_EMAIL = 'jane.nguyen@example.com'
const SAM_MOBILE = '0491 570 158'

test.use({ viewport: { width: 390, height: 844 } })
test.describe.configure({ timeout: 180_000 })

/**
 * A business with a few clients to search: Jane, with her own mobile and
 * email, at 12 Wattle St; an agency whose property manager is a contact
 * person with a mobile of her own; and Sam Wu, whose only site was put in
 * the Recycle bin, so he has none.
 */
async function bookWithClients(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `${label} ${Date.now()}`, state: 'WA', timezone: TZ },
  )
  await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Jane Nguyen',
    kind: 'person',
    phone: JANE_MOBILE,
    email: JANE_EMAIL,
    addressLine: '12 Wattle St',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const agencySite = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Ray White Bayswater',
    kind: 'business',
    phone: '08 7010 1234',
    addressLine: '1 King William St',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const agency = await clientOfSite(owner, businessId, agencySite)
  await owner.client.mutation(api.clientContacts.create, {
    businessId,
    clientId: agency,
    name: 'Sarah Lee',
    role: 'Property manager',
    phone: '0491 570 110',
  })
  const samSite = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Sam Wu',
    kind: 'person',
    phone: SAM_MOBILE,
    addressLine: '9 Banksia Rd',
    suburb: 'Morley',
    state: 'WA',
    postcode: '6062',
  })
  const sam = await clientOfSite(owner, businessId, samSite)
  await owner.client.mutation(api.bin.deleteProperty, {
    businessId,
    propertyId: samSite,
  })
  return { owner, businessId, slug, sam }
}

async function clientOfSite(
  owner: Actor,
  businessId: Id<'businesses'>,
  propertyId: Id<'properties'>,
): Promise<Id<'clients'>> {
  const { sites } = await owner.client.query(api.clients.directory, {
    businessId,
  })
  return sites.find((site) => site._id === propertyId)!.clientId
}

const newJobButton = (page: Page) =>
  page.getByRole('button', { name: 'New job' })

/** The schedule, hydrated, and New Job open on it. */
async function openNewJob(page: Page, slug: string, goto = true) {
  if (goto) await page.goto(`/${slug}/schedule`)
  await expect(newJobButton(page)).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(newJobButton(page), () =>
    expect(sheet.getByText('New job').first()).toBeVisible({ timeout: 2_000 }),
  )
  return sheet
}

/** The Property picker opened, and `query` typed into its search. */
async function searchProperty(page: Page, query: string) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Property' })
    .click()
  const picker = page.getByRole('dialog', { name: 'Property' })
  await picker
    .getByRole('textbox', { name: 'Search by name, address, phone or email' })
    .fill(query)
  return picker
}

test('the caller’s email finds her site, and the list ends with a new site for her', async ({
  page,
}) => {
  const s = await bookWithClients('match-email')
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug)

  // Typed as she spells it out, capitals and all.
  const picker = await searchProperty(page, 'Jane.Nguyen@Example.com')
  const jane = picker.getByRole('button', {
    name: /^Jane Nguyen — 12 Wattle St, Bayswater/,
  })
  await expect(jane).toBeVisible()
  await expect(
    picker.getByRole('button', { name: 'New site for Jane Nguyen' }),
  ).toBeVisible()
  // Her site is the first row: the rows a key finds come first.
  await expect(picker.locator('li').first().getByRole('button')).toContainText(
    'Jane Nguyen',
  )

  // A contact person's own mobile finds her agency.
  await picker
    .getByRole('textbox', { name: 'Search by name, address, phone or email' })
    .fill('+61 491 570 110')
  await expect(
    picker.getByRole('button', { name: /^Ray White Bayswater — / }),
  ).toBeVisible()

  await picker
    .getByRole('textbox', { name: 'Search by name, address, phone or email' })
    .fill(JANE_EMAIL)
  await jane.click()
  await expect(sheet.getByLabel('Property')).toContainText(
    'Jane Nguyen — 12 Wattle St, Bayswater',
  )
})

test('a number nobody has is the way in to a new client, with it in Phone', async ({
  page,
}) => {
  const s = await bookWithClients('match-unknown')
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug)

  const picker = await searchProperty(page, UNKNOWN)
  await expect(picker.getByText('No client or address matches.')).toBeVisible()
  const add = picker.getByRole('button', {
    name: `New client, phone “${UNKNOWN}”`,
  })
  await expect(add).toBeVisible()
  // With signal and the list live, nothing is said to be missing.
  await expect(
    picker.getByText('Newer clients show when you have signal.'),
  ).toHaveCount(0)

  await add.click()
  await expect(picker).toBeHidden()
  await expect(
    sheet.getByRole('radio', { name: 'New client', checked: true }),
  ).toBeVisible()
  const phone = sheet.getByLabel('Phone (optional)')
  await expect(phone).toHaveValue(UNKNOWN)
  await expect(phone).toBeFocused()
})

test('with no signal, the same search runs over the copy kept on the phone, and says newer clients show with signal', async ({
  page,
  context,
}) => {
  const s = await bookWithClients('match-offline')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(newJobButton(page)).toBeEnabled()
  await keepPageInWorker(page)
  // The client list on the phone, with Jane's email in it.
  await expect
    .poll(() => keptDirectory(page, s.businessId), { timeout: KEEP_TIMEOUT })
    .toContain(JANE_EMAIL)

  await page.clock.setSystemTime(Date.now() + PAGE_AGE_MS)
  await context.setOffline(true)
  try {
    // Opened afresh from the Home Screen.
    await page.goto('/')
    await expect(page).toHaveURL(new RegExp(`/${s.slug}/schedule`))
    const sheet = await openNewJob(page, s.slug, false)

    // The copy finds her by her email as the live list does.
    const picker = await searchProperty(page, JANE_EMAIL)
    await expect(
      picker.getByRole('button', {
        name: /^Jane Nguyen — 12 Wattle St, Bayswater/,
      }),
    ).toBeVisible()

    // A number it doesn't have: the way in, and why it may be missing.
    await picker
      .getByRole('textbox', { name: 'Search by name, address, phone or email' })
      .fill(UNKNOWN)
    const add = picker.getByRole('button', {
      name: `New client, phone “${UNKNOWN}”`,
    })
    await expect(add).toBeVisible()
    await expect(
      picker.getByText('Newer clients show when you have signal.'),
    ).toBeVisible()
    await add.click()
    await expect(picker).toBeHidden()
    await expect(sheet.getByLabel('Phone (optional)')).toHaveValue(UNKNOWN)
    await expect(
      sheet.getByText(
        'No signal — the booking goes when you have signal. Keep PestM8 open until then.',
      ),
    ).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})

test('the Clients page finds a client by their own mobile', async ({
  page,
}) => {
  const s = await bookWithClients('match-clients')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/clients`)
  await expect(page.getByRole('button', { name: 'New client' })).toBeEnabled()

  const cards = page
    .locator('main button')
    .filter({ hasText: /Jane Nguyen|Ray White Bayswater|Sam Wu/ })
  await expect(cards).toHaveCount(3)

  await page
    .getByLabel('Search clients by name, address, phone or email')
    .fill(JANE_MOBILE)
  await expect(page).toHaveURL(/[?&]q=0491/)
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Jane Nguyen')

  // And by their email.
  await page
    .getByLabel('Search clients by name, address, phone or email')
    .fill(JANE_EMAIL)
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Jane Nguyen')
})

test('a client with no site yet is found by name and number, and booked at a new site', async ({
  page,
}) => {
  const s = await bookWithClients('match-siteless')
  await signInViaUi(page, s.owner.email)
  const sheet = await openNewJob(page, s.slug)

  // His name finds no site either, and offers his new one, not a second
  // Sam Wu.
  const byName = await searchProperty(page, 'Sam Wu')
  await expect(
    byName.getByRole('button', { name: 'New site for Sam Wu' }),
  ).toBeVisible()
  await expect(
    byName.getByRole('button', { name: 'New client named “Sam Wu”' }),
  ).toHaveCount(0)
  await byName.getByRole('button', { name: 'Done' }).click()
  await expect(byName).toBeHidden()

  // Sam's number finds nobody's site, and offers his new one.
  const picker = await searchProperty(page, SAM_MOBILE)
  await expect(
    picker.getByRole('button', { name: `New client, phone “${SAM_MOBILE}”` }),
  ).toHaveCount(0)
  await picker.getByRole('button', { name: 'New site for Sam Wu' }).click()
  await expect(picker).toBeHidden()

  // Chosen in New site for, from the client list: he stays chosen.
  const siteFor = sheet.getByLabel('New site for')
  await expect(siteFor).toContainText('Sam Wu — No sites')
  await expect(siteFor).toBeFocused()
  await sheet
    .getByLabel('Street address', { exact: true })
    .fill('5 Abernethy Road')
  await sheet.getByLabel('Suburb', { exact: true }).fill('Belmont')
  await sheet.getByLabel('Postcode', { exact: true }).fill('6104')
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await expect(siteFor).toContainText('Sam Wu — No sites')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  // One Sam Wu, with the one new site, and the job on it.
  const { clients, sites } = await s.owner.client.query(api.clients.directory, {
    businessId: s.businessId,
  })
  expect(clients.filter((c) => c.name === 'Sam Wu')).toHaveLength(1)
  const his = sites.filter((site) => site.clientId === s.sam)
  expect(his.map((site) => site.addressLine)).toEqual(['5 Abernethy Road'])
})

test('with no site in the book, an existing client’s job is at a new site', async ({
  page,
}) => {
  // One client, whose only site was put in the Recycle bin.
  const owner = await signUpActor(
    uniqueEmail('match-nosites'),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `match-nosites ${Date.now()}`, state: 'WA', timezone: TZ },
  )
  const samSite = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Sam Wu',
    kind: 'person',
    phone: SAM_MOBILE,
    addressLine: '9 Banksia Rd',
    suburb: 'Morley',
    state: 'WA',
    postcode: '6062',
  })
  await owner.client.mutation(api.bin.deleteProperty, {
    businessId,
    propertyId: samSite,
  })
  await signInViaUi(page, owner.email)
  const sheet = await openNewJob(page, slug)

  // Nothing to choose, so it opens on New client, with the tabs there.
  await expect(
    sheet.getByRole('radio', { name: 'New client', checked: true }),
  ).toBeVisible()
  // Named "Client Client" by its Field label, so it is found by its text.
  await sheet.getByRole('radio').filter({ hasText: 'Existing client' }).click()
  // No empty Property picker: New site for, and no way back to a site.
  await expect(
    sheet
      .getByRole('radio', { checked: true })
      .filter({ hasText: 'Existing client' }),
  ).toBeVisible()
  await expect(sheet.getByLabel('New site for')).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Property' })).toHaveCount(0)
  await expect(
    sheet.getByRole('button', { name: 'Choose an existing site instead' }),
  ).toHaveCount(0)
})

// ── The copy kept on the phone (as keptCopy.spec.ts reads it) ─────────────

/**
 * Lets the service worker take this page over, then loads it through the
 * worker once, so the page is in its cache (licences.spec.ts says why it is
 * reloaded until then).
 */
async function keepPageInWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await expect(async () => {
    await page.reload()
    await expect(newJobButton(page)).toBeEnabled()
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller !== null),
    ).toBe(true)
  }).toPass({ timeout: 60_000 })
}

/**
 * The client list the phone keeps for `businessId`, as JSON: '' until it is
 * written. Read straight from IndexedDB; never throws, so it can be polled.
 */
async function keptDirectory(
  page: Page,
  businessId: Id<'businesses'>,
): Promise<string> {
  return page
    .evaluate(async (business: string): Promise<string> => {
      const names = await indexedDB.databases()
      if (!names.some((db) => db.name === 'pestm8-offline')) return ''
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('pestm8-offline')
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error ?? new Error('not opened'))
      })
      try {
        if (!db.objectStoreNames.contains('rows')) return ''
        const rows = await new Promise<
          Array<{ fn: string; businessId: string; data: unknown }>
        >((resolve, reject) => {
          const request = db
            .transaction('rows', 'readonly')
            .objectStore('rows')
            .getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error ?? new Error('not read'))
        })
        const row = rows.find(
          (each) =>
            each.fn === 'clients:directory' && each.businessId === business,
        )
        return row ? JSON.stringify(row.data) : ''
      } finally {
        db.close()
      }
    }, businessId)
    .catch(() => '')
}
