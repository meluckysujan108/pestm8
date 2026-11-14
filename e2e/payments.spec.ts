import { expect, test } from '@playwright/test'
import {
  api,
  chooseStatus,
  clickUntil,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'
import { addDaysToKey, dayKeyOf } from '../convex/lib/dates'
import type { Locator, Page } from '@playwright/test'

/**
 * Taking the money at the end of a visit, from the job's sheet: cash, card,
 * an invoice that is paid later, a part payment, and taking one back. The
 * fixture's job is booked for now at $380, so its question is already open.
 */

type Setup = Awaited<ReturnType<typeof setupBusinessWithSub>>

async function openJob(page: Page, s: Setup, email = s.owner.email) {
  await signInViaUi(page, email)
  await page.goto(`/${s.slug}/schedule?date=${s.ownerJobDay}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(page.getByText('Termite Inspection').first(), () =>
    expect(
      sheet.getByRole('heading', { name: 'Notes', exact: true }),
    ).toBeVisible({ timeout: 3_000 }),
  )
  const payment = sheet.locator('section').filter({
    has: page.getByRole('heading', { name: 'Payment', exact: true }),
  })
  await expect(payment.getByRole('button', { name: /^Cash/ })).toBeEnabled()
  return { sheet, payment }
}

/** What is on the server, not just what the sheet came to say. */
async function statusOnServer(s: Setup) {
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  return job?.status
}

function moneyOnServer(s: Setup) {
  return s.owner.client.query(api.payments.forJob, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
}

const tile = (payment: Locator, name: string) =>
  payment.getByRole('button', { name: new RegExp(`^${name}`) })

test('cash at the door closes the job and locks it', async ({ page }) => {
  const s = await setupBusinessWithSub('pay-cash')
  const { sheet, payment } = await openJob(page, s)

  await expect(payment.getByText('How did they pay?')).toBeVisible()
  await tile(payment, 'Cash').click()
  await expect(payment.getByLabel('Amount (AUD)')).toHaveValue('380.00')
  await payment.getByRole('button', { name: 'Record $380 cash' }).click()

  await expect(payment.getByText('Paid $380')).toBeVisible()
  await expect(payment.getByRole('button', { name: 'Undo' })).toBeVisible()
  await expect(sheet.getByText('Paid', { exact: true }).first()).toBeVisible()
  await expect(
    sheet.getByText(/This job has been paid, so its details are locked/),
  ).toBeVisible()
  // Paid follows the money: there is no changing it by hand.
  await expect(
    sheet.getByRole('button', { name: 'Change job status' }),
  ).toHaveCount(0)

  expect(await statusOnServer(s)).toBe('paid')
  const money = await moneyOnServer(s)
  expect(money?.payments).toHaveLength(1)
  expect(money?.payments[0]).toMatchObject({ method: 'cash', amount: 38000 })
})

test('card shows on the job’s card once the sheet is shut', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('pay-card')
  const { sheet, payment } = await openJob(page, s)

  await tile(payment, 'Card').click()
  await payment.getByRole('button', { name: 'Record $380 card' }).click()
  await expect(payment.getByText('Paid $380')).toBeVisible()
  expect((await moneyOnServer(s))?.payments[0].method).toBe('card')

  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByText('Paid by card')).toBeVisible()
})

test('an invoice waits behind a tap, and is paid by transfer later', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('pay-invoice')
  const { sheet, payment } = await openJob(page, s)

  await tile(payment, 'Invoice').click()
  await payment.getByRole('button', { name: 'Mark invoiced' }).click()

  await expect(payment.getByText('$380 owing')).toBeVisible()
  await expect(payment.getByText('Invoiced, waiting to be paid.')).toBeVisible()
  await expect(tile(payment, 'Cash')).toHaveCount(0)
  expect(await statusOnServer(s)).toBe('invoiced')

  // Billed, so the question is about how the invoice is settled.
  await payment.getByRole('button', { name: 'Record a payment' }).click()
  await expect(tile(payment, 'Invoice')).toHaveCount(0)
  await tile(payment, 'Transfer').click()
  await payment.getByLabel('Reference (optional)').fill('INV-2418')
  await payment.getByRole('button', { name: 'Record $380 transfer' }).click()

  await expect(payment.getByText('Paid $380')).toBeVisible()
  await expect(payment.getByText(/Ref INV-2418/)).toBeVisible()
  await expect(sheet.getByText('Paid', { exact: true }).first()).toBeVisible()
  expect(await statusOnServer(s)).toBe('paid')
})

test('a part payment says what is left, and the rest closes it', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('pay-part')
  const { payment } = await openJob(page, s)

  await tile(payment, 'Cash').click()
  await payment.getByLabel('Amount (AUD)').fill('100')
  await expect(payment.getByText('Leaves $280 owing.')).toBeVisible()
  await payment.getByRole('button', { name: 'Record $100 cash' }).click()

  await expect(payment.getByText('Paid $100')).toBeVisible()
  await expect(payment.getByText('$280 owing')).toBeVisible()
  await expect(
    payment.getByText('Part paid, the rest still to come.'),
  ).toBeVisible()
  expect(await statusOnServer(s)).toBe('invoiced')

  await payment.getByRole('button', { name: 'Record a payment' }).click()
  await expect(payment.getByText('How was the rest paid?')).toBeVisible()
  await tile(payment, 'Card').click()
  await expect(payment.getByLabel('Amount (AUD)')).toHaveValue('280.00')
  await payment.getByRole('button', { name: 'Record $280 card' }).click()

  await expect(payment.getByText('Paid $280')).toBeVisible()
  expect(await statusOnServer(s)).toBe('paid')
  expect((await moneyOnServer(s))?.payments).toHaveLength(2)
})

test('an amount over what is owing is refused where it was typed', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('pay-over')
  const { payment } = await openJob(page, s)

  await tile(payment, 'Cash').click()
  await payment.getByLabel('Amount (AUD)').fill('500')
  await payment.getByRole('button', { name: 'Record $500 cash' }).click()

  await expect(
    payment.getByText('That’s more than the $380 owing.'),
  ).toBeVisible()
  expect((await moneyOnServer(s))?.payments).toHaveLength(0)
})

test('Undo takes it straight back, and the question is asked again', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('pay-undo')
  const { sheet, payment } = await openJob(page, s)

  await tile(payment, 'Cash').click()
  await payment.getByRole('button', { name: 'Record $380 cash' }).click()
  await expect(payment.getByText('Paid $380')).toBeVisible()

  await payment.getByRole('button', { name: 'Undo' }).click()

  await expect(tile(payment, 'Cash')).toBeVisible()
  await expect(payment.getByText('Paid $380')).toHaveCount(0)
  await expect(
    sheet.getByText('Completed', { exact: true }).first(),
  ).toBeVisible()
  expect(await statusOnServer(s)).toBe('completed')
  const money = await moneyOnServer(s)
  expect(money?.payments).toHaveLength(0)
  expect(money?.removed).toHaveLength(1)
})

test('once the sheet has been shut, taking one back asks first', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('pay-remove')
  await s.owner.client.mutation(api.payments.record, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    method: 'cash',
    complete: true,
    clientRequestId: crypto.randomUUID(),
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${s.ownerJobDay}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(page.getByText('Termite Inspection').first(), () =>
    expect(
      sheet.getByRole('heading', { name: 'Payment', exact: true }),
    ).toBeVisible({ timeout: 3_000 }),
  )

  await sheet.getByRole('button', { name: 'Remove', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm.getByText('Remove this payment?')).toBeVisible()
  await confirm.getByRole('button', { name: 'Keep payment' }).click()
  await expect(confirm).toHaveCount(0)
  expect(await statusOnServer(s)).toBe('paid')

  await sheet.getByRole('button', { name: 'Remove', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Remove', exact: true })
    .click()
  await expect
    .poll(() => statusOnServer(s).catch(() => undefined))
    .toBe('completed')
})

test('the status picker’s Paid goes to the question and changes nothing', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('pay-picker')
  const { payment } = await openJob(page, s)

  await chooseStatus(page, 'Paid')

  await expect(
    payment.getByRole('heading', { name: 'Payment', exact: true }),
  ).toBeFocused()
  expect(await statusOnServer(s)).toBe('pending')
  expect((await moneyOnServer(s))?.payments).toHaveLength(0)
})

test('someone who cannot see prices records it in full, with no figure', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('pay-hidden')
  const jobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'General Pest Control',
    price: 18500,
    scheduledAt: s.ownerJobAt,
    durationMinutes: 60,
  })

  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/schedule?date=${s.ownerJobDay}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  const sheet = page.getByRole('dialog')
  await clickUntil(page.getByText('General Pest Control').first(), () =>
    expect(
      sheet.getByRole('heading', { name: 'Payment', exact: true }),
    ).toBeVisible({ timeout: 3_000 }),
  )
  const payment = sheet.locator('section').filter({
    has: page.getByRole('heading', { name: 'Payment', exact: true }),
  })

  await tile(payment, 'Cash').click()
  await expect(payment.getByLabel('Amount (AUD)')).toHaveCount(0)
  await payment
    .getByRole('button', { name: 'Record cash, paid in full' })
    .click()

  await expect(payment.getByText('Paid', { exact: true })).toBeVisible()
  await expect(payment.getByText('$185')).toHaveCount(0)
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId,
  })
  expect(job?.status).toBe('paid')
})

test('Payments lists the invoice to chase, and files its transfer on the day it came', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('pay-page')
  const { payment } = await openJob(page, s)
  await tile(payment, 'Invoice').click()
  await payment.getByRole('button', { name: 'Mark invoiced' }).click()
  await expect(payment.getByText('$380 owing')).toBeVisible()

  await page.goto(`/${s.slug}/payments`)
  await expect(
    page.getByRole('heading', { name: 'Payments', level: 1 }),
  ).toBeVisible()
  const row = page.getByRole('button', { name: /J\. Nguyen.*\$380/ })
  await expect(row).toBeEnabled()

  // Opened from the list, recorded on the job's own sheet, on the day the
  // transfer actually landed.
  const sheet = page.getByRole('dialog')
  await clickUntil(row, () =>
    expect(sheet.getByRole('button', { name: 'Record a payment' })).toBeEnabled(
      { timeout: 3_000 },
    ),
  )
  const section = sheet.locator('section').filter({
    has: page.getByRole('heading', { name: 'Payment', exact: true }),
  })
  await section.getByRole('button', { name: 'Record a payment' }).click()
  await tile(section, 'Transfer').click()
  const yesterday = addDaysToKey(dayKeyOf(Date.now(), 'Australia/Perth'), -1)
  await section.getByLabel('Paid on').fill(yesterday)
  await section.getByRole('button', { name: 'Record $380 transfer' }).click()
  await expect(section.getByText('Paid $380')).toBeVisible()

  const money = await moneyOnServer(s)
  expect(money?.payments).toHaveLength(1)
  expect(dayKeyOf(money!.payments[0].receivedAt, 'Australia/Perth')).toBe(
    yesterday,
  )
  expect(await statusOnServer(s)).toBe('paid')

  // Filed under the month it came in, which past midnight on the 1st is the
  // month before this one.
  await page.goto(`/${s.slug}/payments?tab=paid&month=${yesterday.slice(0, 7)}`)
  await expect(
    page.getByRole('button', { name: /J\. Nguyen.*Bank transfer/ }),
  ).toBeVisible()
  await page.goto(`/${s.slug}/payments`)
  await expect(page.getByText('Nothing owing')).toBeVisible()
})

test('a deposit on a booking ahead leaves it as it is', async ({ page }) => {
  const s = await setupBusinessWithSub('pay-deposit')
  const ahead = s.ownerJobAt + 7 * 24 * 60 * 60 * 1000
  const jobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'Ants',
    price: 30000,
    scheduledAt: ahead,
    durationMinutes: 60,
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(
    `/${s.slug}/schedule?date=${dayKeyOf(ahead, 'Australia/Perth')}&jobId=${jobId}`,
  )
  const sheet = page.getByRole('dialog')
  const section = sheet.locator('section').filter({
    has: page.getByRole('heading', { name: 'Payment', exact: true }),
  })
  // Work ahead is not asked how it was paid: the deposit waits behind a tap.
  await expect(
    section.getByRole('button', { name: 'Record a deposit' }),
  ).toBeEnabled()
  await expect(tile(section, 'Cash')).toHaveCount(0)
  await section.getByRole('button', { name: 'Record a deposit' }).click()

  await expect(section.getByText('How was the deposit paid?')).toBeVisible()
  await expect(tile(section, 'Invoice')).toHaveCount(0)
  await tile(section, 'Cash').click()
  await section.getByLabel('Amount (AUD)').fill('100')
  await section.getByRole('button', { name: 'Record $100 cash' }).click()

  await expect(section.getByText('Deposit $100')).toBeVisible()
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId,
  })
  expect(job?.status).toBe('pending')
  const money = await s.owner.client.query(api.payments.forJob, {
    businessId: s.businessId,
    jobId,
  })
  expect(money?.payments[0]).toMatchObject({
    method: 'cash',
    amount: 10000,
    deposit: true,
  })
})
