import { expect, test } from '@playwright/test'
import {
  api,
  clickUntil,
  openedTabs,
  recordOpenedTabs,
  setupBusinessWithSub,
  signInViaUi,
  touchDown,
  touchHold,
} from './fixtures'

/**
 * The job card: one component on four surfaces, each showing what it should.
 *
 * - Suburb only, on every surface — the Map carries the street address.
 * - The technician's name is off the Schedule, whose side strip already says
 *   whose job it is, and stays on the Job tab, where a list without an
 *   assignee is less use.
 * - Call, Text and Email along the bottom and the Map in the top-right corner
 *   sit BESIDE the button that opens the job, not inside it, and only on
 *   committed work. A projected visit offers the three to book it once its
 *   day has come, and nothing before. The Recurring Job view offers nothing.
 * - All four are holds: a quick tap does nothing, and the Map opens on the
 *   lift after a full hold — the only moment a phone lets a page open a tab.
 * - The top right says how often a recurring job comes round, where the start
 *   time used to be; the time is in the Time row.
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

/** The shared business, plus a client with a number and an address so Call,
 * Text and Email have something to reach — the fixture's own client has
 * neither. */
async function seed(label: string) {
  const s = await setupBusinessWithSub(label)
  const propertyId = await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'M. Roberts',
    phone: '0412 345 678',
    email: 'm.roberts@example.test',
    addressLine: '7 Banksia Road',
    suburb: 'Morley',
    state: 'WA',
    postcode: '6062',
  })
  return { ...s, propertyId }
}

const CALL = 'Call M. Roberts'
const TEXT = 'Text M. Roberts'
const EMAIL = 'Email M. Roberts'
const MAP = 'Map of 7 Banksia Road, Morley'
const MAP_URL =
  'https://www.google.com/maps/search/?api=1&query=7%20Banksia%20Road%2C%20Morley%2C%206062%2C%20Australia'

/** Kevin's one-off job tomorrow, on the shared client. */
async function bookSpiderTreatment(s: Awaited<ReturnType<typeof seed>>) {
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
  return at
}

test('on the Schedule a card shows the suburb, Call, Text, Email and Map, and not the technician', async ({
  page,
}) => {
  const s = await seed('card-schedule')
  // Kevin's job, seen by the owner in the default everyone view — the case
  // where the name USED to show, since only "Just my jobs" hid it.
  const at = await bookSpiderTreatment(s)

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${perthDayKey(at)}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  const card = page.getByRole('button', { name: /Spider Treatment/ })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Morley')
  await expect(card).not.toContainText('7 Banksia Road')
  // No Technician row: its label and the name as they show on screen...
  await expect(card.getByText('Technician', { exact: true })).toHaveCount(0)
  await expect(card.getByText('Kevin', { exact: true })).toHaveCount(0)
  // ...while a screen reader, which cannot see the rail's colour, is still
  // told whose job it is (Phase 4.3).
  await expect(card.getByText('Technician: Kevin')).toHaveCount(1)

  // Beside the card's own button, as real controls of their own: all four
  // holds, none a link.
  const call = page.getByRole('button', { name: CALL })
  const map = page.getByRole('button', { name: MAP })
  for (const name of [CALL, TEXT, EMAIL, MAP]) {
    await expect(page.getByRole('button', { name })).toBeVisible()
  }
  await expect(page.getByRole('link', { name: /Map of/ })).toHaveCount(0)
  // No series, so no indicator in the corner where the time used to be.
  await expect(card).not.toContainText('Every ')

  // The Map in the top right, level with the suburb and above the row of
  // contact buttons.
  const mapBox = (await map.boundingBox())!
  const suburbBox = (await card
    .getByText('Morley', { exact: true })
    .boundingBox())!
  const callBox = (await call.boundingBox())!
  const cardBox = (await card.boundingBox())!
  const suburbMiddle = suburbBox.y + suburbBox.height / 2
  expect(suburbMiddle).toBeGreaterThan(mapBox.y)
  expect(suburbMiddle).toBeLessThan(mapBox.y + mapBox.height)
  expect(mapBox.x).toBeGreaterThan(suburbBox.x + suburbBox.width)
  expect(mapBox.x + mapBox.width).toBeGreaterThan(
    cardBox.x + cardBox.width - 40,
  )
  expect(mapBox.y + mapBox.height).toBeLessThan(callBox.y)

  // And the card body still opens the job. Settled on the sheet itself,
  // which appears the moment the click lands; what it shows waits on a query.
  const detail = page.getByRole('dialog')
  await clickUntil(card, () => expect(detail).toBeVisible({ timeout: 2_000 }))
  await expect(detail.getByText('Property', { exact: true })).toBeVisible()
})

