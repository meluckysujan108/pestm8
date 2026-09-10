import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

const DAY = 24 * 60 * 60 * 1000

async function setup(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `${label} ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  return {
    owner,
    businessId,
    slug,
    propertyId,
    membershipId: members[0]._id,
  }
}

test('a quarterly recurrence books a run of future visits', async () => {
  const s = await setup('recur-create')

  const recurrenceId = await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.membershipId,
    frequency: 'quarterly',
    jobType: 'General Pest Control',
    price: 22000,
    anchorDate: Date.now() + DAY,
    durationMinutes: 60,
  })

  const jobs = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })

  // 180-day horizon at three-month steps: the first visit plus one more.
  expect(jobs.length).toBeGreaterThanOrEqual(2)
  expect(jobs.every((j) => j.recurrenceId === recurrenceId)).toBe(true)
  expect(jobs.every((j) => j.status === 'booked')).toBe(true)

  const dates = jobs.map((j) => j.scheduledAt).sort((a, b) => a - b)
  const gapDays = (dates[1] - dates[0]) / DAY
  expect(gapDays).toBeGreaterThan(80)
  expect(gapDays).toBeLessThan(100)
})

test('materialising twice does not double-book the property', async () => {
  const s = await setup('recur-idempotent')

  const recurrenceId = await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.membershipId,
    frequency: 'monthly',
    jobType: 'Rodents',
    price: 18000,
    anchorDate: Date.now() + DAY,
    durationMinutes: 45,
  })

  const before = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })

  // The cron runs daily against live schedules, so a second pass creating
  // anything at all would put a duplicate visit in front of a client.
  const created = await s.owner.client.mutation(api.recurrences.materialise, {
    businessId: s.businessId,
    recurrenceId,
  })
  expect(created).toBe(0)

  const after = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  expect(after.length).toBe(before.length)
})

test('ending a recurrence clears future visits but keeps history', async () => {
  const s = await setup('recur-stop')

  const recurrenceId = await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.membershipId,
    frequency: 'monthly',
    jobType: 'Rodents',
    price: 18000,
    anchorDate: Date.now() + DAY,
    durationMinutes: 45,
  })

  const booked = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  expect(booked.length).toBeGreaterThan(1)

  // Complete the first visit: it is history and must survive.
  const first = [...booked].sort((a, b) => a.scheduledAt - b.scheduledAt)[0]
  await s.owner.client.mutation(api.jobs.complete, {
    businessId: s.businessId,
    jobId: first._id,
  })

  await s.owner.client.mutation(api.recurrences.setActive, {
    businessId: s.businessId,
    recurrenceId,
    active: false,
  })

  const remaining = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  expect(remaining.map((j) => j._id)).toContain(first._id)
  expect(remaining.filter((j) => j.status === 'booked')).toHaveLength(0)
})

test('a subcontractor cannot set up work on another calendar', async () => {
  const s = await setupBusinessWithSub('recur-scope')

  await expectRejected(
    () =>
      s.sub.client.mutation(api.recurrences.create, {
        businessId: s.businessId,
        propertyId: s.propertyId,
        assignedMembershipId: s.ownerMembershipId,
        frequency: 'quarterly',
        jobType: 'General Pest Control',
        price: 22000,
        anchorDate: Date.now() + DAY,
        durationMinutes: 60,
      }),
    'NO_ACCESS',
  )
})

test('converting a one-off job to recurring anchors on the converted job itself', async () => {
  const s = await setup('recur-convert')

  const jobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.membershipId,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 90,
  })

  const recurrenceId = await s.owner.client.mutation(
    api.recurrences.convertJobToRecurring,
    { businessId: s.businessId, jobId, frequency: 'monthly' },
  )

  // Same _id, now attached to the new series — not replaced by a fresh job.
  const converted = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId,
  })
  expect(converted?.recurrence?._id).toBe(recurrenceId)
  expect(converted?.recurrence?.frequency).toBe('monthly')

  const jobs = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  expect(jobs.every((j) => j.recurrenceId === recurrenceId)).toBe(true)
  // No duplicate booked at the anchor instant itself.
  expect(jobs.filter((j) => j.scheduledAt === converted!.scheduledAt)).toHaveLength(1)
  // Future occurrences beyond the anchor were actually generated.
  expect(jobs.length).toBeGreaterThan(1)
})

test('stopping a series from one job preserves that job but cancels its still-booked siblings', async () => {
  const s = await setup('recur-stopjob')

  const recurrenceId = await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.membershipId,
    frequency: 'monthly',
    jobType: 'Rodents',
    price: 18000,
    anchorDate: Date.now() + DAY,
    durationMinutes: 45,
  })

  const booked = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  expect(booked.length).toBeGreaterThan(2)
  const sorted = [...booked].sort((a, b) => a.scheduledAt - b.scheduledAt)

  // The first visit is history and must survive regardless.
  await s.owner.client.mutation(api.jobs.complete, {
    businessId: s.businessId,
    jobId: sorted[0]._id,
  })
  // Stop the series from the SECOND visit's own context — it must survive
  // too, unlike the third-and-later visits.
  const viewedJobId = sorted[1]._id

  await s.owner.client.mutation(api.recurrences.stopFromJob, {
    businessId: s.businessId,
    jobId: viewedJobId,
  })

  const recurrence = await s.owner.client.query(api.recurrences.listForBusiness, {
    businessId: s.businessId,
  })
  expect(recurrence.find((r) => r._id === recurrenceId)?.active).toBe(false)

  const remaining = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  const remainingIds = remaining.map((j) => j._id)
  expect(remainingIds).toContain(sorted[0]._id) // completed history, untouched
  expect(remainingIds).toContain(viewedJobId) // the one being viewed, preserved
  expect(remainingIds).not.toContain(sorted[2]._id) // a future sibling, deleted

  const viewedJob = remaining.find((j) => j._id === viewedJobId)
  expect(viewedJob?.recurrenceId).toBeUndefined()
  expect(viewedJob?.status).toBe('booked')
})

test('recurrence mutations follow the same edit gate as every other job field', async () => {
  const s = await setupBusinessWithSub('recur-scope-job')

  const subJobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
  })

  // A subcontractor may act on their OWN job...
  const recurrenceId = await s.sub.client.mutation(
    api.recurrences.convertJobToRecurring,
    { businessId: s.businessId, jobId: subJobId, frequency: 'monthly' },
  )
  expect(recurrenceId).toBeTruthy()
  await s.sub.client.mutation(api.recurrences.stopFromJob, {
    businessId: s.businessId,
    jobId: subJobId,
  })

  // ...but not on the owner's job.
  await expectRejected(
    () =>
      s.sub.client.mutation(api.recurrences.convertJobToRecurring, {
        businessId: s.businessId,
        jobId: s.ownerJobId,
        frequency: 'monthly',
      }),
    'NO_ACCESS',
  )
})

test('booking a repeating job from the schedule shows it as recurring', async ({
  page,
}) => {
  const email = uniqueEmail('recur-ui')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `RecurUI ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const sheet = page.getByRole('dialog')
  await sheet.getByLabel('Job type').click()
  await page.getByRole('button', { name: 'General Pest Control', exact: true }).click()
  await sheet.getByLabel('Repeat').selectOption('quarterly')
  await sheet.getByLabel('Start').fill('09:30')
  await sheet.getByLabel('Price (AUD)').fill('220')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  const card = page.getByRole('button', { name: /General Pest Control/ })
  await expect(card).toBeVisible()
  await card.click()

  await expect(page.getByText('Repeats quarterly')).toBeVisible()
})

