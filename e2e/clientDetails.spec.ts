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
import { PHOTON } from '../src/lib/addressLookup.fixtures'
import type { Page } from '@playwright/test'

/** `LOOKUP_UNDER_AUTOMATION_KEY` in src/lib/addressLookup.ts — spelled out
 * here because that module's own imports go through the app's `#/` alias. */
const LOOKUP_UNDER_AUTOMATION_KEY = 'pestm8:address-lookup'

/**
 * Prompts 6.1–6.3: a business client's ABN and contact person, street
 * addresses suggested as they are typed, and a business's sites each with
 * their own contact — the one a visit's Call reaches.
 */

const DAY = 24 * 60 * 60 * 1000

function perthDayKey(ts: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

async function ownerWithBusiness(label: string) {
  const owner = await signUpActor(uniqueEmail(label), FIXTURE_PASSWORD, 'Sujan')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )
  return { owner, businessId, slug }
}

async function openNewClientSheet(page: Page, slug: string) {
  await page.goto(`/${slug}/clients`)
  const add = page.getByRole('button', { name: 'New client' })
  await expect(add).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(add, () =>
    expect(sheet.getByText('New client')).toBeVisible({ timeout: 2_000 }),
  )
  return sheet
}

test('a business client has an ABN and a contact person; a person client is never asked', async ({
  page,
}) => {
  const { owner, businessId, slug } = await ownerWithBusiness('client-abn')
  await signInViaUi(page, owner.email)
  const sheet = await openNewClientSheet(page, slug)

  // A person: neither question.
  await expect(sheet.getByLabel('Client name')).toBeVisible()
  await expect(sheet.getByLabel('ABN (optional)')).toHaveCount(0)
  await expect(sheet.getByLabel('Contact person (optional)')).toHaveCount(0)

  await sheet.getByRole('tab', { name: 'Business' }).click()
  await sheet.getByLabel('Business name').fill('Mahal Mart')
  // One digit off the ATO's own ABN: eleven digits, and still wrong.
  await sheet.getByLabel('ABN (optional)').fill('51 824 753 557')
  await sheet.getByLabel('Contact person (optional)').fill('Jan Morris')
  await sheet.getByLabel('Street address').fill('14 Kewdale Road')
  await sheet.getByLabel('Suburb').fill('Kewdale')
  await sheet.getByLabel('Postcode').fill('6105')
  await sheet.getByLabel('Main phone (optional)').fill('08 9000 1111')

  await sheet.getByRole('button', { name: 'Save client' }).click()
  // Refused in the form, before anything is sent.
  await expect(
    sheet.getByText(
      'Check the ABN: it should be 11 digits and pass the ATO check.',
    ),
  ).toBeVisible()
  await expect(sheet).toBeVisible()

  await sheet.getByLabel('ABN (optional)').fill('51 824 753 556')
  await sheet.getByRole('button', { name: 'Save client' }).click()
  await expect(sheet).toBeHidden()

  const card = page.getByRole('button', { name: /Mahal Mart/ })
  await expect(card).toBeVisible()
  const detail = page.getByRole('dialog')
  await clickUntil(card, () =>
    expect(detail.getByText('Contact person: Jan Morris')).toBeVisible({
      timeout: 2_000,
    }),
  )
  await expect(detail.getByText('ABN 51 824 753 556')).toBeVisible()

  // Stored as its digits, the contact person as the primary contact.
  const clients = await owner.client.query(api.clients.list, { businessId })
  const mahal = clients.find((c) => c.name === 'Mahal Mart')!
  expect(mahal.abn).toBe('51824753556')
  const contacts = await owner.client.query(api.clientContacts.list, {
    businessId,
    clientId: mahal._id,
  })
  expect(contacts).toEqual([
    expect.objectContaining({ name: 'Jan Morris', isPrimary: true }),
  ])
})

test.describe('the street address lookup', () => {
  // Requests answered by `page.route` must not be taken by the service worker
  // first (Playwright's own advice for request interception).
  test.use({ serviceWorkers: 'block' })

  test('suggests the street as it is typed, and a pick fills the suburb, state and postcode', async ({
    page,
  }) => {
    const { owner, slug } = await ownerWithBusiness('client-lookup')
    // Off under automation unless a spec opts in, so the rest of the suite
    // never reaches the real service. This one opts in and answers it.
    await page.addInitScript((key) => {
      localStorage.setItem(key, 'on')
    }, LOOKUP_UNDER_AUTOMATION_KEY)
    const asked: Array<string> = []
    await page.route('https://photon.komoot.io/api/**', async (route) => {
      asked.push(new URL(route.request().url()).searchParams.get('q') ?? '')
      await route.fulfill({ json: PHOTON.walcottStMtLawley.json })
    })

    await signInViaUi(page, owner.email)
    const sheet = await openNewClientSheet(page, slug)
    await sheet.getByLabel('Client name').fill('R. Patel')

    const street = sheet.getByLabel('Street address')
    await street.pressSequentially('12 Walcott St Mt Lawley', { delay: 20 })
    const suggestion = sheet.getByRole('option', {
      name: /12 Walcott Street.*Mount Lawley/,
    })
    await expect(suggestion).toBeVisible()
    await expect(
      sheet.getByRole('link', { name: /OpenStreetMap contributors/ }),
    ).toBeVisible()
    // The house number is kept back: Photon matches streets, and a number
    // sent with an abbreviation finds nothing.
    expect(asked.at(-1)).not.toMatch(/^12\b/)

    await suggestion.click()
    await expect(street).toHaveValue('12 Walcott Street')
    await expect(sheet.getByLabel('Suburb')).toHaveValue('Mount Lawley')
    await expect(sheet.getByLabel('Postcode')).toHaveValue('6050')
    await expect(sheet.getByLabel('State')).toHaveValue('WA')
  })

  test('a postcode from another state is pointed out, never forced', async ({
    page,
  }) => {
    const { owner, slug } = await ownerWithBusiness('client-postcode')
    await signInViaUi(page, owner.email)
    const sheet = await openNewClientSheet(page, slug)

    // Prod has a Darwin property saved as WA.
    await sheet.getByLabel('Client name').fill('K. Wong')
    await sheet.getByLabel('Street address').fill('12 East Point Road')
    await sheet.getByLabel('Suburb').fill('Fannie Bay')
    await sheet.getByLabel('Postcode').fill('0820')
    await expect(sheet.getByText('0820 is an NT postcode.')).toBeVisible()
    await sheet.getByRole('button', { name: 'Use NT' }).click()
    await expect(sheet.getByLabel('State')).toHaveValue('NT')
    await expect(sheet.getByText('0820 is an NT postcode.')).toHaveCount(0)
  })
})

