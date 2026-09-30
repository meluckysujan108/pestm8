import { expect, test } from '@playwright/test'
import {
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
  FIXTURE_PASSWORD,
} from './fixtures'
import { createReport, finaliseReport } from './fixtures/reportPayloads'

/**
 * Who a finished report goes to, and what the record says about it.
 *
 * Anyone who may send a report may send it to any address that can receive
 * email: since 29 Sept 2026 nothing waits for an owner's approval, which no
 * screen could ever give. Instead every send is a record — who asked, and
 * which of its addresses were not on the client's record — that the owner
 * reads in the finished report's Email list, and the Send sheet marks a new
 * address before Send, because a report emailed to a typo is simply gone.
 *
 * No `RESEND_API_KEY` is configured on this deployment (that is the business's
 * own Resend account, not something to fake here), so nothing here sends. What
 * it checks is everything up to that boundary — the record each request
 * leaves, and who may do what with it.
 */

async function reportForSub(label: string, clientEmail?: string) {
  const s = await setupBusinessWithSub(label)
  if (clientEmail) {
    const property = await s.owner.client.query(api.properties.get, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    await s.owner.client.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: property!.clientId,
      email: clientEmail,
    })
  }
  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  await finaliseReport(s.sub.client, s, reportId, 'serviceReport')
  return { ...s, reportId }
}

test('an address on the client record is sent without asking anyone', async () => {
  const s = await reportForSub('delivery-known', 'client@example.com')

  const { status, deliveryId } = await s.sub.client.mutation(
    api.deliveries.request,
    {
      businessId: s.businessId,
      reportId: s.reportId,
      to: ['CLIENT@example.com'],
    },
  )
  expect(status).toBe('queued')

  const history = await s.sub.client.query(api.deliveries.forReport, {
    businessId: s.businessId,
    reportId: s.reportId,
  })
  const row = history.find((entry) => entry._id === deliveryId)
  // Recorded before anything is sent, so a send that dies mid-flight leaves a
  // record rather than nothing.
  expect(row?.status).toBe('queued')
  expect(row?.to).toEqual(['client@example.com'])
  expect(row?.newAddresses).toEqual([])
  expect(row?.sentBy?.name).toBe('Kevin')
})

test('an address on nobody’s record goes too, and the record says it was new', async () => {
  const s = await reportForSub('delivery-novel', 'client@example.com')

  const { status, deliveryId } = await s.sub.client.mutation(
    api.deliveries.request,
    {
      businessId: s.businessId,
      reportId: s.reportId,
      to: ['someone@elsewhere.example'],
    },
  )
  // Nothing waits for an owner.
  expect(status).toBe('queued')

  // What the owner reads in the report's Email list: who sent it, and that the
  // address was new to this client.
  const history = await s.owner.client.query(api.deliveries.forReport, {
    businessId: s.businessId,
    reportId: s.reportId,
  })
  const row = history.find((entry) => entry._id === deliveryId)
  expect(row?.status).toBe('queued')
  expect(row?.newAddresses).toEqual(['someone@elsewhere.example'])
  expect(row?.sentBy?.name).toBe('Kevin')
  expect(row?.onBehalfOf).toBeNull()
})

/**
 * The client book is one business's, open to everyone in it (the owner's
 * decision, 2026-09-18) — contacts included, since they are on the client
 * sheet every member can open. So the send sheet offers them to anyone who can
 * read the report, and sending to one is sending to an address already on
 * file, not a new one. The old per-person "can see all clients" toggle is
 * inert: a row that still stores `false` changes nothing.
 */
