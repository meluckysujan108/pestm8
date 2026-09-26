import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  chooseProperty,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

const DAY = 24 * 60 * 60 * 1000

/** The tenant's own day, not the runner's — as calendar.spec.ts does it. */
function perthDayKey(ts: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
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
    intervalCount: 3,
    intervalUnit: 'month',
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
  // The first visit is the one booked by hand, so it starts `pending` like any
  // other; the engine projects the rest as `recurring` (convex/lib/jobStatus.ts).
  const byDate = [...jobs].sort((a, b) => a.scheduledAt - b.scheduledAt)
  expect(byDate[0].status).toBe('pending')
  expect(byDate.slice(1).every((j) => j.status === 'recurring')).toBe(true)

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
    intervalCount: 1,
    intervalUnit: 'month',
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
    intervalCount: 1,
    intervalUnit: 'month',
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
  // Nothing not-yet-started survives the series ending.
  expect(
    remaining.filter((j) =>
      ['recurring', 'pending', 'booked'].includes(j.status),
    ),
  ).toHaveLength(0)
})

test('a subcontractor cannot set up work on another calendar', async () => {
  const s = await setupBusinessWithSub('recur-scope')

  await expectRejected(
    () =>
      s.sub.client.mutation(api.recurrences.create, {
        businessId: s.businessId,
        propertyId: s.propertyId,
        assignedMembershipId: s.ownerMembershipId,
        intervalCount: 3,
        intervalUnit: 'month',
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
    {
      businessId: s.businessId,
      jobId,
      intervalCount: 1,
      intervalUnit: 'month',
    },
  )

  // Same _id, now attached to the new series — not replaced by a fresh job.
  const converted = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId,
  })
  expect(converted?.recurrence?._id).toBe(recurrenceId)
  expect(converted?.recurrence?.interval).toEqual({ count: 1, unit: 'month' })

  const jobs = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  expect(jobs.every((j) => j.recurrenceId === recurrenceId)).toBe(true)
  // No duplicate booked at the anchor instant itself.
  expect(
    jobs.filter((j) => j.scheduledAt === converted!.scheduledAt),
  ).toHaveLength(1)
  // Future occurrences beyond the anchor were actually generated.
  expect(jobs.length).toBeGreaterThan(1)
})

test('stopping a series from one job preserves that job but cancels its still-booked siblings', async () => {
  const s = await setup('recur-stopjob')

  const recurrenceId = await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.membershipId,
    intervalCount: 1,
    intervalUnit: 'month',
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

  const recurrence = await s.owner.client.query(
    api.recurrences.listForBusiness,
    {
      businessId: s.businessId,
    },
  )
  expect(recurrence.find((r) => r._id === recurrenceId)?.active).toBe(false)

  const remaining = await s.owner.client.query(api.properties.jobHistory, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  const remainingIds = remaining.map((j) => j._id)
  expect(remainingIds).toContain(sorted[0]._id) // completed history, untouched
  expect(remainingIds).toContain(viewedJobId) // the one being viewed, preserved

  // A future sibling is cancelled, not deleted. These were real bookings —
  // someone may have been told about them — so ending the series must leave
  // the owner able to see what was dropped rather than silently erasing rows.
  const futureSibling = remaining.find((j) => j._id === sorted[2]._id)
  expect(futureSibling?.status).toBe('cancelled')

  // It was a projected visit; kept as a one-off, it is an ordinary job again.
  const viewedJob = remaining.find((j) => j._id === viewedJobId)
  expect(viewedJob?.recurrenceId).toBeUndefined()
  expect(viewedJob?.status).toBe('pending')
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
    {
      businessId: s.businessId,
      jobId: subJobId,
      intervalCount: 1,
      intervalUnit: 'month',
    },
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
        intervalCount: 1,
        intervalUnit: 'month',
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
  await chooseProperty(page, sheet, 'Nguyen', /J\. Nguyen/)
  await sheet.getByLabel('Job type').click()
  await page
    .getByRole('button', { name: 'General Pest Control', exact: true })
    .click()
  await sheet.getByRole('radio', { name: 'Recurring Job' }).click()
  await sheet.getByLabel('Repeat every').fill('3')
  await sheet.getByLabel('Repeat unit').selectOption('month')
  await sheet.getByLabel('Start').fill('09:30')
  await sheet.getByLabel('Price (AUD)').fill('220')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  // The FIRST visit is on the schedule because a person booked it: it is
  // `pending`, like any hand-booked job. Its projected siblings are not — the
  // schedule and its counts leave `recurring` out entirely (Phase 3).
  const card = page.getByRole('button', { name: /General Pest Control/ })
  await expect(card).toBeVisible()
  await card.click()

  await expect(page.getByText('Repeats every 3 months')).toBeVisible()
})

test('a custom interval the old fixed list could not express', async ({
  page,
}) => {
  const email = uniqueEmail('recur-custom')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `RecurCustom ${Date.now()}`,
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

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  // Every 2 weeks: a fortnightly rodent program, which the four fixed
  // intervals (monthly/quarterly/sixMonthly/yearly) had no way to book.
  const sheet = page.getByRole('dialog')
  await chooseProperty(page, sheet, 'Nguyen', /J\. Nguyen/)
  await sheet.getByLabel('Job type').click()
  await page.getByRole('button', { name: 'Rodents', exact: true }).click()
  await sheet.getByRole('radio', { name: 'Recurring Job' }).click()
  await sheet.getByLabel('Repeat every').fill('2')
  await sheet.getByLabel('Repeat unit').selectOption('week')
  await sheet.getByLabel('Start').fill('08:00')
  await sheet.getByLabel('Price (AUD)').fill('95')
  await sheet.getByRole('button', { name: 'Book job' }).click()

  const card = page.getByRole('button', { name: /Rodents/ })
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.getByText('Repeats every 2 weeks')).toBeVisible()

  // And the Recurring Job view counts the ARRANGEMENT, not the thirteen
  // visits a fortnightly series projects inside the horizon.
  await page.goto(`/${slug}/job/recurring`)
  await expect(page.getByText('1 Recurring Job', { exact: true })).toBeVisible()
})

