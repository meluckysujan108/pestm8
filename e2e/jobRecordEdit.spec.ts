import { expect, test } from '@playwright/test'
import {
  EDIT_TRIGGER,
  api,
  clickUntil,
  openEdit,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'
import { editSaveWaits } from '../src/lib/editSaveWaits'
import type { Page } from '@playwright/test'

/**
 * A job's client and property, put right from the job (asked for 4 Nov
 * 2026: "edit customer info from the job card itself"). Edit asks what: the
 * job, its client or its property. The client's and the property's forms
 * are the client sheet's own, and Save or Cancel comes back to the job.
 *
 * Seen as Kevin, a subcontractor also going on the owner's job: the
 * technician at the door is who this is for.
 */

const DAY = 24 * 60 * 60 * 1000

function perthDayKey(ts: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
  }).format(new Date(ts))
}

/** The fixture business, with Kevin also going on the owner's job at J.
 * Nguyen's, 12 Wattle Street. `at` is the job's own time, which says its
 * day: a fresh `Date.now()` could fall after Perth's midnight. */
async function kevinOnTheJob(label: string) {
  const s = await setupBusinessWithSub(label)
  await s.owner.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    alsoGoing: [s.subMembershipId],
  })
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  const clientId = job!.property!.client!._id
  const client = () =>
    s.owner.client.query(api.clients.get, {
      businessId: s.businessId,
      clientId,
    })
  return { ...s, clientId, client, at: job!.scheduledAt }
}

/**
 * The live job sheet: not the job as its day lists it, which the sheet
 * shows when `jobs.get` is slow (with Property but no Notes, and no Edit).
 */
async function openLiveJob(
  page: Page,
  slug: string,
  at: number,
  name: RegExp = /Termite Inspection/,
  { everyone = false } = {},
) {
  await page.goto(`/${slug}/schedule?date=${perthDayKey(at)}`)
  // The phone opens on his own jobs, which a colleague's isn't one of.
  if (everyone && (page.viewportSize()?.width ?? 1280) < 1024) {
    await clickUntil(
      page.getByRole('button', { name: 'Clear filters' }).first(),
      () =>
        expect(page.getByRole('button', { name }).first()).toBeVisible({
          timeout: 3_000,
        }),
    )
  }
  const sheet = page.getByRole('dialog')
  await clickUntil(page.getByRole('button', { name }).first(), () =>
    expect(
      sheet.getByRole('heading', { name: 'Property', exact: true }),
    ).toBeVisible({ timeout: 3_000 }),
  )
  await expect(
    sheet.getByRole('heading', { name: 'Notes', exact: true }),
  ).toBeVisible()
  return sheet
}

const discard = (page: Page) =>
  page.getByRole('alertdialog').filter({ hasText: 'Discard your changes?' })

const chooser = (page: Page) =>
  page.getByRole('dialog', { name: 'Edit', exact: true })

/** Gone from the page, not just hidden while it slides away. */
async function chooserGone(page: Page) {
  await expect(
    page.locator('[role="dialog"]').filter({
      has: page.locator('h2', { hasText: /^Edit$/ }),
    }),
  ).toHaveCount(0)
}

test('Kevin puts the client’s new mobile and email right from the job', async ({
  page,
}) => {
  const s = await kevinOnTheJob('edit-client')
  await signInViaUi(page, s.sub.email)
  const sheet = await openLiveJob(page, s.slug, s.at)
  await expect(
    sheet.getByRole('button', { name: 'Call J. Nguyen' }),
  ).toHaveCount(0)

  await openEdit(page, sheet, 'client')
  await expect(sheet.getByText(/^Editing client/)).toBeVisible()
  await expect(
    sheet.getByText(
      'Changes J. Nguyen on all their jobs, not just this one. Finalised reports keep what they printed.',
    ),
  ).toBeVisible()
  // The number is the owner's to change: shown, never a field.
  await expect(
    sheet.getByRole('textbox', { name: 'Client number' }),
  ).toHaveCount(0)
  await sheet.getByLabel('Phone (optional)').fill('0412 345 678')
  await sheet.getByLabel('Email (optional)').fill('jan.nguyen@outlook.com')
  await sheet.getByRole('button', { name: 'Save' }).click()

  // Back on the job, which already has it.
  await expect(sheet.getByText(/^Editing client/)).toHaveCount(0)
  await expect(
    sheet.getByRole('button', { name: 'Call J. Nguyen' }),
  ).toBeVisible()
  await expect.poll(async () => (await s.client())?.phone).toBe('0412 345 678')
  expect((await s.client())?.email).toBe('jan.nguyen@outlook.com')
})

