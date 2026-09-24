import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseProperty,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * Prompt 5.2: an optional Work Order on a job, shown clearly for business
 * clients, stored on the job and shown on its detail sheet.
 */

function perthToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
  }).format(new Date())
}

/** The job sheet's "Work order" section: its heading and what sits under it. */
function workOrderSection(detail: Locator) {
  // The inner locator is matched inside each section, so it starts from the
  // page, not from `detail` (which would never be inside a section).
  return detail.locator('section').filter({
    has: detail
      .page()
      .getByRole('heading', { name: 'Work order', exact: true }),
  })
}

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
    clientName: 'Coastal Cafe Group',
    kind: 'business',
    addressLine: '88 Marine Parade',
    suburb: 'Cottesloe',
    state: 'WA',
    postcode: '6011',
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

test('a business client’s work order is asked for, saved, shown, and can be corrected', async ({
  page,
}) => {
  const s = await setup('wo-business')
  const day = perthToday()
  // What each Save sends. An edit that leaves the work order alone must not
  // send it at all: then a frontend that ships before its backend still
  // saves ordinary edits, and a form opened before someone else's change
  // cannot write its stale value back over it.
  const updates: Array<string> = []
  page.on('websocket', (ws) =>
    ws.on('framesent', ({ payload }) => {
      if (String(payload).includes('jobs:update')) updates.push(String(payload))
    }),
  )

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${day}`)
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  // Until someone is chosen it is only offered, not asked. The offer is
  // waited for first: the sheet renders a placeholder while it loads, and an
  // absence checked then would prove nothing.
  await expect(
    sheet.getByRole('button', { name: '+ Add work order' }),
  ).toBeVisible()
  await expect(sheet.getByLabel('Work Order (Optional)')).toHaveCount(0)
  await chooseProperty(page, sheet, 'coastal', /Coastal Cafe Group/)
  // A business client: the field is simply there, no extra tap.
  const field = sheet.getByLabel('Work Order (Optional)')
  await expect(field).toBeVisible()
  await expect(
    sheet.getByRole('button', { name: '+ Add work order' }),
  ).toHaveCount(0)
  await field.fill('  WO-448120 ')
  await sheet.getByLabel('Start').fill('08:30')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  const [job] = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(job.workOrder).toBe('WO-448120')

  // Shown on the job's own sheet.
  await page.getByRole('button', { name: /General Pest Control/ }).click()
  const detail = page.getByRole('dialog')
  const section = workOrderSection(detail)
  await expect(section).toContainText('WO-448120')

  // A reschedule leaves it out of what is sent.
  await detail.getByRole('button', { name: 'Edit job details' }).click()
  await detail.getByLabel('Start').fill('09:15')
  await detail.getByRole('button', { name: 'Save' }).click()
  await expect(
    detail.getByRole('button', { name: 'Edit job details' }),
  ).toBeVisible()
  await expect.poll(() => updates.length).toBe(1)
  expect(updates[0]).not.toContain('workOrder')
  await expect(section).toContainText('WO-448120')

  // The office changes it while the form is open elsewhere; this form's
  // unrelated save does not put the old one back.
  await detail.getByRole('button', { name: 'Edit job details' }).click()
  await expect(detail.getByLabel('Work order')).toHaveValue('WO-448120')
  await s.owner.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId: job._id,
    workOrder: 'WO-9',
    jobType: 'Termite Inspection',
  })
  // The sheet's title is live while the form is open: once it reads the new
  // job type, this page holds the new work order too, and the form still
  // shows the one it opened with.
  await expect(
    detail.getByRole('heading', { name: 'Termite Inspection' }),
  ).toBeVisible()
  await expect(detail.getByLabel('Work order')).toHaveValue('WO-448120')
  await detail.getByLabel('Minutes').fill('90')
  await detail.getByRole('button', { name: 'Save' }).click()
  await expect(section).toContainText('WO-9')
  expect(updates[1]).not.toContain('workOrder')

  // Corrected, then cleared: a business client with none says so.
  await detail.getByRole('button', { name: 'Edit job details' }).click()
  await detail.getByLabel('Work order').fill('WO-448121')
  await detail.getByRole('button', { name: 'Save' }).click()
  await expect(section).toContainText('WO-448121')

  await detail.getByRole('button', { name: 'Edit job details' }).click()
  await detail.getByLabel('Work order').fill('')
  await detail.getByRole('button', { name: 'Save' }).click()
  await expect(section).toContainText('None recorded')
  const after = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: job._id,
  })
  expect(after?.workOrder).toBeUndefined()
})

test('anyone else’s job can still carry one, a tap away', async ({ page }) => {
  const s = await setup('wo-person')
  const day = perthToday()

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${day}`)
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await chooseProperty(page, sheet, 'Nguyen', /J\. Nguyen/)
  await expect(sheet.getByLabel('Work Order (Optional)')).toHaveCount(0)
  await sheet.getByRole('button', { name: '+ Add work order' }).click()
  // The tap opens the field and puts the cursor in it; it does not book.
  await expect(sheet).toBeVisible()
  const field = sheet.getByLabel('Work Order (Optional)')
  await expect(field).toBeFocused()
  await field.fill('REA-2231')

  // Switching to a business client keeps what was typed on screen.
  await chooseProperty(page, sheet, 'coastal', /Coastal Cafe Group/)
  await expect(field).toHaveValue('REA-2231')
  await chooseProperty(page, sheet, 'Nguyen', /J\. Nguyen/)
  await expect(field).toHaveValue('REA-2231')

  await sheet.getByLabel('Start').fill('10:00')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  const jobs = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(jobs.map((j) => [j.clientName, j.workOrder])).toEqual([
    ['J. Nguyen', 'REA-2231'],
  ])

  // A person client with none shows no section at all.
  await s.owner.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId: jobs[0]._id,
    workOrder: '',
  })
  await page.getByRole('button', { name: /General Pest Control/ }).click()
  const detail = page.getByRole('dialog')
  await expect(
    detail.getByRole('heading', { name: 'Price', exact: true }),
  ).toBeVisible()
  await expect(workOrderSection(detail)).toHaveCount(0)
})

