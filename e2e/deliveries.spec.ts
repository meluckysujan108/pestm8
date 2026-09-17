import { expect, test } from '@playwright/test'
import {
  api,
  expectRejected,
  setupBusinessWithSub,
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