test('the Job tab keeps the technician, with Call, Text, Email and Map', async ({
  page,
}) => {
  const s = await seed('card-jobtab')
  await bookSpiderTreatment(s)

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/job`)

  const card = page.getByRole('button', { name: /Spider Treatment/ })
  await expect(card).toBeVisible()
  // The visible row, not the screen-reader line the Schedule card keeps in
  // its place — which would also contain "Technician".
  await expect(card.getByText('Technician', { exact: true })).toBeVisible()
  await expect(card.getByText('Technician: Kevin')).toHaveCount(0)
  await expect(card).toContainText('Kevin')
  await expect(card).toContainText('Morley')
  await expect(card).not.toContainText('7 Banksia Road')
  for (const name of [CALL, TEXT, EMAIL, MAP]) {
    await expect(page.getByRole('button', { name })).toBeVisible()
  }
})

test('a series: the Job tab lists the hand-booked visit, with its buttons and how often it repeats, and the Recurring Job view its projections, with no buttons', async ({
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

  // Only the first visit, the one somebody booked, is booked work: the
  // projections after it are listed on the Recurring Job view instead.
  const cards = page.getByRole('button', { name: /Rodent Baiting/ })
  await expect(cards.first()).toBeVisible()
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Every month')
  for (const name of [CALL, TEXT, EMAIL, MAP]) {
    await expect(page.getByRole('button', { name })).toHaveCount(1)
  }

  // At least one projection inside the horizon, and none of them can be
  // called about or driven to.
  await page.goto(`/${s.slug}/job/recurring`)
  await expect(
    page.getByRole('button', { name: /Rodent Baiting/ }).first(),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Rodent Baiting/ }).first(),
  ).toContainText('Every month')
  await expect(
    page.getByRole('button', { name: /^(Call|Text|Email|Map of) / }),
  ).toHaveCount(0)
})

test('a projection due today offers Call, Text and Email to book it, and no map', async ({
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

  await expect(card).toContainText('Every day')

  // Each says what it is for, to a screen reader and to voice control; the
  // card says it once, above the row, where three would not fit.
  for (const verb of ['Call', 'Text', 'Email']) {
    const button = page.getByRole('button', {
      name: `${verb} to book: M. Roberts`,
    })
    await expect(button).toBeVisible()
    await expect(button).toContainText(verb)
  }
  await expect(page.getByText('Not booked yet — contact to book')).toBeVisible()
  // Nobody has agreed to it, so there is nowhere to drive yet.
  await expect(page.getByRole('button', { name: MAP })).toHaveCount(0)

  // The same visit on the Recurring Job view offers nothing at all. This is
  // the case that proves the view's own rule: on a future projection the
  // status alone would already offer nothing.
  await page.goto(`/${s.slug}/job/recurring`)
  await expect(
    page.getByRole('button', { name: /Cockroach Treatment/ }).first(),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^(Call|Text|Email|Map of) / }),
  ).toHaveCount(0)
})

/**
 * The hold, with a real finger. The Map is the button that proves the design:
 * it opens a tab, which a phone allows only from the lift of a finger — so a
 * Map that acted when the fill completed, with the finger still down, would
 * be popup-blocked on a real phone and look fine here. Hence recording
 * whether the browser counted the moment as the user's.
 */
test('the Map opens only on the lift after a full hold, as the user’s own gesture', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.use.hasTouch,
    'a touch device: the desktop click is below',
  )
  const s = await seed('card-hold')
  const at = await bookSpiderTreatment(s)

  await recordOpenedTabs(page)
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${perthDayKey(at)}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  const map = page.getByRole('button', { name: MAP })
  await expect(map).toBeVisible()

  // A brush of a thumb: nothing opens, and the button's own label says to
  // hold it (the label, not the screen-reader status beside the button).
  await touchHold(page, map, 60)
  await expect(map).toContainText('Hold')
  await expect(map).not.toContainText('Map')
  expect(await openedTabs(page)).toEqual([])

  // A fresh page, so that tap's gesture is not still live: the browser keeps
  // a gesture for a few seconds, and a Map that opened mid-hold would borrow
  // it here and pass. On a phone nothing would lend it one.
  await page.reload()
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await expect(map).toBeVisible()

  // Held well past the fill, finger still down: nothing yet.
  const finger = await touchDown(page, map)
  await page.waitForTimeout(900)
  expect(await openedTabs(page)).toEqual([])

  // Lifted: the map, once, from a gesture the browser counts.
  await finger.up()
  await expect.poll(() => openedTabs(page)).toHaveLength(1)
  expect(await openedTabs(page)).toEqual([{ url: MAP_URL, active: true }])
})

test('a mouse click opens the map at once — a desktop click is deliberate', async ({
  page,
}, testInfo) => {
  test.skip(
    Boolean(testInfo.project.use.hasTouch),
    'a desktop: the touch hold is above',
  )
  const s = await seed('card-click')
  const at = await bookSpiderTreatment(s)

  await recordOpenedTabs(page)
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule?date=${perthDayKey(at)}`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()

  await page.getByRole('button', { name: MAP }).click()
  await expect.poll(() => openedTabs(page)).toHaveLength(1)
  expect(await openedTabs(page)).toEqual([{ url: MAP_URL, active: true }])
})