test('the send sheet offers the client’s contacts to anyone who can read the report', async () => {
  const s = await setupBusinessWithSub('delivery-contacts')
  const property = await s.owner.client.query(api.properties.get, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  const clientId = property!.clientId
  await s.owner.client.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId,
    email: 'client@example.com',
  })
  await s.owner.client.mutation(api.clientContacts.create, {
    businessId: s.businessId,
    clientId,
    name: 'Strata manager',
    email: 'strata@example.com',
  })
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

  // Everyone's schedule, so the report is theirs to read; no job of their own
  // at this client; and the retired toggle still stored as off.
  await s.owner.client.mutation(api.memberships.setGrants, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    grants: {
      switchInto: null,
      clientDirectory: false,
      prices: false,
      otherSchedules: true,
    },
  })

  const asSub = await s.sub.client.query(api.deliveries.known, {
    businessId: s.businessId,
    reportId,
  })
  expect(asSub.addresses).toContain('client@example.com')
  expect(asSub.addresses).toContain('strata@example.com')

  await s.sub.client.mutation(api.deliveries.request, {
    businessId: s.businessId,
    reportId,
    to: ['strata@example.com'],
  })
  // An address that is on no record is still new: it goes all the same, and
  // the row says so.
  await s.sub.client.mutation(api.deliveries.request, {
    businessId: s.businessId,
    reportId,
    to: ['someone@elsewhere.example'],
  })
  const history = await s.sub.client.query(api.deliveries.forReport, {
    businessId: s.businessId,
    reportId,
  })
  expect(
    history
      .map((row) => ({ to: row.to, newAddresses: row.newAddresses }))
      .sort((a, b) => a.to[0].localeCompare(b.to[0])),
  ).toEqual([
    {
      to: ['someone@elsewhere.example'],
      newAddresses: ['someone@elsewhere.example'],
    },
    { to: ['strata@example.com'], newAddresses: [] },
  ])
})

test('another business cannot see a delivery, or send the report anywhere', async () => {
  const s = await reportForSub('delivery-tenant', 'client@example.com')
  await s.sub.client.mutation(api.deliveries.request, {
    businessId: s.businessId,
    reportId: s.reportId,
    to: ['client@example.com'],
  })

  const outsider = await signUpActor(
    uniqueEmail('delivery-outsider'),
    FIXTURE_PASSWORD,
    'Nadia',
  )
  await expectRejected(
    () =>
      outsider.client.query(api.deliveries.forReport, {
        businessId: s.businessId,
        reportId: s.reportId,
      }),
    'NO_ACCESS',
  )
  // Sending anywhere is open to the business's own people, not to anyone
  // who has a report's id.
  await expectRejected(
    () =>
      outsider.client.mutation(api.deliveries.request, {
        businessId: s.businessId,
        reportId: s.reportId,
        to: ['nadia@elsewhere.example'],
      }),
    'NO_ACCESS',
  )
})

test('the form’s own send-copy toggle opens a delivery when the report locks', async () => {
  const s = await setupBusinessWithSub('delivery-on-finalise')
  const property = await s.owner.client.query(api.properties.get, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  await s.owner.client.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId: property!.clientId,
    email: 'client@example.com',
  })

  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await finaliseReport(s.owner.client, s, reportId, 'serviceReport', {
    sendCopy: true,
    emailReportTo: ['client@example.com'],
  })

  const history = await s.owner.client.query(api.deliveries.forReport, {
    businessId: s.businessId,
    reportId,
  })
  expect(history).toHaveLength(1)
  expect(history[0].trigger).toBe('finalise')
  expect(history[0].to).toEqual(['client@example.com'])
  // Named for the document, so the client's inbox says what arrived.
  expect(history[0].subject).toContain('12 Wattle Street')
  // Email is not set up on this deployment, so nothing will send it — and the
  // history says so rather than letting "Queued" read as a promise.
  expect(history[0].status).toBe('queued')
  expect(history[0].waitingForEmailSetup).toBe(true)
})

