import { expect, test } from '@playwright/test'
import {
  api,
  clickUntil,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'
import { samplePdf } from './fixtures/pdf'
import { solidPng } from './fixtures/png'
import type { Page } from '@playwright/test'
import type { Actor } from './fixtures'
import type { Id } from '../convex/_generated/dataModel'

/**
 * My licences: every licence a person holds — a name they choose, a number,
 * an expiry, and up to six files — apart from the licence number printed on
 * their reports, which stays where it was.
 *
 * The holder adds and changes their own; the owner reads anyone's, and
 * changes nothing; nobody else sees them at all. The whole wallet is kept on
 * the holder's phone as soon as the list answers, so it opens on site with
 * no signal.
 */

/** An upload, the list catching up with it, and a cold viewer chunk. */
const SAVE_TIMEOUT = 30_000
const VIEWER_TIMEOUT = 30_000

/**
 * A date `days` from today where the fixture's business is (Perth), as an
 * `<input type="date">` gives it — the day every expiry is counted from.
 */
function perthDay(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const [year, month, day] = today.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10)
}

/** What an upload URL answers, which is the only way to get a storage id. */
async function upload(
  actor: Actor,
  businessId: Id<'businesses'>,
  body: Buffer,
  contentType: string,
): Promise<Id<'_storage'>> {
  const uploadUrl = await actor.client.mutation(
    api.memberLicences.generateUploadUrl,
    { businessId },
  )
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: new Uint8Array(body),
  })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
  const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
  return storageId
}

/**
 * A licence added through the API, for the tests whose subject is something
 * other than the form. The form itself is driven for real in the first test.
 */
async function addLicence(
  actor: Actor,
  businessId: Id<'businesses'>,
  licence: {
    name: string
    number?: string
    expiresOn?: string
    files?: Array<{ name: string; type: string; body: Buffer }>
  },
): Promise<Id<'memberLicences'>> {
  const licenceId = await actor.client.mutation(api.memberLicences.create, {
    businessId,
    name: licence.name,
    number: licence.number,
    expiresOn: licence.expiresOn,
  })
  for (const file of licence.files ?? []) {
    await actor.client.mutation(api.memberLicences.addFile, {
      businessId,
      licenceId,
      storageId: await upload(actor, businessId, file.body, file.type),
      fileName: file.name,
    })
  }
  return licenceId
}

async function listOf(
  actor: Actor,
  businessId: Id<'businesses'>,
  membershipId: Id<'memberships'>,
) {
  return actor.client.query(api.memberLicences.list, {
    businessId,
    membershipId,
  })
}

/** "Add photo or PDF", and the file picker it opens, given `file`. */
async function addFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const add = page.getByRole('button', { name: /^Add photo or PDF/ })
  await expect(add).toBeEnabled()
  const chooser = page.waitForEvent('filechooser')
  await add.click()
  await (await chooser).setFiles(file)
}