test('the office changes the name and email while Kevin’s form is open; his new phone doesn’t put the old ones back', async ({
  page,
}) => {
  const s = await kevinOnTheJob('edit-client-race')
  await s.owner.client.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId: s.clientId,
    email: 'jan@nguyen.test',
  })
  await signInViaUi(page, s.sub.email)
  const sheet = await openLiveJob(page, s.slug, s.at)

  await openEdit(page, sheet, 'client')
  await expect(sheet.getByLabel('Email (optional)')).toHaveValue(
    'jan@nguyen.test',
  )
  await sheet.getByLabel('Phone (optional)').fill('0412 345 678')
  await s.owner.client.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId: s.clientId,
    name: 'Jenny Nguyen',
    email: 'accounts@nguyen.test',
  })
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet.getByText(/^Editing client/)).toHaveCount(0)

  await expect.poll(async () => (await s.client())?.phone).toBe('0412 345 678')
  expect(await s.client()).toMatchObject({
    name: 'Jenny Nguyen',
    email: 'accounts@nguyen.test',
  })
})

test('a homeowner made a business from the job: their hidden contact person is back in the field', async ({
  page,
}) => {
  const s = await kevinOnTheJob('edit-client-contact')
  // Once a business with Jan Morris as its contact person, now a homeowner:
  // Jan is hidden, not gone, and the job has no contact person.
  await s.owner.client.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId: s.clientId,
    kind: 'business',
    contactPerson: 'Jan Morris',
  })
  await s.owner.client.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId: s.clientId,
    kind: 'person',
  })
  await signInViaUi(page, s.sub.email)
  const sheet = await openLiveJob(page, s.slug, s.at)

  await openEdit(page, sheet, 'client')
  await sheet.getByRole('radio', { name: 'Commercial' }).click()
  await expect(sheet.getByLabel('Contact person (optional)')).toHaveValue(
    'Jan Morris',
  )
  // Typed over, the line says what becomes of Jan.
  await sheet.getByLabel('Contact person (optional)').fill('Priya Shah')
  await expect(
    sheet.getByText(
      'Priya Shah becomes the contact person. Jan Morris stays in Contacts.',
    ),
  ).toBeVisible()
})

test('Kevin corrects the address, and the job follows', async ({ page }) => {
  const s = await kevinOnTheJob('edit-property')
  await signInViaUi(page, s.sub.email)
  const sheet = await openLiveJob(page, s.slug, s.at)

  await openEdit(page, sheet, 'property')
  await expect(sheet.getByText('Editing property')).toBeVisible()
  await expect(
    sheet.getByText(
      'Gate codes, keys and dogs go in a site note, under Notes, so they show before every visit here.',
    ),
  ).toBeVisible()
  // A homeowner's property has no site contact.
  await expect(sheet.getByLabel('Site contact name (optional)')).toHaveCount(0)
  await sheet
    .getByLabel('Street address', { exact: true })
    .fill('12A Wattle Street')
  await sheet.getByRole('button', { name: 'Save' }).click()

  await expect(sheet.getByText('Editing property')).toHaveCount(0)
  await expect(sheet.getByText('12A Wattle Street').first()).toBeVisible()
  await expect
    .poll(
      async () =>
        (
          await s.owner.client.query(api.jobs.get, {
            businessId: s.businessId,
            jobId: s.ownerJobId,
          })
        )?.property?.addressLine,
    )
    .toBe('12A Wattle Street')
})

