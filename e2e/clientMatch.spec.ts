import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseJobTypes,
  clickUntil,
  inviteAndJoin,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Locator, Page } from '@playwright/test'
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
 * Part 2, match lines and the check at Book (M3): typed in as a new client,
 * the caller is said to be one already as focus moves on from Phone, and
 * again at Book, with the fix that books it on them and keeps what they
 * said, a site chosen after Show them too; a shared number stops nothing;
 * the business's and the team's own numbers say nothing; Clients → New
 * client opens the client instead; and a double tap on Book books nothing,
 * nor a tap the moment the panel is drawn.
 *
 * Numbers are from ACMA's ranges for fiction: 0491 570 156 is nobody's.
 * On a phone's screen, as the pickers are used.
 */

const TZ = 'Australia/Perth'

/**
 * What Book job says with no signal (NewJobSheet.tsx `bookingCaption`): kept
 * on the phone in a build with the outbox switched on
 * (`VITE_PESTM8_OUTBOX=on`, served through `E2E_BASE_URL`), and as it always
 * said in Playwright's own build, which has no flag until the outbox is
 * switched on for good.
 */
const BOOKING_NO_SIGNAL =
  process.env.VITE_PESTM8_OUTBOX === 'on'
    ? 'No signal — the booking is kept on this phone and goes when PestM8 is open with signal.'
    : 'No signal — the booking goes when you have signal. Keep PestM8 open until then.'

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
    await expect(sheet.getByText(BOOKING_NO_SIGNAL)).toBeVisible()
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
  await sheet.getByRole('radio', { name: 'Existing client' }).click()
  // No empty Property picker: New site for, and no way back to a site.
  await expect(
    sheet.getByRole('radio', { name: 'Existing client', checked: true }),
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

// ── Part 2: match lines and the check at Book (the matching plan's M3) ────

const P2_JANE_MOBILE = '0491 570 161'
const P2_JANE_EMAIL = 'jane.nguyen.p2@example.com'
/** Ray White Bayswater's office line, on one of its owners too. */
const P2_OFFICE = '08 7010 1234'
const P2_SARAH = '0491 570 111'
const P2_TOM_LEE = '0491 570 110'
/** Jane's husband's own mobile: nobody's in the book. */
const P2_TOM_NGUYEN = '0491 570 737'
const P2_BUSINESS_PHONE = '08 7010 9000'
const P2_OWNER_PHONE = '0491 570 006'
const P2_TEAM_PHONE = '0491 570 007'

/**
 * The plan's `seedMatching`, as much of it as these need: Jane Nguyen with
 * her own mobile and email at 12 Wattle St; Ray White Bayswater, a business
 * at 1 King William St with Sarah Lee as its property manager, whose office
 * line one of its owners, Ann Bell, carries too; and the business's own
 * number and a team member's mobile each on a client an office saved with
 * them. The business's number, the owner's and the team member's are their
 * own, set as Settings does.
 */
async function seedMatching(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const member = await signUpActor(
    uniqueEmail(`${label}-team`),
    FIXTURE_PASSWORD,
    'Kevin',
  )
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `${label} ${Date.now()}`, state: 'WA', timezone: TZ },
  )
  await owner.client.mutation(api.businesses.update, {
    businessId,
    phone: P2_BUSINESS_PHONE,
  })
  await inviteAndJoin(owner, member, businessId)
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const ownerMembership = members.find((m) => m.role === 'owner')!._id
  const memberMembership = members.find((m) => m.email === member.email)!._id
  await owner.client.mutation(api.memberships.setProfile, {
    businessId,
    membershipId: ownerMembership,
    phone: P2_OWNER_PHONE,
  })
  await member.client.mutation(api.memberships.setProfile, {
    businessId,
    membershipId: memberMembership,
    phone: P2_TEAM_PHONE,
  })

  const janeSite = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Jane Nguyen',
    kind: 'person',
    phone: P2_JANE_MOBILE,
    email: P2_JANE_EMAIL,
    addressLine: '12 Wattle St',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const agencySite = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Ray White Bayswater',
    kind: 'business',
    phone: P2_OFFICE,
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
    phone: P2_SARAH,
  })
  await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Ann Bell',
    kind: 'person',
    phone: P2_OFFICE,
    addressLine: '5 Elm St',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Office Copy',
    kind: 'person',
    phone: P2_BUSINESS_PHONE,
    addressLine: '2 Elm St',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'Arthur Wellard',
    kind: 'person',
    phone: P2_TEAM_PHONE,
    addressLine: '3 Elm St',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const jane = await clientOfSite(owner, businessId, janeSite)
  return { owner, businessId, slug, jane, janeSite, agency, agencySite }
}

function perthToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
}

/** The book as the server has it now. */
async function bookOf(owner: Actor, businessId: Id<'businesses'>) {
  return owner.client.query(api.clients.directory, { businessId })
}

/** Today's jobs, as the Schedule lists them. */
async function todaysJobs(owner: Actor, businessId: Id<'businesses'>) {
  return owner.client.query(api.jobs.listDay, {
    businessId,
    dayKey: perthToday(),
  })
}

/** New Job's New client tab, filled in as a caller gives it: by label. */
async function typeCaller(
  sheet: Locator,
  caller: {
    name: string
    phone?: string
    email?: string
    street?: string
    suburb?: string
    postcode?: string
  },
) {
  await sheet.getByRole('radio', { name: 'New client', exact: true }).click()
  await sheet.getByLabel('Client name', { exact: true }).fill(caller.name)
  if (caller.phone) {
    await sheet
      .getByLabel('Phone (optional)', { exact: true })
      .fill(caller.phone)
  }
  if (caller.email) {
    await sheet
      .getByLabel('Email (optional)', { exact: true })
      .fill(caller.email)
  }
  if (caller.street) await typeAddress(sheet, caller)
}

async function typeAddress(
  sheet: Locator,
  at: { street?: string; suburb?: string; postcode?: string },
) {
  await sheet
    .getByLabel('Street address', { exact: true })
    .fill(at.street ?? '')
  await sheet.getByLabel('Suburb', { exact: true }).fill(at.suburb ?? '')
  await sheet.getByLabel('Postcode', { exact: true }).fill(at.postcode ?? '')
}

/** Phone left for Email, as a person moves on to the next field. */
async function leavePhone(sheet: Locator) {
  await sheet.getByLabel('Email (optional)', { exact: true }).focus()
}

/** The panel above Book, by its heading. */
const panelOf = (sheet: Locator) =>
  sheet.getByRole('region', { name: /to check before saving/ })