test('a technician adds a licence from a suggestion, and the list and the hub say it runs out soon', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('licences-add')
  await signInViaUi(page, s.sub.email)

  await page.goto(`/${s.slug}/settings/licence`)
  await expect(
    page.getByRole('heading', { name: 'Licences', level: 1 }),
  ).toBeVisible()
  // The number on reports is where it was, and apart.
  await expect(page.getByText('On your reports')).toBeVisible()
  await expect(page.getByText('My licences')).toBeVisible()

  await page.getByRole('link', { name: 'Add licence' }).click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings/licence/new$`))
  await expect(
    page.getByRole('heading', { name: 'Add licence', level: 1 }),
  ).toBeVisible()

  // A suggestion fills the name in one tap; it can still be anything.
  const suggestion = page
    .getByRole('group', { name: 'Suggested names' })
    .getByRole('button', { name: 'Pest management licence' })
  await expect(suggestion).toBeEnabled()
  await suggestion.click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Pest management licence',
  )
  // Gone once there is a name.
  await expect(
    page.getByRole('group', { name: 'Suggested names' }),
  ).toHaveCount(0)
  await page.getByLabel('Number (optional)').fill('PMT-4471')
  const expiresOn = perthDay(30)
  await page.getByLabel('Expires (optional)').fill(expiresOn)
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  // Onto the licence's own page, which says what comes next.
  await expect(page).toHaveURL(
    new RegExp(`/${s.slug}/settings/licence/[^/?]+\\?added=true$`),
    { timeout: SAVE_TIMEOUT },
  )
  await expect(
    page.getByRole('heading', { name: 'Pest management licence', level: 1 }),
  ).toBeVisible()
  await expect(
    page.getByText('Added. Now add a photo or PDF of it.'),
  ).toBeVisible()

  const { licences } = await listOf(s.sub, s.businessId, s.subMembershipId)
  expect(licences).toEqual([
    expect.objectContaining({
      name: 'Pest management licence',
      number: 'PMT-4471',
      expiresOn,
      files: [],
    }),
  ])

  // The list: its number and expiry, and amber at thirty days out.
  await page.getByRole('link', { name: 'Licences', exact: true }).click()
  const row = page.getByRole('link', { name: /^Pest management licence/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText('PMT-4471 · Expires')
  await expect(row).toContainText('30 days')

  // And the hub's row says so — the report number is set, so it is the
  // expiry that shows.
  await page.goto(`/${s.slug}/settings`)
  const hubRow = page.getByRole('main').getByRole('link', { name: /^Licences/ })
  await expect(hubRow).toContainText('TECH-8821')
  await expect(hubRow).toContainText('Expiring')
})

test('a technician adds a PDF and a photo, reads them in the viewer, renames the licence, takes a file off and deletes it', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('licences-files')
  const licenceId = await addLicence(s.sub, s.businessId, {
    name: 'White card',
  })
  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/settings/licence/${licenceId}`)
  await expect(
    page.getByRole('heading', { name: 'White card', level: 1 }),
  ).toBeVisible()

  // ── Two files, saved as they are picked ─────────────────────────────────
  await addFile(page, {
    name: 'White card certificate.pdf',
    mimeType: 'application/pdf',
    buffer: samplePdf({ pages: 1 }),
  })
  const certificate = page.getByRole('button', {
    name: /^White card certificate\.pdf/,
  })
  await expect(certificate).toBeVisible({ timeout: SAVE_TIMEOUT })

  // A photo is made smaller, as a JPEG, before it goes up.
  await addFile(page, {
    name: 'Card front.png',
    mimeType: 'image/png',
    buffer: solidPng(900, 560),
  })
  const front = page.getByRole('button', { name: /^Card front\.(jpg|png)/ })
  await expect(front).toBeVisible({ timeout: SAVE_TIMEOUT })

  let [licence] = (await listOf(s.sub, s.businessId, s.subMembershipId))
    .licences
  expect(licence.files.map((file) => file.kind)).toEqual(['pdf', 'image'])

  // ── The viewer opens at the file tapped, and steps between them ─────────
  await certificate.click()
  const pdfViewer = page.getByRole('dialog', { name: 'White card PDF' })
  await expect(pdfViewer).toBeVisible()
  await expect(pdfViewer.getByText('File 1 of 2')).toBeVisible()
  await expect(pdfViewer.getByText('1 page', { exact: true })).toBeVisible({
    timeout: VIEWER_TIMEOUT,
  })
  await pdfViewer.getByRole('button', { name: 'Next file' }).click()

  const photoViewer = page.getByRole('dialog', {
    name: 'White card',
    exact: true,
  })
  await expect(photoViewer).toBeVisible()
  await expect(photoViewer.getByText('File 2 of 2')).toBeVisible()
  await expect(
    photoViewer.getByRole('img', { name: 'White card' }),
  ).toBeVisible({ timeout: VIEWER_TIMEOUT })
  await expect(
    photoViewer.getByRole('button', { name: 'Next file' }),
  ).toBeDisabled()
  await photoViewer.getByRole('button', { name: 'Previous file' }).click()
  await expect(pdfViewer).toBeVisible()
  await pdfViewer.getByRole('button', { name: 'Done' }).click()
  await expect(pdfViewer).toBeHidden()

  // ── Renamed, with one Save ───────────────────────────────────────────────
  await page
    .getByLabel('Name', { exact: true })
    .fill('White card (construction)')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByRole('heading', {
      name: 'White card (construction)',
      level: 1,
    }),
  ).toBeVisible({ timeout: SAVE_TIMEOUT })
  ;[licence] = (await listOf(s.sub, s.businessId, s.subMembershipId)).licences
  expect(licence.name).toBe('White card (construction)')

  // ── A file taken off, after saying so ───────────────────────────────────
  await page.getByRole('button', { name: /^Remove Card front/ }).click()
  const confirmRemove = page.getByRole('alertdialog', {
    name: /^Remove Card front/,
  })
  await expect(confirmRemove).toBeVisible()
  await confirmRemove
    .getByRole('button', { name: 'Remove', exact: true })
    .click()
  await expect(front).toHaveCount(0, { timeout: SAVE_TIMEOUT })
  await expect(certificate).toBeVisible()
  ;[licence] = (await listOf(s.sub, s.businessId, s.subMembershipId)).licences
  expect(licence.files.map((file) => file.fileName)).toEqual([
    'White card certificate.pdf',
  ])

  // ── And the licence deleted, back to the list ───────────────────────────
  await page.getByRole('button', { name: 'Delete licence' }).click()
  const confirmDelete = page.getByRole('alertdialog', {
    name: 'Delete White card (construction)?',
  })
  await confirmDelete
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings/licence$`), {
    timeout: SAVE_TIMEOUT,
  })
  await expect(page.getByRole('link', { name: /White card/ })).toHaveCount(0)
  expect(
    (await listOf(s.sub, s.businessId, s.subMembershipId)).licences,
  ).toEqual([])
})

test('the owner reads a subcontractor’s licences on their Team page, and can change nothing', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('licences-owner')
  const licenceId = await addLicence(s.sub, s.businessId, {
    name: 'Fumigation licence',
    number: 'FUM-77',
    expiresOn: perthDay(-3),
    files: [
      { name: 'Fumigation.png', type: 'image/png', body: solidPng(40, 30) },
    ],
  })

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/settings/team/${s.subMembershipId}`)
  await expect(
    page.getByRole('heading', { name: 'Kevin', level: 1 }),
  ).toBeVisible()

  // The report number, as it was.
  await expect(page.getByLabel('Licence number')).toHaveValue('TECH-8821')

  const row = page.getByRole('button', { name: /^Fumigation licence/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText('FUM-77')
  await expect(row).toContainText('Expired')

  // Nothing to change them with.
  await expect(
    page.getByRole('button', { name: /^Add photo or PDF/ }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Delete licence' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /^Remove Fumigation/ }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: /^Fumigation licence/ }),
  ).toHaveCount(0)

  // Read in the app, with no Share.
  await expect(row).toBeEnabled()
  await row.click()
  const viewer = page.getByRole('dialog', {
    name: 'Kevin — Fumigation licence',
    exact: true,
  })
  await expect(viewer).toBeVisible()
  await expect(
    viewer.getByRole('img', { name: 'Kevin — Fumigation licence' }),
  ).toBeVisible({
    timeout: VIEWER_TIMEOUT,
  })
  await expect(viewer.getByRole('button', { name: 'Share' })).toHaveCount(0)
  await viewer.getByRole('button', { name: 'Done' }).click()
  await expect(viewer).toBeHidden()

  // And the server says the same: the owner reads, and only the holder writes.
  await expectRejected(
    () =>
      s.owner.client.mutation(api.memberLicences.update, {
        businessId: s.businessId,
        licenceId,
        name: 'Renamed by the owner',
      }),
    'NO_ACCESS',
  )
})

test('a subcontractor opening the owner’s licence by its address finds nothing', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('licences-other')
  const ownerLicenceId = await addLicence(s.owner, s.businessId, {
    name: 'Timber pest inspection',
    number: 'TPI-9',
  })

  await signInViaUi(page, s.sub.email)
  await page.goto(`/${s.slug}/settings/licence/${ownerLicenceId}`)
  await expect(
    page.getByRole('heading', { name: 'Not found', level: 1 }),
  ).toBeVisible({ timeout: SAVE_TIMEOUT })
  await expect(page.getByText('That licence isn’t in your list.')).toBeVisible()
  await expect(page.getByText('Timber pest inspection')).toHaveCount(0)
  await expect(page.getByText('TPI-9')).toHaveCount(0)

  // Not hidden only: the server refuses to read or change it.
  await expectRejected(
    () => listOf(s.sub, s.businessId, s.ownerMembershipId),
    'NO_ACCESS',
  )
  await expectRejected(
    () =>
      s.sub.client.mutation(api.memberLicences.update, {
        businessId: s.businessId,
        licenceId: ownerLicenceId,
        number: 'MINE-NOW',
      }),
    'NO_ACCESS',
  )
})