test('a work order typed for a business client is never sent unseen', async ({
  page,
}) => {
  const s = await setup('wo-switch')
  const day = perthToday()

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${day}`)
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await chooseProperty(page, sheet, 'coastal', /Coastal Cafe Group/)
  const field = sheet.getByLabel('Work Order (Optional)')
  await field.fill('WO-1')

  // Switched to a person client, the field would normally fold away behind
  // "+ Add work order". Holding a value, it stays where it can be seen.
  await chooseProperty(page, sheet, 'Nguyen', /J\. Nguyen/)
  await expect(field).toBeVisible()
  await expect(field).toHaveValue('WO-1')
  await expect(
    sheet.getByRole('button', { name: '+ Add work order' }),
  ).toHaveCount(0)

  // Emptied, it folds away — and nothing is sent.
  await field.fill('')
  await expect(
    sheet.getByRole('button', { name: '+ Add work order' }),
  ).toBeVisible()
  await sheet.getByLabel('Start').fill('11:00')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()
  const [job] = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(job.clientName).toBe('J. Nguyen')
  expect(job.workOrder).toBeUndefined()
})

test('a new business client typed in is asked for its work order too', async ({
  page,
}) => {
  const s = await setup('wo-new-business')
  const day = perthToday()

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${day}`)
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await sheet.getByRole('tab', { name: 'New client' }).click()
  await expect(
    sheet.getByRole('button', { name: '+ Add work order' }),
  ).toBeVisible()
  await sheet.getByRole('tab', { name: 'Business' }).click()
  const field = sheet.getByLabel('Work Order (Optional)')
  await expect(field).toBeVisible()
  await expect(
    sheet.getByRole('button', { name: '+ Add work order' }),
  ).toHaveCount(0)

  await sheet.getByLabel('Business name').fill('Harbour Strata')
  await sheet.getByLabel('Street address').fill('1 Quay Road')
  await sheet.getByLabel('Suburb').fill('Fremantle')
  await sheet.getByLabel('Postcode').fill('6160')
  await field.fill('HS-0042')
  await sheet.getByLabel('Start').fill('12:00')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  const [job] = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect([job.clientName, job.workOrder]).toEqual(['Harbour Strata', 'HS-0042'])
})

test('a Recurring Job booked under a work order books every visit under it', async ({
  page,
}) => {
  const s = await setup('wo-series')
  const day = perthToday()

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${day}`)
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await chooseProperty(page, sheet, 'coastal', /Coastal Cafe Group/)
  await sheet.getByLabel('Work Order (Optional)').fill('PO 4500123456')
  await sheet.getByRole('tab', { name: 'Recurring Job' }).click()
  await sheet.getByLabel('Repeat every').fill('1')
  await sheet.getByLabel('Repeat unit').selectOption('month')
  await sheet.getByLabel('Start').fill('07:00')
  await sheet.getByRole('button', { name: 'Book job' }).click()
  await expect(sheet).toBeHidden()

  const [series] = await s.owner.client.query(api.recurrences.listForBusiness, {
    businessId: s.businessId,
  })
  expect(series.workOrder).toBe('PO 4500123456')
  const [first] = await s.owner.client.query(api.jobs.listDay, {
    businessId: s.businessId,
    dayKey: day,
  })
  expect(first.workOrder).toBe('PO 4500123456')
})