test('editing a one-off job into a recurring one, then stopping it, from its own detail sheet', async ({
  page,
}) => {
  const email = uniqueEmail('recur-edit-ui')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name: `RecurEditUI ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  // Book a plain one-off job (Repeat left at its default "One-off").
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const newJobSheet = page.getByRole('dialog')
  await newJobSheet.getByLabel('Job type').click()
  await page.getByRole('button', { name: 'Cockroaches', exact: true }).click()
  await newJobSheet.getByLabel('Start').fill('11:00')
  await newJobSheet.getByLabel('Price (AUD)').fill('150')
  await newJobSheet.getByRole('button', { name: 'Book job' }).click()

  const card = page.getByRole('button', { name: /Cockroaches/ })
  await expect(card).toBeVisible()
  await card.click()

  const detail = page.getByRole('dialog')
  await expect(detail.getByText('One-off')).toBeVisible()

  // Edit the job and turn it into a monthly series.
  await detail.getByRole('button', { name: 'Edit job details' }).click()
  await detail.getByLabel('Repeat').selectOption('monthly')
  await detail.getByRole('button', { name: 'Save' }).click()

  await expect(detail.getByText('Repeats monthly')).toBeVisible()

  // Stop repeating — confirm via the dialog, scoped by its distinct role so
  // it doesn't collide with the trigger button of the same name underneath.
  await detail.getByRole('button', { name: 'Stop repeating' }).click()
  const confirm = page.getByRole('alertdialog')
  await confirm.getByRole('button', { name: 'Stop repeating' }).click()

  await expect(detail.getByText('One-off')).toBeVisible()
})
