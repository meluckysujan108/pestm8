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
 * Who a finished report goes to, and who decides.
 *
 * A technician may send a compliance document to the people the business
 * already corresponds with; anywhere else is the owner's call. A report
 * emailed to a typo is simply gone — nobody bounces it back — and the person
 * who would notice a wrong address is the one who owns the client
 * relationship, not the one standing in a driveway.
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
    { businessId: s.businessId, reportId: s.reportId, to: ['CLIENT@example.com'] },
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
  expect(row?.sentBy?.name).toBe('Kevin')
})

test('an address on nobody’s record waits for the owner', async () => {
  const s = await reportForSub('delivery-novel', 'client@example.com')

  const { status } = await s.sub.client.mutation(api.deliveries.request, {
    businessId: s.businessId,
    reportId: s.reportId,
    to: ['someone@elsewhere.example'],
  })
  expect(status).toBe('pendingApproval')

  // The owner sees it waiting; the technician who asked does not get a queue
  // of their own to approve from.
  const queue = await s.owner.client.query(api.deliveries.pendingApproval, {
    businessId: s.businessId,
  })
  expect(queue).toHaveLength(1)
  expect(queue[0].to).toEqual(['someone@elsewhere.example'])

  const subsView = await s.sub.client.query(api.deliveries.pendingApproval, {
    businessId: s.businessId,
  })
  expect(subsView).toEqual([])
})

test('the owner can let it go, and who allowed it is part of the record', async () => {
  const s = await reportForSub('delivery-approve', 'client@example.com')
  const { deliveryId } = await s.sub.client.mutation(api.deliveries.request, {
    businessId: s.businessId,
    reportId: s.reportId,
    to: ['someone@elsewhere.example'],
  })

  await s.owner.client.mutation(api.deliveries.approve, {
    businessId: s.businessId,
    deliveryId,
  })

  const history = await s.owner.client.query(api.deliveries.forReport, {
    businessId: s.businessId,
    reportId: s.reportId,
  })
  const row = history.find((entry) => entry._id === deliveryId)
  expect(row?.status).toBe('queued')
  // Two different facts, and the record keeps both: who asked, and who allowed.
  expect(row?.sentBy?.name).toBe('Kevin')
  expect(row?.approvedBy?.name).toBe('Terence')
})

test('seeing a report is not seeing the client book behind it', async () => {
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

  // Everyone's schedule, but not the client directory — and no job of their
  // own at this client. The report is theirs to read; the client's contacts
  // are not theirs to be read out.
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

  const asOwner = await s.owner.client.query(api.deliveries.known, {
    businessId: s.businessId,
    reportId,
  })
  expect(asOwner.addresses).toContain('strata@example.com')

  const asSub = await s.sub.client.query(api.deliveries.known, {
    businessId: s.businessId,
    reportId,
  })
  // The client's own address is on the report they are reading anyway.
  expect(asSub.addresses).toContain('client@example.com')
  expect(asSub.addresses).not.toContain('strata@example.com')

  // And a send cannot be used to test a guess: to them it is a new address,
  // which the owner approves.
  const { status } = await s.sub.client.mutation(api.deliveries.request, {
    businessId: s.businessId,
    reportId,
    to: ['strata@example.com'],
  })
  expect(status).toBe('pendingApproval')
})

test('a technician cannot approve their own request', async () => {
  const s = await reportForSub('delivery-self-approve', 'client@example.com')
  const { deliveryId } = await s.sub.client.mutation(api.deliveries.request, {
    businessId: s.businessId,
    reportId: s.reportId,
    to: ['someone@elsewhere.example'],
  })

  await expectRejected(
    () =>
      s.sub.client.mutation(api.deliveries.approve, {
        businessId: s.businessId,
        deliveryId,
      }),
    'NO_ACCESS',
  )
})

test('another business cannot see or touch a delivery', async () => {
  const s = await reportForSub('delivery-tenant', 'client@example.com')
  const { deliveryId } = await s.sub.client.mutation(api.deliveries.request, {
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
  await expectRejected(
    () =>
      outsider.client.mutation(api.deliveries.approve, {
        businessId: s.businessId,
        deliveryId,
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

  test('offers the people the form asked for, and says who needs approval', async ({
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
    await page.getByRole('tab', { name: 'Email' }).click()
    await page.getByRole('button', { name: 'Send this report' }).click()

    const sheet = page.getByRole('dialog')
    // The address the form asked for, already chosen — nobody retypes what
    // they have just answered a question about.
    const client = sheet.getByRole('button', { name: /client@example\.com/ })
    await expect(client).toHaveAttribute('aria-pressed', 'true')
    await expect(sheet.getByRole('button', { name: /Send to 1 person/ })).toBeVisible()

    // Someone else, and the sheet says before Send that it will be held.
    await sheet.getByRole('button', { name: 'Send to someone else' }).click()
    await sheet.getByLabel('Email address').fill('stranger@elsewhere.example')
    await sheet.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(sheet.getByText('Needs approval')).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Request approval' })).toBeVisible()
  })

  test('a delivery the form opened shows in the history without anyone sending', async ({
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
    await page.getByRole('tab', { name: 'Email' }).click()

    // Queued rather than sent: no Resend key on this deployment. The record
    // exists either way, which is the point of writing it before the call.
    await expect(page.getByText(/client@example\.com/)).toBeVisible()
    await expect(page.getByText(/asked for by the form/)).toBeVisible()
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
    await page.getByRole('tab', { name: 'Email' }).click()
    await page.getByRole('button', { name: 'Send this report' }).click()

    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Send to someone else' }).click()
    await sheet.getByLabel('Email address').fill('stranger@elsewhere.example')
    await sheet.getByRole('button', { name: 'Add', exact: true }).click()
    await sheet.getByRole('button', { name: 'Request approval' }).click()

    // One line per recipient, each naming its own address. This deployment
    // has no Resend key so both say the same thing — but they say it
    // separately, which is the point: a client's address can go while a
    // strata office's waits for the owner, and a single verdict for the tap
    // would misreport one of them.
    const results = sheet.getByRole('status')
    await expect(results.getByText(/^client@example\.com —/)).toBeVisible()
    await expect(results.getByText(/^stranger@elsewhere\.example —/)).toBeVisible()
  })
})