test('a business site’s own contact is who the card calls; head office keeps its email', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('site-contact')
  const propertyId = await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'Mahal Mart',
    kind: 'business',
    phone: '08 9000 1111',
    email: 'accounts@mahal.test',
    addressLine: '14 Kewdale Road',
    suburb: 'Kewdale',
    state: 'WA',
    postcode: '6105',
    siteContactName: 'Jan Morris',
    siteContactPhone: '0412 000 111',
  })
  const at = Date.now() + DAY
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'Cockroach Treatment',
    price: 22000,
    scheduledAt: at,
    durationMinutes: 60,
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${perthDayKey(at)}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  const card = page.getByRole('button', { name: /Cockroach Treatment/ })
  await expect(card).toBeVisible()
  // The heading is still the business; the Call is the site's.
  await expect(card).toContainText('Mahal Mart')
  await expect(
    page.getByRole('button', { name: 'Call Jan Morris' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Text Jan Morris' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Email Mahal Mart' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Call Mahal Mart' }),
  ).toHaveCount(0)

  // The job sheet shows both, the site first.
  const detail = page.getByRole('dialog')
  await clickUntil(card, () =>
    expect(detail.getByText('Site contact', { exact: true })).toBeVisible({
      timeout: 2_000,
    }),
  )
  await expect(detail.getByText('Head office', { exact: true })).toBeVisible()
  await expect(
    detail.getByRole('button', { name: 'Call Jan Morris' }),
  ).toBeVisible()
  await expect(
    detail.getByRole('button', { name: 'Call Mahal Mart' }),
  ).toBeVisible()
  await detail.getByRole('button', { name: 'Close' }).click()
  await expect(detail).toBeHidden()

  // Switched to a person, the client keeps its site contact but nobody dials
  // it: the Call is the client's own line again.
  const property = await s.owner.client.query(api.properties.get, {
    businessId: s.businessId,
    propertyId,
  })
  await s.owner.client.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId: property!.clientId,
    kind: 'person',
  })
  await expect(
    page.getByRole('button', { name: 'Call Mahal Mart' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Call Jan Morris' }),
  ).toHaveCount(0)
})

test('a new site for an existing business is booked from New Job, without a second client', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('new-site')
  await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'Mahal Mart',
    kind: 'business',
    phone: '08 9000 1111',
    addressLine: '14 Kewdale Road',
    suburb: 'Kewdale',
    state: 'WA',
    postcode: '6105',
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(newJob, () =>
    expect(sheet.getByText('New job')).toBeVisible({ timeout: 2_000 }),
  )

  await sheet
    .getByRole('button', { name: '+ New site for an existing client' })
    .click()
  await sheet.getByLabel('Street address').fill('5 Abernethy Road')
  await sheet.getByLabel('Suburb').fill('Belmont')
  await sheet.getByLabel('Postcode').fill('6104')

  // Whose site it is has to be said.
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(
    sheet.getByText('Choose the client this site belongs to.'),
  ).toBeVisible()

  await sheet.getByLabel('New site for').click()
  await page
    .getByRole('textbox', { name: 'Search by name, phone or suburb' })
    .fill('Mahal')
  await page.getByRole('button', { name: /^Mahal Mart/ }).click()
  await sheet.getByLabel('Site contact name').fill('Priya Shah')
  await sheet.getByLabel('Site contact number').fill('0400 222 333')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()
  // On the card: the day's weather line names the suburb too, once the
  // forecast is in.
  await expect(
    page.getByRole('button', { name: /Mahal Mart\s+Belmont/ }),
  ).toBeVisible()

  // One Mahal Mart, now with two sites, the new one carrying its contact.
  const clients = await s.owner.client.query(api.clients.list, {
    businessId: s.businessId,
  })
  const mahals = clients.filter((c) => c.name === 'Mahal Mart')
  expect(mahals).toHaveLength(1)
  const sites = await s.owner.client.query(api.properties.listByClient, {
    businessId: s.businessId,
    clientId: mahals[0]._id,
  })
  expect(sites.map((p) => p.suburb).sort()).toEqual(['Belmont', 'Kewdale'])
  expect(sites.find((p) => p.suburb === 'Belmont')).toMatchObject({
    addressLine: '5 Abernethy Road',
    siteContactName: 'Priya Shah',
    siteContactPhone: '0400 222 333',
  })
})