test.describe('part 2: match lines and the check at Book', () => {
  test('her name and mobile at a new address: the line under Phone, then Use at Book makes one new site on her', async ({
    page,
  }) => {
    const s = await seedMatching('match-use')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    const sheet = await openNewJob(page, s.slug)

    await typeCaller(sheet, { name: 'Jane Nguyen', phone: P2_JANE_MOBILE })
    // Name was left for Phone before any address: choose her site.
    await expect(
      sheet.getByText('Jane Nguyen, of Bayswater, is already a client.'),
    ).toBeVisible()
    await expect(
      sheet.getByRole('button', { name: 'Choose Jane Nguyen’s site' }),
    ).toBeVisible()
    await leavePhone(sheet)
    await expect(
      sheet.getByText('Jane Nguyen, of Bayswater, has this mobile.'),
    ).toBeVisible()
    await expect(
      sheet.getByRole('button', { name: 'Book at 12 Wattle St' }),
    ).toBeVisible()

    await typeAddress(sheet, {
      street: '40 Coode St',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    const panel = panelOf(sheet)
    await expect(panel).toContainText(
      'Already a client: Jane Nguyen, of Bayswater, has the same name and mobile.',
    )
    await expect(panel).toContainText(
      'Use it, or press Book anyway to add a new client.',
    )
    await panel.getByRole('button', { name: 'Use Jane Nguyen' }).click()

    // New site for Jane, the address she gave carried over, and focus on
    // the field the fix filled.
    await expect(sheet.getByLabel('New site for')).toContainText('Jane Nguyen')
    await expect(sheet.getByLabel('New site for')).toBeFocused()
    await expect(
      sheet.getByLabel('Street address', { exact: true }),
    ).toHaveValue('40 Coode St')
    await expect(panelOf(sheet)).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Book job' }).click()
    await expect(sheet).toBeHidden()

    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length)
    const hers = after.sites.filter((site) => site.clientId === s.jane)
    expect(hers.map((site) => site.addressLine).sort()).toEqual([
      '12 Wattle St',
      '40 Coode St',
    ])
    const jobs = await todaysJobs(s.owner, s.businessId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].clientName).toBe('Jane Nguyen')
    expect(jobs[0].addressLine).toBe('40 Coode St')
  })

  test('the agency’s office line with a new owner: the line under Phone only, and Book books on the first press', async ({
    page,
  }) => {
    const s = await seedMatching('match-shared')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    const sheet = await openNewJob(page, s.slug)

    await typeCaller(sheet, { name: 'Kim Pham', phone: P2_OFFICE })
    await leavePhone(sheet)
    await expect(
      sheet.getByText(
        '08 7010 1234 is on 2 clients — Ray White Bayswater and 1 other.',
      ),
    ).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Show them' })).toBeVisible()
    await expect(
      sheet.getByRole('button', { name: 'New site for Ray White Bayswater' }),
    ).toBeVisible()

    await typeAddress(sheet, {
      street: '9 Banksia Rd',
      suburb: 'Morley',
      postcode: '6062',
    })
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    await expect(sheet).toBeHidden()

    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length + 1)
    expect(after.clients.filter((c) => c.name === 'Kim Pham')).toHaveLength(1)
    const jobs = await todaysJobs(s.owner, s.businessId)
    expect(jobs.map((job) => job.clientName)).toEqual(['Kim Pham'])
  })

  test('a new owner and his mobile at the agency’s site: Already a site, booked on the agency with the caller in Notes', async ({
    page,
  }) => {
    const s = await seedMatching('match-site')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    const sheet = await openNewJob(page, s.slug)

    await typeCaller(sheet, {
      name: 'Tom Lee',
      phone: P2_TOM_LEE,
      street: '1 King William St',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    const panel = panelOf(sheet)
    await expect(panel).toContainText(
      'Already a site: 1 King William St, Bayswater is Ray White Bayswater’s. Same address, different name.',
    )
    await panel
      .getByRole('button', { name: 'Book on Ray White Bayswater' })
      .click()

    await expect(sheet.getByLabel('Property')).toContainText(
      'Ray White Bayswater — 1 King William St, Bayswater',
    )
    await expect(
      sheet.getByLabel('Note for this visit (optional)'),
    ).toHaveValue(`Caller: Tom Lee, ${P2_TOM_LEE}`)
    await sheet.getByRole('button', { name: 'Book job' }).click()
    await expect(sheet).toBeHidden()

    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length)
    expect(after.sites).toHaveLength(before.sites.length)
    const jobs = await todaysJobs(s.owner, s.businessId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].propertyId).toBe(s.agencySite)
    expect(jobs[0].notePreview).toContain(`Caller: Tom Lee, ${P2_TOM_LEE}`)
  })

  test('her husband with her email: Show them, her site chosen there, and his name and number go in Notes', async ({
    page,
  }) => {
    const s = await seedMatching('match-show')
    await signInViaUi(page, s.owner.email)
    const sheet = await openNewJob(page, s.slug)

    await typeCaller(sheet, {
      name: 'Tom Nguyen',
      phone: P2_TOM_NGUYEN,
      email: P2_JANE_EMAIL,
      street: '40 Coode St',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    const panel = panelOf(sheet)
    await expect(panel).toContainText(
      `Same email: ${P2_JANE_EMAIL} is Jane Nguyen’s, of Bayswater. Same email, different name.`,
    )
    // No row that books on her: the foot doesn't say to use one.
    await expect(panel).toContainText(
      'Check who it is, or press Book anyway to add a new client.',
    )
    await panel.getByRole('button', { name: 'Show them' }).click()

    // The Property picker, her email typed: her site chosen there is taken
    // as Book at would take it, with who rang.
    const picker = page.getByRole('dialog', { name: 'Property' })
    await picker
      .getByRole('button', { name: /^Jane Nguyen — 12 Wattle St, Bayswater/ })
      .click()
    await expect(sheet.getByLabel('Property')).toContainText(
      'Jane Nguyen — 12 Wattle St, Bayswater',
    )
    const notes = sheet.getByLabel('Note for this visit (optional)')
    await expect(notes).toHaveValue(`Caller: Tom Nguyen, ${P2_TOM_NGUYEN}`)

    // Back to the New client tab, the booking is his own again: the line
    // goes, and he is as typed.
    await sheet.getByRole('radio', { name: 'New client', exact: true }).click()
    await expect(notes).toHaveValue('')
    await expect(sheet.getByLabel('Client name', { exact: true })).toHaveValue(
      'Tom Nguyen',
    )
  })

  test('her name left before any address: Choose Jane Nguyen’s site books at her own site, never a second 12 Wattle St', async ({
    page,
  }) => {
    const s = await seedMatching('match-name')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    const sheet = await openNewJob(page, s.slug)

    await typeCaller(sheet, { name: 'Jane Nguyen' })
    // Name left for Phone, as the form's order goes.
    await sheet.getByLabel('Phone (optional)', { exact: true }).focus()
    await expect(
      sheet.getByText('Jane Nguyen, of Bayswater, is already a client.'),
    ).toBeVisible()
    const choose = sheet.getByRole('button', {
      name: 'Choose Jane Nguyen’s site',
    })
    // Held for the moment it comes in, then taken.
    await expect(choose).toBeEnabled()
    await choose.click()

    // The Property picker with her name: her site, and a new one for her at
    // the end, never "New client".
    const picker = page.getByRole('dialog', { name: 'Property' })
    await expect(
      picker.getByRole('button', { name: 'New site for Jane Nguyen' }),
    ).toBeVisible()
    await picker
      .getByRole('button', { name: /^Jane Nguyen — 12 Wattle St, Bayswater/ })
      .click()
    await expect(picker).toBeHidden()
    await expect(sheet.getByLabel('Property')).toContainText(
      'Jane Nguyen — 12 Wattle St, Bayswater',
    )
    // Nothing the caller said differs from hers: Notes are left alone.
    await expect(
      sheet.getByLabel('Note for this visit (optional)'),
    ).toHaveValue('')
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    await expect(sheet).toBeHidden()

    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length)
    expect(after.sites).toHaveLength(before.sites.length)
    const jobs = await todaysJobs(s.owner, s.businessId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].propertyId).toBe(s.janeSite)
  })

  test('a Show them’s picker shut with nothing chosen: a client chosen later by hand keeps the address typed for them', async ({
    page,
  }) => {
    const s = await seedMatching('match-show-closed')
    await signInViaUi(page, s.owner.email)
    const sheet = await openNewJob(page, s.slug)

    await typeCaller(sheet, {
      name: 'Tom Nguyen',
      phone: P2_TOM_NGUYEN,
      email: P2_JANE_EMAIL,
      street: '40 Coode St',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    await panelOf(sheet).getByRole('button', { name: 'Show them' }).click()
    const picker = page.getByRole('dialog', { name: 'Property' })
    await picker.getByRole('button', { name: 'Done' }).click()
    await expect(picker).toBeHidden()

    // By hand now: a new site for Jane at another address.
    await sheet
      .getByRole('button', { name: 'New site for an existing client' })
      .click()
    await typeAddress(sheet, {
      street: '5 Abernethy Rd',
      suburb: 'Belmont',
      postcode: '6104',
    })
    await sheet.getByLabel('New site for').click()
    const clients = page.getByRole('dialog', { name: 'Client' })
    await clients
      .getByRole('textbox', { name: 'Search by name, phone, email or suburb' })
      .fill('Jane Nguyen')
    await clients
      .getByRole('button', { name: /^Jane Nguyen/ })
      .first()
      .click()
    await expect(clients).toBeHidden()

    // What was typed there stays, and the New client tab's caller isn't
    // put in Notes: the choice was the person's, not the fix's.
    await expect(sheet.getByLabel('New site for')).toContainText('Jane Nguyen')
    await expect(
      sheet.getByLabel('Street address', { exact: true }),
    ).toHaveValue('5 Abernethy Rd')
    await expect(sheet.getByLabel('Suburb', { exact: true })).toHaveValue(
      'Belmont',
    )
    await expect(
      sheet.getByLabel('Note for this visit (optional)'),
    ).toHaveValue('')
  })

  test('with no signal, the same from the copy kept on the phone, saying when it was last right', async ({
    page,
    context,
  }) => {
    const s = await seedMatching('match-offline-book')
    await signInViaUi(page, s.owner.email)
    await page.goto(`/${s.slug}/schedule`)
    await expect(newJobButton(page)).toBeEnabled()
    await keepPageInWorker(page)
    await expect
      .poll(() => keptDirectory(page, s.businessId), { timeout: KEEP_TIMEOUT })
      .toContain(P2_JANE_EMAIL)

    await page.clock.setSystemTime(Date.now() + PAGE_AGE_MS)
    await context.setOffline(true)
    try {
      await page.goto('/')
      await expect(page).toHaveURL(new RegExp(`/${s.slug}/schedule`))
      const sheet = await openNewJob(page, s.slug, false)

      await typeCaller(sheet, { name: 'Jane Nguyen', phone: P2_JANE_MOBILE })
      await leavePhone(sheet)
      await expect(
        sheet.getByText('Jane Nguyen, of Bayswater, has this mobile.'),
      ).toBeVisible()
      await typeAddress(sheet, {
        street: '40 Coode St',
        suburb: 'Bayswater',
        postcode: '6053',
      })
      await chooseJobTypes(page, sheet, ['General Pest Control'])
      await sheet.getByRole('button', { name: 'Book job' }).click()
      const panel = panelOf(sheet)
      await expect(panel).toContainText(
        'Jane Nguyen, of Bayswater, has the same name and mobile.',
      )
      await expect(panel).toContainText(
        /From the clients on this phone, updated \S/,
      )
      await panel.getByRole('button', { name: 'Use Jane Nguyen' }).click()
      await expect(sheet.getByLabel('New site for')).toContainText(
        'Jane Nguyen',
      )
      await expect(
        sheet.getByLabel('Street address', { exact: true }),
      ).toHaveValue('40 Coode St')
    } finally {
      await context.setOffline(false)
    }
  })

  test('the business’s own number and a team member’s mobile say nothing, and Book books on the first press', async ({
    page,
  }) => {
    const s = await seedMatching('match-ours')
    await signInViaUi(page, s.owner.email)

    // Each at an address of their own: the first booked is a site by the
    // second's turn, and the same address under another name is a row.
    for (const [name, phone, street] of [
      ['Kim Pham', P2_BUSINESS_PHONE, '9 Banksia Rd'],
      ['Lena Ford', P2_TEAM_PHONE, '11 Banksia Rd'],
    ] as const) {
      const sheet = await openNewJob(page, s.slug)
      await typeCaller(sheet, { name, phone })
      await leavePhone(sheet)
      await typeAddress(sheet, { street, suburb: 'Morley', postcode: '6062' })
      // No line under Phone: nobody else is said to have it.
      await expect(sheet.getByText('Office Copy')).toHaveCount(0)
      await expect(sheet.getByText('Arthur Wellard')).toHaveCount(0)
      await chooseJobTypes(page, sheet, ['General Pest Control'])
      await sheet.getByRole('button', { name: 'Book job' }).click()
      await expect(sheet).toBeHidden()
    }

    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients.map((c) => c.name)).toEqual(
      expect.arrayContaining(['Kim Pham', 'Lena Ford']),
    )
  })

  test('Clients → New client at a new address of hers: Open Jane Nguyen opens Add property with the address', async ({
    page,
  }) => {
    const s = await seedMatching('match-open')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    await page.goto(`/${s.slug}/clients`)
    const add = page.getByRole('button', { name: 'New client' })
    await expect(add).toBeEnabled()
    const sheet = page.getByRole('dialog')
    await clickUntil(add, () =>
      expect(sheet.getByText('New client').first()).toBeVisible({
        timeout: 2_000,
      }),
    )

    await sheet.getByLabel('Client name', { exact: true }).fill('Jane Nguyen')
    await sheet
      .getByLabel('Phone (optional)', { exact: true })
      .fill(P2_JANE_MOBILE)
    // Left within moments of the sheet opening, perhaps before its client
    // list is read: the line comes once it is.
    await leavePhone(sheet)
    await expect(
      sheet.getByText('Jane Nguyen, of Bayswater, has this mobile.'),
    ).toBeVisible()
    await typeAddress(sheet, {
      street: '40 Coode St',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    await sheet.getByRole('button', { name: 'Save client' }).click()
    const panel = panelOf(sheet)
    await expect(panel).toContainText(
      'Jane Nguyen, of Bayswater, has the same name and mobile.',
    )
    await panel.getByRole('button', { name: 'Open Jane Nguyen' }).click()

    // Her sheet, on Details, with Add property holding the address: the
    // New client sheet may still be sliding away behind it.
    const hers = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: 'Jane Nguyen' }) })
    await expect(hers).toBeVisible()
    await expect(
      hers.getByLabel('Street address', { exact: true }),
    ).toHaveValue('40 Coode St')
    await expect(
      hers.getByRole('button', { name: 'Add property' }),
    ).toBeVisible()
    // At the foot of Details, under her details and sites: brought into
    // view as the sheet stops, not left below the fold.
    await expect(
      hers.getByLabel('Street address', { exact: true }),
    ).toBeInViewport()
    // Nothing was made meanwhile.
    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length)
  })

  test('Clients → New client, her name left before any address: Open Jane Nguyen opens her sheet as it is, with no empty Add property', async ({
    page,
  }) => {
    const s = await seedMatching('match-open-name')
    await signInViaUi(page, s.owner.email)
    await page.goto(`/${s.slug}/clients`)
    const add = page.getByRole('button', { name: 'New client' })
    await expect(add).toBeEnabled()
    const sheet = page.getByRole('dialog')
    await clickUntil(add, () =>
      expect(sheet.getByText('New client').first()).toBeVisible({
        timeout: 2_000,
      }),
    )

    await sheet.getByLabel('Client name', { exact: true }).fill('Jane Nguyen')
    await sheet.getByLabel('Phone (optional)', { exact: true }).focus()
    await expect(
      sheet.getByText('Jane Nguyen, of Bayswater, is already a client.'),
    ).toBeVisible()
    const open = sheet.getByRole('button', { name: 'Open Jane Nguyen' })
    await expect(open).toBeEnabled()
    await open.click()

    // Her sheet, on Details, her site listed and nothing being added.
    const hers = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: 'Jane Nguyen' }) })
    await expect(hers).toBeVisible()
    await expect(hers.getByText('12 Wattle St').first()).toBeVisible()
    await expect(
      hers.getByRole('button', { name: 'Add another property' }),
    ).toBeVisible()
    await expect(
      hers.getByLabel('Street address', { exact: true }),
    ).toHaveCount(0)
  })

  test('Clients → New client, her mobile under another name: Open Jane Nguyen opens her sheet as it is, and New client keeps what was typed', async ({
    page,
  }) => {
    const s = await seedMatching('match-open-other')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    await page.goto(`/${s.slug}/clients`)
    const add = page.getByRole('button', { name: 'New client' })
    await expect(add).toBeEnabled()
    const sheet = page.getByRole('dialog')
    await clickUntil(add, () =>
      expect(sheet.getByText('New client').first()).toBeVisible({
        timeout: 2_000,
      }),
    )

    // Her husband, on her mobile, at an address of his own.
    await sheet.getByLabel('Client name', { exact: true }).fill('Tom Nguyen')
    await sheet
      .getByLabel('Phone (optional)', { exact: true })
      .fill(P2_JANE_MOBILE)
    await leavePhone(sheet)
    await typeAddress(sheet, {
      street: '4 Birch St',
      suburb: 'Morley',
      postcode: '6062',
    })
    await sheet.getByRole('button', { name: 'Save client' }).click()
    const panel = panelOf(sheet)
    await expect(panel).toContainText('Same mobile, different name.')
    await panel.getByRole('button', { name: 'Open Jane Nguyen' }).click()

    // Her sheet, on Details as it is: nothing of his put in Add property.
    const hers = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: 'Jane Nguyen' }) })
    await expect(hers).toBeVisible()
    await expect(hers.getByText('12 Wattle St').first()).toBeVisible()
    await expect(
      hers.getByLabel('Street address', { exact: true }),
    ).toHaveCount(0)
    await hers.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(hers).toBeHidden()

    // He is someone else: New client again, as he was typed, and saying
    // so.
    await clickUntil(add, () =>
      expect(sheet.getByText('New client').first()).toBeVisible({
        timeout: 2_000,
      }),
    )
    await expect(
      sheet.getByText('Still filled in from before you opened Jane Nguyen.'),
    ).toBeVisible()
    await expect(sheet.getByLabel('Client name', { exact: true })).toHaveValue(
      'Tom Nguyen',
    )
    await expect(
      sheet.getByLabel('Phone (optional)', { exact: true }),
    ).toHaveValue(P2_JANE_MOBILE)
    await expect(
      sheet.getByLabel('Street address', { exact: true }),
    ).toHaveValue('4 Birch St')
    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length)
  })

  test('Clients → New client with no signal: Open Jane Nguyen keeps the new address in New client, as her kept sheet adds no site', async ({
    page,
    context,
  }) => {
    const s = await seedMatching('match-open-offline')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    await page.goto(`/${s.slug}/schedule`)
    await expect(newJobButton(page)).toBeEnabled()
    await keepPageInWorker(page)
    await expect
      .poll(() => keptDirectory(page, s.businessId), { timeout: KEEP_TIMEOUT })
      .toContain(P2_JANE_EMAIL)

    await page.clock.setSystemTime(Date.now() + PAGE_AGE_MS)
    await context.setOffline(true)
    try {
      await page.goto('/')
      await expect(newJobButton(page)).toBeEnabled()
      await page
        .getByRole('navigation', { name: 'Tabs' })
        .getByRole('link', { name: 'Clients', exact: true })
        .click()
      const add = page.getByRole('button', { name: 'New client' })
      await expect(add).toBeEnabled()
      const sheet = page.getByRole('dialog')
      await clickUntil(add, () =>
        expect(sheet.getByText('New client').first()).toBeVisible({
          timeout: 2_000,
        }),
      )

      await sheet.getByLabel('Client name', { exact: true }).fill('Jane Nguyen')
      await sheet
        .getByLabel('Phone (optional)', { exact: true })
        .fill(P2_JANE_MOBILE)
      await leavePhone(sheet)
      await expect(
        sheet.getByText('Jane Nguyen, of Bayswater, has this mobile.'),
      ).toBeVisible()
      await typeAddress(sheet, {
        street: '40 Coode St',
        suburb: 'Bayswater',
        postcode: '6053',
      })
      await sheet.getByRole('button', { name: 'Save client' }).click()
      const panel = panelOf(sheet)
      await expect(panel).toContainText(
        'Jane Nguyen, of Bayswater, has the same name and mobile.',
      )
      await panel.getByRole('button', { name: 'Open Jane Nguyen' }).click()

      // Her sheet is the copy kept on the phone, which adds no site: no
      // Add property on 40 Coode St there.
      const hers = page.getByRole('dialog').filter({
        has: page.getByRole('heading', { name: 'Jane Nguyen', exact: true }),
      })
      await expect(
        hers.getByText(
          /^No signal — showing the copy kept on this phone, updated \S.*\. Editing needs signal\.$/,
        ),
      ).toBeVisible()
      await expect(
        hers.getByLabel('Street address', { exact: true }),
      ).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(hers).toHaveCount(0)

      // So New client kept it: opened again, the caller's address is
      // still there, and it says why.
      await clickUntil(add, () =>
        expect(sheet.getByText('New client').first()).toBeVisible({
          timeout: 2_000,
        }),
      )
      await expect(
        sheet.getByText('Still filled in from before you opened Jane Nguyen.'),
      ).toBeVisible()
      await expect(
        sheet.getByLabel('Street address', { exact: true }),
      ).toHaveValue('40 Coode St')
      await expect(
        sheet.getByLabel('Phone (optional)', { exact: true }),
      ).toHaveValue(P2_JANE_MOBILE)
    } finally {
      await context.setOffline(false)
    }
    // Nothing was made meanwhile.
    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length)
  })

  // Its second tap lands while the first's address checks still answer
  // ("Checking…"); the next test's lands once the panel is drawn.
  test('a double tap on Book books nothing and applies no fix', async ({
    page,
  }) => {
    const s = await seedMatching('match-double')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    const sheet = await openNewJob(page, s.slug)

    await typeCaller(sheet, {
      name: 'Jane Nguyen',
      phone: P2_JANE_MOBILE,
      street: '40 Coode St',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).dblclick()

    await expect(panelOf(sheet)).toContainText(
      'Jane Nguyen, of Bayswater, has the same name and mobile.',
    )
    // Still the new client as typed: no fix was taken.
    await expect(
      sheet.getByRole('radio', { name: 'New client', checked: true }),
    ).toBeVisible()
    await expect(sheet.getByLabel('New site for')).toHaveCount(0)
    await expect(
      sheet.getByRole('button', { name: 'Book anyway' }),
    ).toBeVisible()
    // And nothing booked, some while after.
    await page.waitForTimeout(1_500)
    expect(await todaysJobs(s.owner, s.businessId)).toHaveLength(0)
    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length)
  })

  test('a second tap the moment the panel is drawn books nothing and takes no fix', async ({
    page,
  }) => {
    const s = await seedMatching('match-held')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    const sheet = await openNewJob(page, s.slug)

    await typeCaller(sheet, {
      name: 'Jane Nguyen',
      phone: P2_JANE_MOBILE,
      street: '40 Coode St',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    // In the frame the panel is first drawn: Book pressed again, and the
    // panel's fix tapped, as a thumb still there would. Each says whether it
    // was held as it was tapped.
    await page.evaluate(() => {
      const held = new Promise<Array<string>>((resolve) => {
        const observer = new MutationObserver(() => {
          const panel = Array.from(document.querySelectorAll('section')).find(
            (el) => el.textContent.includes('to check before saving'),
          )
          if (!panel) return
          observer.disconnect()
          requestAnimationFrame(() => {
            const said: Array<string> = []
            const book = panel
              .closest('form')
              ?.querySelector<HTMLButtonElement>('button[type="submit"]')
            said.push(book?.getAttribute('aria-disabled') ?? 'not held')
            book?.click()
            const fix = Array.from(panel.querySelectorAll('button')).find(
              (button) => button.textContent === 'Use Jane Nguyen',
            )
            said.push(fix?.getAttribute('aria-disabled') ?? 'not held')
            fix?.click()
            resolve(said)
          })
        })
        observer.observe(document.body, { childList: true, subtree: true })
      })
      ;(window as unknown as { secondTap: Promise<Array<string>> }).secondTap =
        held
    })
    await sheet.getByRole('button', { name: 'Book job' }).click()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { secondTap: Promise<Array<string>> })
            .secondTap,
      ),
    ).toEqual(['true', 'true'])

    // Neither was taken: the panel still says it, the new client is still
    // as typed, and nothing is booked some while after.
    await expect(panelOf(sheet)).toContainText(
      'Jane Nguyen, of Bayswater, has the same name and mobile.',
    )
    await expect(
      sheet.getByRole('radio', { name: 'New client', checked: true }),
    ).toBeVisible()
    await expect(sheet.getByLabel('New site for')).toHaveCount(0)
    await page.waitForTimeout(1_500)
    expect(await todaysJobs(s.owner, s.businessId)).toHaveLength(0)
    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length)
  })

  test('“12 Watle St” for Jane: Book at 12 Wattle St books on her own site', async ({
    page,
  }) => {
    const s = await seedMatching('match-near')
    const before = await bookOf(s.owner, s.businessId)
    await signInViaUi(page, s.owner.email)
    const sheet = await openNewJob(page, s.slug)

    await typeCaller(sheet, {
      name: 'Jane Nguyen',
      phone: P2_JANE_MOBILE,
      street: '12 Watle St',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    await chooseJobTypes(page, sheet, ['General Pest Control'])
    await sheet.getByRole('button', { name: 'Book job' }).click()
    const panel = panelOf(sheet)
    await expect(panel).toContainText(
      'Jane Nguyen has the same name and mobile. 12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater.',
    )
    await expect(
      panel.getByRole('button', { name: 'Add 12 Watle St' }),
    ).toBeVisible()
    await panel.getByRole('button', { name: 'Book at 12 Wattle St' }).click()

    await expect(sheet.getByLabel('Property')).toContainText(
      'Jane Nguyen — 12 Wattle St, Bayswater',
    )
    await expect(sheet.getByLabel('Property')).toBeFocused()
    await sheet.getByRole('button', { name: 'Book job' }).click()
    await expect(sheet).toBeHidden()

    const after = await bookOf(s.owner, s.businessId)
    expect(after.clients).toHaveLength(before.clients.length)
    expect(after.sites).toHaveLength(before.sites.length)
    const jobs = await todaysJobs(s.owner, s.businessId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].propertyId).toBe(s.janeSite)
  })
})
