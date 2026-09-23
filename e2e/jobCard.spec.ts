import { expect, test } from '@playwright/test'
import { api, clickUntil, setupBusinessWithSub, signInViaUi } from './fixtures'

/**
 * The job card (Phase 4.1): one component on four surfaces, each showing what
 * it should.
 *
 * - Suburb only, on every surface — the Map button carries the street address.
 * - The technician's name is off the Schedule, whose side strip already says
 *   whose job it is, and stays on the Job tab, where a list without an
 *   assignee is less use.
 * - Call and Map sit BESIDE the button that opens the job, not inside it, and
 *   only on committed work. A projected visit offers a call to book it once
 *   its day has come, and nothing before. The Recurring Job view offers
 *   nothing at all.
 */

const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

function perthDayKey(ts: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts))
}

/** The shared business, plus a client with a number so Call has something
 * to dial — the fixture's own client has none. */
async function seed(label: string) {
  const s = await setupBusinessWithSub(label)
  const propertyId = await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'M. Roberts',
    phone: '0412 345 678',
    addressLine: '7 Banksia Road',
    suburb: 'Morley',
    state: 'WA',
    postcode: '6062',
  })
  return { ...s, propertyId }
}

const CALL = 'Call M. Roberts'
const MAP = 'Open 7 Banksia Road, Morley in Maps'

test('on the Schedule a card shows the suburb, Call and Map, and not the technician', async ({
  page,
}) => {
  const s = await seed('card-schedule')
  // Kevin's job, seen by the owner in the default everyone view — the case
  // where the name USED to show, since only "Just my jobs" hid it.
  const at = Date.now() + DAY
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'Spider Treatment',
    price: 18000,
    scheduledAt: at,
    durationMinutes: 45,
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${perthDayKey(at)}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  const card = page.getByRole('button', { name: /Spider Treatment/ })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Morley')
  await expect(card).not.toContainText('7 Banksia Road')
  await expect(card).not.toContainText('Technician')
  await expect(card).not.toContainText('Kevin')

  // Beside the card's own button, as real controls of their own.
  await expect(page.getByRole('button', { name: CALL })).toBeVisible()
  const map = page.getByRole('link', { name: MAP })
  await expect(map).toBeVisible()
  await expect(map).toHaveAttribute('target', '_blank')
  await expect(map).toHaveAttribute(
    'href',
    'https://www.google.com/maps/search/?api=1&query=7%20Banksia%20Road%2C%20Morley%2C%206062%2C%20Australia',
  )

  // And the card body still opens the job.
  await clickUntil(card, () =>
    expect(page.getByRole('dialog').getByText('Property')).toBeVisible({
      timeout: 2_000,
    }),
  )
})

test('the Job tab keeps the technician, with Call and Map', async ({
  page,
}) => {
  const s = await seed('card-jobtab')
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.subMembershipId,
    jobType: 'Spider Treatment',
    price: 18000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 45,
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job`)

  const card = page.getByRole('button', { name: /Spider Treatment/ })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Technician')
  await expect(card).toContainText('Kevin')
  await expect(card).toContainText('Morley')
  await expect(card).not.toContainText('7 Banksia Road')
  await expect(page.getByRole('button', { name: CALL })).toBeVisible()
  await expect(page.getByRole('link', { name: MAP })).toBeVisible()
})

test('a series: the hand-booked visit offers Call and Map, its future projections nothing, and the Recurring Job view nothing', async ({
  page,
}) => {
  const s = await seed('card-series')
  await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    intervalCount: 1,
    intervalUnit: 'month',
    jobType: 'Rodent Baiting',
    price: 16000,
    anchorDate: Date.now() + DAY,
    durationMinutes: 45,
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job`)

  // The first visit plus at least one projection inside the horizon — and
  // only the first, the one somebody booked, can be called about or driven to.
  const cards = page.getByRole('button', { name: /Rodent Baiting/ })
  await expect(cards.nth(1)).toBeVisible()
  await expect(page.getByRole('button', { name: CALL })).toHaveCount(1)
  await expect(page.getByRole('link', { name: MAP })).toHaveCount(1)

  await page.goto(`/${s.slug}/job/recurring`)
  await expect(
    page.getByRole('button', { name: /Rodent Baiting/ }).first(),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /^Call / })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /in Maps$/ })).toHaveCount(0)
})

test('a projection due today offers a call to book it, and no map', async ({
  page,
}) => {
  // A daily series anchored just under a day ago: the first visit is
  // yesterday's, booked by hand, and the next is projected for five minutes
  // from now — today's, and still `recurring`. Five minutes before midnight
  // Perth it would be tomorrow's instead, and the premise would not hold.
  const now = Date.now()
  test.skip(
    perthDayKey(now + 5 * MINUTE) !== perthDayKey(now),
    'the projection would fall on tomorrow',
  )

  const s = await seed('card-book')
  await s.owner.client.mutation(api.recurrences.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    intervalCount: 1,
    intervalUnit: 'day',
    jobType: 'Cockroach Treatment',
    price: 14000,
    anchorDate: now - DAY + 5 * MINUTE,
    durationMinutes: 45,
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${perthDayKey(now)}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  const card = page.getByRole('button', { name: /Cockroach Treatment/ })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Recurring')

  const book = page.getByRole('button', {
    name: 'Call M. Roberts to book this visit',
  })
  await expect(book).toBeVisible()
  await expect(book).toContainText('Call to book')
  // Nobody has agreed to it, so there is nowhere to drive yet.
  await expect(page.getByRole('link', { name: MAP })).toHaveCount(0)
})