test.describe('licences kept on this phone', () => {
  test('open from the hub with no signal', async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'one engine is enough for Cache Storage and the service worker',
    )

    const s = await setupBusinessWithSub('licences-offline')
    await addLicence(s.sub, s.businessId, {
      name: 'White card',
      number: 'WC-1',
      files: [
        { name: 'White card.png', type: 'image/png', body: solidPng(300, 190) },
      ],
    })

    await signInViaUi(page, s.sub.email)
    await page.goto(`/${s.slug}/settings`)
    await expect(
      page.getByRole('heading', { name: 'Settings', level: 1 }),
    ).toBeVisible()

    // The service worker is what serves the hub again with no signal: wait
    // for it to take this page over, then load the hub through it once, so
    // the page is in its cache.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })
    await expect
      .poll(() =>
        page.evaluate(() => navigator.serviceWorker.controller !== null),
      )
      .toBe(true)
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'Settings', level: 1 }),
    ).toBeVisible()

    // Kept without being opened: the list answering is enough.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const name = 'pestm8-kept-licence-v2'
            if (!(await caches.has(name))) return 0
            const keys = await (await caches.open(name)).keys()
            return keys.filter((key) =>
              new URL(key.url).pathname.includes('/files/'),
            ).length
          }),
        { timeout: SAVE_TIMEOUT },
      )
      .toBe(1)

    await context.setOffline(true)
    try {
      await page.reload()
      await expect(
        page.getByRole('heading', { name: 'Settings', level: 1 }),
      ).toBeVisible()

      const sheet = page.getByRole('dialog', { name: 'My licences' })
      await clickUntil(
        page.getByRole('button', { name: 'Show my licence' }),
        () => expect(sheet).toBeVisible({ timeout: 2_000 }),
      )
      await expect(sheet.getByText('White card', { exact: true })).toBeVisible()
      await expect(sheet.getByText('WC-1')).toBeVisible()

      await sheet.getByRole('button', { name: /^Open White card/ }).click()
      const viewer = page.getByRole('dialog', {
        name: 'White card',
        exact: true,
      })
      await expect(viewer).toBeVisible()
      // Drawn from the copy on the phone: there is no network to fetch it.
      await expect(viewer.getByRole('img', { name: 'White card' })).toBeVisible(
        {
          timeout: VIEWER_TIMEOUT,
        },
      )
      await viewer.getByRole('button', { name: 'Done' }).click()
      // Done goes back to the sheet it was opened from.
      await expect(sheet).toBeVisible()
    } finally {
      await context.setOffline(false)
    }
  })
})
