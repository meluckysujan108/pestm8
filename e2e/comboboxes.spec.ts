import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseJobTypes,
  chooseProperty,
  clickUntil,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

async function setup(label: string) {
  const owner = await signUpActor(uniqueEmail(label), FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  return { owner, businessId, slug }
}

test('the job-type combobox accepts a value typed outside the fixed list', async ({ page }) => {
  const s = await setup('combo-jobtype')

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await chooseProperty(page, sheet, 'Nguyen', /J\. Nguyen/)
  await chooseJobTypes(page, sheet, ['Possum Removal'])
  await sheet.getByLabel('Start').fill('09:00')
  await sheet.getByLabel('Price (AUD)').fill('200')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  const card = page.getByRole('button', { name: /Possum Removal/ })
  await expect(card).toBeVisible()
})

test('the property combobox filters by client name, not just address', async ({ page }) => {
  const s = await setup('combo-property')
  await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'M. Roberts',
    addressLine: '4 Kalinda Way',
    suburb: 'Morley',
    state: 'WA',
    postcode: '6062',
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await sheet.getByLabel('Property').click()
  await page.getByRole('textbox', { name: 'Search by name or address' }).fill('Roberts')

  await expect(page.getByRole('button', { name: /M\. Roberts/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /J\. Nguyen/ })).toHaveCount(0)

  await page.getByRole('button', { name: /M\. Roberts/ }).click()
  await chooseJobTypes(page, sheet, ['Rodents'])
  await sheet.getByLabel('Start').fill('10:00')
  await sheet.getByLabel('Price (AUD)').fill('180')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  await expect(page.getByText('M. Roberts')).toBeVisible()
})

function perthToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
  }).format(new Date())
}

/**
 * Prompt 5.1. The form used to fill in the business's oldest property on
 * open, so a job booked in a hurry went to whoever was first in the list.
 */
test('a new job starts with no client chosen, and will not book until one is', async ({
  page,
}) => {
  const s = await setup('combo-explicit')
  // Fixed before anything is booked, and the page opened on it, so a run
  // that crosses Perth midnight books and checks the same day.
  const day = perthToday()
  // Every jobs.create the page sends. The refusal has to happen in the form:
  // a message shown AFTER sending would still pass every check on screen,
  // because the server refuses a missing property too.
  const creates: Array<string> = []
  page.on('websocket', (ws) =>
    ws.on('framesent', ({ payload }) => {
      if (String(payload).includes('jobs:create')) creates.push(String(payload))
    }),
  )

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${day}`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  const property = sheet.getByLabel('Property')
  await expect(property).toContainText('Choose a client and address')
  await expect(property).not.toContainText('J. Nguyen')

  await sheet.getByLabel('Start').fill('10:00')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  // Refused in the form, with the reason next to the field that needs it —
  // not the old catch-all about calendar access.
  await expect(
    sheet.getByRole('alert').filter({ hasText: 'Choose the client and address for this job.' }),
  ).toBeVisible()
  await expect(property).toHaveAttribute('aria-invalid', 'true')
  await expect(property).toBeFocused()
  await expect(sheet.getByText('You may not have access to that calendar')).toHaveCount(0)
  await expect(sheet).toBeVisible()

  await chooseProperty(page, sheet, 'Nguyen', /J\. Nguyen/)
  await expect(sheet.getByText('Choose the client and address for this job.')).toHaveCount(0)
  await expect(property).not.toHaveAttribute('aria-invalid', 'true')
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  // One booking sent, the one made after choosing.
  expect(creates).toHaveLength(1)
  const jobs = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(jobs).toHaveLength(1)
  expect(jobs[0].addressLine).toBe('12 Wattle Street')
})

test('the client search matches every word typed, across name and address', async ({
  page,
}) => {
  const s = await setup('combo-words')
  await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'M. Roberts',
    addressLine: '4 Kalinda Way',
    suburb: 'Morley',
    state: 'WA',
    postcode: '6062',
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await sheet.getByLabel('Property').click()
  const search = page.getByRole('textbox', { name: 'Search by name or address' })

  // A name and a suburb together: not next to each other in the label.
  await search.fill('nguyen bayswater')
  await expect(page.getByRole('button', { name: /J\. Nguyen/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /M\. Roberts/ })).toHaveCount(0)

  // Every word has to match.
  await search.fill('roberts bayswater')
  await expect(page.getByText('No client or address matches.')).toBeVisible()

  // Enter with two sites still listed takes neither: that would be a guess.
  // The picker stays open on both, and closed, the field still asks.
  await search.fill('a')
  await expect(page.getByRole('button', { name: /J\. Nguyen/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /M\. Roberts/ })).toBeVisible()
  await search.press('Enter')
  await expect(search).toBeVisible()
  await expect(page.getByRole('button', { name: /M\. Roberts/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet.getByLabel('Property')).toContainText('Choose a client and address')

  // A postcode, and Enter takes the only match left.
  await sheet.getByLabel('Property').click()
  await search.fill('6062')
  await search.press('Enter')
  await expect(sheet.getByLabel('Property')).toContainText('M. Roberts — 4 Kalinda Way, Morley')
})

/**
 * The two things a business asked for on 29 Sept 2026: "we do general pest
 * with termites and rodents", and somewhere on the job for a note.
 */
test('a job for several services, with a note, books as one job that says both', async ({
  page,
}) => {
  const s = await setup('combo-services')
  const day = perthToday()

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${day}`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await chooseProperty(page, sheet, 'Nguyen', /J\. Nguyen/)
  // Nothing is ticked until the person ticks it, and Book says so.
  const jobType = sheet.getByLabel('Job type')
  await expect(jobType).toHaveText('Choose one or more')
  await sheet.getByLabel('Start').fill('09:00')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(
    sheet.getByRole('alert').filter({ hasText: 'Choose at least one job type.' }),
  ).toBeVisible()
  await expect(jobType).toBeFocused()

  await jobType.click()
  const picker = page.getByRole('dialog', { name: 'Job type' })
  for (const service of ['General Pest Control', 'Termite Inspection', 'Rodents']) {
    await picker.getByRole('checkbox', { name: service, exact: true }).click()
  }
  await picker.getByRole('button', { name: 'Done' }).click()
  await expect(picker).toBeHidden()
  const services = 'General Pest Control, Termite Inspection, Rodents'
  await expect(sheet.getByLabel('Job type')).toHaveText(services)
  await expect(sheet.getByText('Choose at least one job type.')).toHaveCount(0)

  await sheet
    .getByLabel('Notes (optional)')
    .fill('Tenant home after 10 — ring first.')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  const jobs = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(jobs).toHaveLength(1)
  expect(jobs[0].jobType).toBe(services)
  expect(jobs[0].notes).toBe('Tenant home after 10 — ring first.')

  // The card names every service, and carries the note.
  const card = page.getByRole('button', { name: new RegExp(services) })
  await expect(card).toContainText('Tenant home after 10 — ring first.')

  // On the job, the note is changed in place, without the edit form.
  await card.click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('button', { name: 'Edit note' }).click()
  await detail
    .getByLabel('Note for this job')
    .fill('Tenant home after 11 — ring first.')
  await detail.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    detail.getByText('Tenant home after 11 — ring first.'),
  ).toBeVisible()
  await expect(detail.getByLabel('Note for this job')).toHaveCount(0)

  // Both forms the job produces are a tap away.
  await expect(
    detail.getByRole('button', { name: 'Start Service' }),
  ).toBeVisible()
  await expect(
    detail.getByRole('button', { name: 'Start Inspection' }),
  ).toBeVisible()
})

