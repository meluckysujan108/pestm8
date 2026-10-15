import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'

/**
 * Xero (Release 1: connect), as the e2e deployment has it — which is not set
 * up for Xero on purpose (CLAUDE.md, docs/xero.md: no XERO_* variables), so
 * this is what every deployment without it looks like: no Xero rows in
 * Settings, and the pages say so to whoever opens them by address.
 *
 * Connecting itself needs Xero's sign-in and is covered by the backend's own
 * tests against a fake Xero (convex/xeroConnect.test.ts).
 *
 * Also here, because Xero's way back is the reason for it: a signed-out
 * visit to a page inside a business comes back to that page after signing
 * in, finish token and all, rather than to the schedule.
 */

test('without Xero set up, Settings has no Xero rows', async ({ page }) => {
  const s = await setupBusinessWithSub('xero-hub')
  // The precondition, asked of the server: the rows are hidden because the
  // deployment says it has no Xero, not because the answer is slow.
  const status = await s.owner.client.query(api.xero.status, {
    businessId: s.businessId,
  })
  expect(status.configured).toBe(false)

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/settings`)
  await expect(page.getByRole('link', { name: /^Recycle bin/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Xero/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /^My Xero/ })).toHaveCount(0)
})

test('a subcontractor gets no My Xero row without Xero set up', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('xero-hub-sub')
  const status = await s.sub.client.query(api.xero.status, {
    businessId: s.businessId,
  })
  expect(status.configured).toBe(false)
  expect(status.business).toBeNull()

  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/settings`)
  await expect(page.getByRole('link', { name: /^My details/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /^My Xero/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /^Xero/ })).toHaveCount(0)
})

test('Settings → Xero, opened by address by the owner: not set up here', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('xero-page-owner')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/settings/xero`)
  await expect(
    page.getByRole('heading', { name: 'Xero', level: 1 }),
  ).toBeVisible()
  await expect(page.getByText('Xero isn’t set up here')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect Xero' })).toHaveCount(
    0,
  )
})

test('Settings → Xero, opened by address by a subcontractor: owners only', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('xero-page-sub')
  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/settings/xero`)
  await expect(page.getByText('Owners only', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect Xero' })).toHaveCount(
    0,
  )
})

test('Settings → My Xero, opened by address by a subcontractor: not set up here', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('xero-mine-sub')
  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/settings/my-xero`)
  await expect(
    page.getByRole('heading', { name: 'My Xero', level: 1 }),
  ).toBeVisible()
  await expect(page.getByText('Xero isn’t set up here')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect Xero' })).toHaveCount(
    0,
  )
})

test('Settings → My Xero, opened by address by the owner: points to the business’s Xero', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('xero-mine-owner')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/settings/my-xero`)
  // The owner's organisation is the business's: My Xero points there.
  await expect(page.getByText('Your Xero is the business’s')).toBeVisible()
  await page.getByRole('link', { name: 'Go to the business’s Xero' }).click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings/xero$`))
  await expect(page.getByText('Xero isn’t set up here')).toBeVisible()
})

test('signed out, a page inside the business comes back after signing in, its search kept', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('xero-next')
  const target = `/${s.slug}/settings/xero?finish=x`

  await page.goto(target)
  await expect(page).toHaveURL(/\/login\?/)
  expect(new URL(page.url()).searchParams.get('next')).toBe(target)

  // Signed in through the form this redirect landed on — not
  // `signInViaUi`, which opens a bare /login first.
  const submit = page.getByRole('button', { name: 'Sign in' })
  await expect(submit).toBeEnabled()
  await page.getByLabel('Email').fill(s.owner.email)
  await page.getByLabel('Password').fill(FIXTURE_PASSWORD)
  await submit.click()

  await expect(page).toHaveURL(
    new RegExp(`/${s.slug}/settings/xero\\?finish=x$`),
  )
  // Nothing to finish on a deployment without Xero: the page says so, and
  // asks the server for nothing.
  await expect(page.getByText('Xero isn’t set up here')).toBeVisible()
})

test('a next that leaves the site is ignored: sign-in lands in the app', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('xero-next-offsite')
  await page.goto('/login?next=%2F%2Fevil.example%2F')
  const submit = page.getByRole('button', { name: 'Sign in' })
  await expect(submit).toBeEnabled()
  await page.getByLabel('Email').fill(s.owner.email)
  await page.getByLabel('Password').fill(FIXTURE_PASSWORD)
  await submit.click()
  // `safeNext` turns it into `/`, which finds their business.
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/`))
  expect(page.url()).not.toContain('evil.example')
})