test('the form’s copy for someone nobody has on file goes in the same email, marked new', async () => {
  const s = await setupBusinessWithSub('delivery-on-finalise-new')
  const property = await s.owner.client.query(api.properties.get, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  await s.owner.client.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId: property!.clientId,
    email: 'client@example.com',
  })

  // Locked by the subcontractor, as on a real job.
  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  await finaliseReport(s.sub.client, s, reportId, 'serviceReport', {
    sendCopy: true,
    emailReportTo: ['strata@harbourside.example'],
  })

  const history = await s.owner.client.query(api.deliveries.forReport, {
    businessId: s.businessId,
    reportId,
  })
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({
    to: ['client@example.com', 'strata@harbourside.example'],
    newAddresses: ['strata@harbourside.example'],
    trigger: 'finalise',
    status: 'queued',
  })
  expect(history[0].sentBy?.name).toBe('Kevin')
})

test('a form that asked for no copy opens no delivery', async () => {
  const s = await setupBusinessWithSub('delivery-no-copy')
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

  const history = await s.owner.client.query(api.deliveries.forReport, {
    businessId: s.businessId,
    reportId,
  })
  expect(history).toEqual([])
})

test('one person cannot send a hundred reports in an hour', async () => {
  const s = await reportForSub('delivery-rate', 'client@example.com')

  // Twenty is generous for a technician finishing a day's jobs and far below
  // what a runaway retry loop manages. Counted from the delivery rows, which
  // already are the record of every send — so the twenty-first is the one
  // that is refused, not the twenty-second.
  for (let n = 0; n < 20; n++) {
    await s.sub.client.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId: s.reportId,
      to: ['client@example.com'],
    })
  }

  await expectRejected(
    () =>
      s.sub.client.mutation(api.deliveries.request, {
        businessId: s.businessId,
        reportId: s.reportId,
        to: ['client@example.com'],
      }),
    'SEND_RATE_LIMITED',
  )
})