test('a brand-new client books without choosing an existing one', async ({
  page,
}) => {
  const s = await setup('combo-new-client')
  const day = perthToday()

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${day}`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await sheet.getByRole('radio', { name: 'New client' }).click()
  await sheet.getByLabel('Client name').fill('P. Okafor')
  await sheet.getByLabel('Street address').fill('27 Swan Street')
  await sheet.getByLabel('Suburb').fill('Guildford')
  await sheet.getByLabel('Postcode').fill('6055')
  await sheet.getByLabel('Start').fill('13:00')
  await chooseJobTypes(page, sheet, ['General Pest Control'])
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  const jobs = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(jobs.map((j) => j.addressLine)).toEqual(['27 Swan Street'])
})

test('Settings moved out of the page header: reachable from the phone burger and the desktop sidebar', async ({
  page,
}) => {
  const s = await setup('combo-settings-nav')
  await signInViaUi(page, s.owner.email)

  // AppShell renders the desktop sidebar <nav> first, then the mobile bottom
  // bar <nav> — both exist in the DOM at every width (CSS-only reflow via
  // Tailwind's lg: breakpoint), so scope by nav rather than by visibility.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  const mobileNav = page.getByRole('navigation').last()
  // The dock holds four daily destinations and a burger; Settings is the last
  // item in the sheet that burger opens.
  await expect(mobileNav.getByRole('link', { name: 'Settings' })).toHaveCount(0)
  const mobileSettings = page
    .getByRole('dialog')
    .getByRole('link', { name: 'Settings' })
  await clickUntil(mobileNav.getByRole('button', { name: 'More' }), () =>
    expect(mobileSettings).toBeVisible({ timeout: 2_000 }),
  )
  await mobileSettings.click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings$`))

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  const sidebarNav = page.getByRole('navigation').first()
  const sidebarSettings = sidebarNav.getByRole('link', { name: 'Settings' })
  const analytics = sidebarNav.getByRole('link', { name: 'Analytics' })
  await expect(sidebarSettings).toBeVisible()
  // The sidebar is a `fixed`, width-transitioned panel, so a link can report
  // visible a frame before it has been laid out at its final position and
  // `boundingBox()` still returns null. Poll for a settled box rather than
  // measuring the first one offered.
  const yOf = async (locator: typeof sidebarSettings) =>
    (await locator.boundingBox())?.y ?? -1
  await expect.poll(() => yOf(sidebarSettings)).toBeGreaterThan(0)
  await expect.poll(() => yOf(analytics)).toBeGreaterThan(0)
  expect(await yOf(sidebarSettings)).toBeGreaterThan(await yOf(analytics))
  await sidebarSettings.click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings$`))
})