test('editing a one-off job into a recurring one, then stopping it, from its own detail sheet', async ({
  page,
}) => {
  const email = uniqueEmail('recur-edit-ui')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `RecurEditUI ${Date.now()}`,
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

  await signInViaUi(page, email)
  await page.goto(`/${slug}/schedule`)

  // Book a plain one-off job (Repeat left at its default "One-off").
  const newJob = page.getByRole('button', { name: 'New job' })
  await expect(newJob).toBeEnabled()
  await newJob.click()

  const newJobSheet = page.getByRole('dialog')
  await chooseProperty(page, newJobSheet, 'Nguyen', /J\. Nguyen/)
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
  await detail.getByRole('radio', { name: 'Recurring Job' }).click()
  await detail.getByLabel('Repeat every').fill('1')
  await detail.getByLabel('Repeat unit').selectOption('month')
  await detail.getByRole('button', { name: 'Save' }).click()

  await expect(detail.getByText('Repeats every month')).toBeVisible()

  // Stop repeating — confirm via the dialog, scoped by its distinct role so
  // it doesn't collide with the trigger button of the same name underneath.
  await detail.getByRole('button', { name: 'Stop repeating' }).click()
  const confirm = page.getByRole('alertdialog')
  await confirm.getByRole('button', { name: 'Stop repeating' }).click()

  await expect(detail.getByText('One-off')).toBeVisible()
})

test('"Make recurring" on a one-off job, from the job detail sheet', async ({
  page,
}) => {
  const email = uniqueEmail('recur-make')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `RecurMake ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const scheduledAt = Date.now() + DAY
  await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: (
      await owner.client.query(api.memberships.listForBusiness, { businessId })
    )[0]._id,
    jobType: 'Termite Inspection',
    price: 45000,
    scheduledAt,
    durationMinutes: 90,
  })

  await signInViaUi(page, email)
  // Open the schedule on the job's own day (`?date=`, as calendar.spec.ts and
  // weather-ui.spec.ts do) rather than on today, since the job is booked for
  // tomorrow. Deliberately WITHOUT `?jobId=`: the detail sheet is a vaul
  // Drawer, and an open Drawer marks the rest of the page `aria-hidden`, so
  // arriving with it already open hides the hydration signal below.
  await page.goto(`/${slug}/schedule?date=${perthDayKey(scheduledAt)}`)

  // "New job" is disabled until hydrated, and a click that lands on
  // server-rendered markup is swallowed silently. Every other test here waits
  // on the same signal.
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  const card = page.getByRole('button', { name: /Termite Inspection/ })
  await expect(card).toBeVisible()
  await card.click()

  // The action lives on the job itself, beside "One-off", rather than only
  // inside the edit form.
  const detail = page.getByRole('dialog')
  await expect(detail.getByText('One-off')).toBeVisible()
  await detail.getByRole('button', { name: 'Make recurring' }).click()

  // A 15-year warranty inspection: no visit is projected at all, because the
  // next one falls far outside the engine's 180-day horizon. The Recurring
  // Job view must still count it as one.
  const recurrenceSetup = page.getByRole('dialog').last()
  await recurrenceSetup.getByLabel('Repeat every').fill('15')
  await recurrenceSetup.getByLabel('Repeat unit').selectOption('year')
  await recurrenceSetup.getByRole('button', { name: 'Make recurring' }).click()

  await expect(page.getByText('Repeats every 15 years')).toBeVisible()

  await page.goto(`/${slug}/job/recurring`)
  await expect(page.getByText('1 Recurring Job', { exact: true })).toBeVisible()
  await expect(page.getByText(/0 visits booked/)).toBeVisible()
})