test('a business site’s new manager, from the job', async ({ page }) => {
  const s = await setupBusinessWithSub('edit-site-contact')
  const propertyId = await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: 'Mahal Mart',
    kind: 'business',
    phone: '08 9000 1111',
    addressLine: '14 Kewdale Road',
    suburb: 'Kewdale',
    state: 'WA',
    postcode: '6105',
    siteContactName: 'Jan Morris',
    siteContactPhone: '0412 000 111',
  })
  const at = Date.now() + DAY
  await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId,
    assignedMembershipId: s.ownerMembershipId,
    alsoGoing: [s.subMembershipId],
    jobType: 'Cockroach Treatment',
    price: 22000,
    scheduledAt: at,
    durationMinutes: 60,
  })
  await signInViaUi(page, s.sub.email)
  const sheet = await openLiveJob(page, s.slug, at, /Cockroach Treatment/)

  await openEdit(page, sheet, 'property')
  await sheet.getByLabel('Site contact name (optional)').fill('Priya Shah')
  await sheet.getByLabel('Site contact number (optional)').fill('0412 000 222')
  await sheet.getByRole('button', { name: 'Save' }).click()

  await expect(sheet.getByText('Editing property')).toHaveCount(0)
  await expect(
    sheet.getByRole('button', { name: 'Call Priya Shah' }),
  ).toBeVisible()
  const property = await s.owner.client.query(api.properties.get, {
    businessId: s.businessId,
    propertyId,
  })
  expect(property).toMatchObject({
    siteContactName: 'Priya Shah',
    siteContactPhone: '0412 000 222',
  })
})

test('the rows say what each changes, and Done goes back to Edit', async ({
  page,
}) => {
  const s = await kevinOnTheJob('edit-rows')
  await signInViaUi(page, s.sub.email)
  const sheet = await openLiveJob(page, s.slug, s.at)
  const edit = sheet.getByRole('button', { name: EDIT_TRIGGER })
  await expect(edit).toHaveAccessibleName('Edit job, client or property')

  await edit.click()
  const rows = chooser(page)
  await expect(
    rows.getByRole('button', { name: /^Job details/ }),
  ).toContainText('— this job.')
  await expect(
    rows.getByRole('button', { name: /^Client details/ }),
  ).toContainText('Name, phone and email — on all of J. Nguyen’s jobs.')
  await expect(
    rows.getByRole('button', { name: /^Property details/ }),
  ).toContainText('Correct the address — on every job at 12 Wattle Street.')
  await rows.getByRole('button', { name: 'Done', exact: true }).click()
  await chooserGone(page)
  await expect(edit).toBeFocused()

  // Once a row has been chosen, left with Cancel, and Edit opened again,
  // Done still goes back to Edit (not to the form's title, long gone).
  await openEdit(page, sheet, 'client')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(edit).toBeFocused()
  await edit.click()
  await chooser(page).getByRole('button', { name: 'Done', exact: true }).click()
  await chooserGone(page)
  await expect(edit).toBeFocused()
})

test('a row puts focus on its form’s title', async ({ page }) => {
  const s = await kevinOnTheJob('edit-focus')
  await signInViaUi(page, s.sub.email)
  const sheet = await openLiveJob(page, s.slug, s.at)

  await openEdit(page, sheet, 'client')
  await expect(
    sheet.getByRole('heading', { name: 'J. Nguyen', exact: true }),
  ).toBeFocused()
})

test('no Edit on a colleague’s job Kevin may only read', async ({ page }) => {
  const s = await setupBusinessWithSub('edit-colleague')
  // He sees every job, and this one isn't his.
  await s.owner.client.mutation(api.memberships.setCanViewAllJobs, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    canViewAllJobs: true,
  })
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  await signInViaUi(page, s.sub.email)
  const sheet = await openLiveJob(page, s.slug, job!.scheduledAt, undefined, {
    everyone: true,
  })

  await expect(
    sheet.getByText(
      'This job is assigned to someone else, so it is read-only.',
    ),
  ).toBeVisible()
  await expect(sheet.getByRole('button', { name: EDIT_TRIGGER })).toHaveCount(0)
})

test('with no signal, the new number waits and says so, and ✕ closes without asking', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the line, not the layout')
  const s = await kevinOnTheJob('edit-no-signal')
  await signInViaUi(page, s.sub.email)
  const sheet = await openLiveJob(page, s.slug, s.at)
  await openEdit(page, sheet, 'client')

  await context.setOffline(true)
  try {
    await expect(
      sheet.getByText(editSaveWaits('client')['no-signal']),
    ).toBeVisible()
    await sheet.getByLabel('Phone (optional)').fill('0412 345 678')
    await sheet.getByRole('button', { name: 'Save' }).click()
    await expect(sheet.getByRole('button', { name: 'Saving…' })).toBeVisible()
    // "Discard your changes?" would be false: the save still lands.
    await sheet.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(discard(page)).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
  await expect
    .poll(async () => (await s.client())?.phone, { timeout: 30_000 })
    .toBe('0412 345 678')
})