test.describe('the send sheet', () => {
  test.use({ viewport: { width: 430, height: 932 } })

  test('offers the people the form asked for, and marks an address the client’s record does not have', async ({
    page,
  }) => {
    const s = await setupBusinessWithSub('send-sheet')
    const property = await s.owner.client.query(api.properties.get, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    await s.owner.client.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: property!.clientId,
      email: 'client@example.com',
    })

    const reportId = await createReport(s.sub.client, s, 'serviceReport')
    await finaliseReport(s.sub.client, s, reportId, 'serviceReport', {
      sendCopy: true,
    })

    await signInViaUi(page, s.sub.email)
    await page.goto(`/${s.slug}/reports/${reportId}`)
    await page.getByRole('button', { name: 'Send this report' }).click()

    const sheet = page.getByRole('dialog')
    // The address the form asked for, already chosen — nobody retypes what
    // they have just answered a question about.
    const client = sheet.getByRole('button', { name: /client@example\.com/ })
    await expect(client).toHaveAttribute('aria-pressed', 'true')
    await expect(
      sheet.getByRole('button', { name: /Send to 1 person/ }),
    ).toBeVisible()

    // Someone else: marked as new before Send — where a typo would be — and
    // sent like anyone else. Nothing is held for an owner.
    await sheet.getByRole('button', { name: 'Send to someone else' }).click()
    await sheet.getByLabel('Email address').fill('stranger@elsewhere.example')
    await sheet.getByRole('button', { name: 'Add', exact: true }).click()
    const stranger = sheet.getByRole('button', {
      name: /stranger@elsewhere\.example/,
    })
    await expect(stranger).toContainText('Not on the client’s record')
    await expect(client).not.toContainText('Not on the client’s record')
    await expect(
      sheet.getByRole('button', { name: /Send to 2 people/ }),
    ).toBeVisible()
    await expect(sheet.getByText(/approv/i)).toHaveCount(0)
  })

  test('a delivery the form opened shows on the report without anyone sending', async ({
    page,
  }) => {
    const s = await setupBusinessWithSub('send-sheet-history')
    const property = await s.owner.client.query(api.properties.get, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    await s.owner.client.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: property!.clientId,
      email: 'client@example.com',
    })

    const reportId = await createReport(s.owner.client, s, 'serviceReport')
    await finaliseReport(s.owner.client, s, reportId, 'serviceReport', {
      sendCopy: true,
    })

    await signInViaUi(page, s.owner.email)
    await page.goto(`/${s.slug}/reports/${reportId}`)

    // Queued rather than sent: no Resend key on this deployment. The record
    // exists either way, which is the point of writing it before the call.
    const email = page.getByRole('region', { name: 'Email' })
    await expect(email.getByText(/client@example\.com/)).toBeVisible()
    await expect(email.getByText(/as it was finalised/)).toBeVisible()
  })

  test('the report’s Email list says which addresses weren’t on the client’s record', async ({
    page,
  }) => {
    const s = await reportForSub('send-history-new', 'client@example.com')
    await s.sub.client.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId: s.reportId,
      to: ['someone@elsewhere.example'],
    })

    // What an owner reads afterwards, with nothing to approve.
    await signInViaUi(page, s.owner.email)
    await page.goto(`/${s.slug}/reports/${s.reportId}`)
    // Said under the address itself, rather than the address again.
    const row = page
      .getByRole('region', { name: 'Email' })
      .getByRole('listitem')
      .filter({ hasText: 'someone@elsewhere.example' })
    await expect(row).toContainText('Wasn’t on the client’s record')
    await expect(page.getByText(/approv/i)).toHaveCount(0)
  })

  test('the finished report says whether it went', async ({ page }) => {
    const s = await setupBusinessWithSub('send-status-line')
    const property = await s.owner.client.query(api.properties.get, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    await s.owner.client.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: property!.clientId,
      email: 'client@example.com',
    })
    const reportId = await createReport(s.owner.client, s, 'serviceReport')
    await finaliseReport(s.owner.client, s, reportId, 'serviceReport', {
      sendCopy: true,
    })

    await signInViaUi(page, s.owner.email)
    await page.goto(`/${s.slug}/reports/${reportId}`)

    // Locking sent it — or, with no Resend key here, could not — and the page
    // that opens straight after is where that is said, with what to do.
    const email = page.getByRole('region', { name: 'Email' })
    await expect(email.getByText(/client@example\.com/)).toBeVisible()
    await expect(
      email.getByText(
        'Email isn’t set up for this business yet. Share the PDF instead.',
      ),
    ).toBeVisible()
    await expect(email.getByText(/as it was finalised/)).toBeVisible()
  })

  test('says what happened to each recipient, not one verdict for all', async ({
    page,
  }) => {
    const s = await setupBusinessWithSub('send-sheet-mixed')
    const property = await s.owner.client.query(api.properties.get, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    await s.owner.client.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: property!.clientId,
      email: 'client@example.com',
    })
    const reportId = await createReport(s.sub.client, s, 'serviceReport')
    await finaliseReport(s.sub.client, s, reportId, 'serviceReport', {
      sendCopy: true,
    })

    await signInViaUi(page, s.sub.email)
    await page.goto(`/${s.slug}/reports/${reportId}`)
    await page.getByRole('button', { name: 'Send this report' }).click()

    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Send to someone else' }).click()
    await sheet.getByLabel('Email address').fill('stranger@elsewhere.example')
    await sheet.getByRole('button', { name: 'Add', exact: true }).click()
    await sheet.getByRole('button', { name: /Send to 2 people/ }).click()

    // One line per recipient, each naming its own address. This deployment
    // has no Resend key so both say the same thing — but they say it
    // separately, which is the point: a client's address can go while the
    // provider refuses a strata office's, and a single verdict for the tap
    // would misreport one of them.
    const results = sheet.getByRole('status')
    await expect(results.getByText(/^client@example\.com —/)).toBeVisible()
    await expect(
      results.getByText(/^stranger@elsewhere\.example —/),
    ).toBeVisible()
  })
})
