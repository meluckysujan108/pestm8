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
  await sheet.getByLabel('Job type').selectOption('General Pest Control')
  await sheet.getByLabel('Repeat').selectOption('quarterly')
  await sheet.getByLabel('Start').fill('09:30')
  await sheet.getByLabel('Price (AUD)').fill('220')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  const card = page.getByRole('button', { name: /General Pest Control/ })
  await expect(card).toBeVisible()
  await card.click()

  await expect(page.getByText('Repeats quarterly')).toBeVisible()
})
