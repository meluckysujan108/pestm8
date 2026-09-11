import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

async function setup(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )
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

test('the job-type combobox accepts a value typed outside the fixed list', async ({
  page,
}) => {
  const s = await setup('combo-jobtype')

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await sheet.getByLabel('Job type').click()
  await page
    .getByRole('textbox', { name: 'Search or add a job type' })
    .fill('Possum Removal')
  await page
    .getByRole('button', { name: 'Add "Possum Removal" as a new job type' })
    .click()
  await sheet.getByLabel('Start').fill('09:00')
  await sheet.getByLabel('Price (AUD)').fill('200')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  const card = page.getByRole('button', { name: /Possum Removal/ })
  await expect(card).toBeVisible()
})

test('the property combobox filters by client name, not just address', async ({
  page,
}) => {
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
  await page
    .getByRole('textbox', { name: 'Search by name or address' })
    .fill('Roberts')

  await expect(page.getByRole('button', { name: /M\. Roberts/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /J\. Nguyen/ })).toHaveCount(0)

  await page.getByRole('button', { name: /M\. Roberts/ }).click()
  await sheet.getByLabel('Job type').click()
  await page.getByRole('button', { name: 'Rodents', exact: true }).click()
  await sheet.getByLabel('Start').fill('10:00')
  await sheet.getByLabel('Price (AUD)').fill('180')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  await expect(page.getByText('M. Roberts')).toBeVisible()
})

test('Settings moved out of the page header: reachable from the mobile tab bar and the desktop sidebar', async ({
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
  const mobileSettings = mobileNav.getByRole('link', { name: 'Settings' })
  await expect(mobileSettings).toBeVisible()
  await mobileSettings.click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings$`))

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  const sidebarNav = page.getByRole('navigation').first()
  const sidebarSettings = sidebarNav.getByRole('link', { name: 'Settings' })
  const analytics = sidebarNav.getByRole('link', { name: 'Analytics' })
  await expect(sidebarSettings).toBeVisible()
  const [settingsBox, analyticsBox] = await Promise.all([
    sidebarSettings.boundingBox(),
    analytics.boundingBox(),
  ])
  expect(settingsBox!.y).toBeGreaterThan(analyticsBox!.y)
  await sidebarSettings.click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings$`))
})
