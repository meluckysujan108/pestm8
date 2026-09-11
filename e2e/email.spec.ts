import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * No `RESEND_API_KEY` is configured in this dev deployment (that's the
 * business's own Resend account to set up, not something to fake here), so
 * these tests exercise everything up to that boundary: the config guard
 * itself, the audit trail a finalise already produces, and access control on
 * reading it. A real send is out of scope until a key exists.
 */
test('sending a report email without a configured key fails clearly and logs nothing', async () => {
  const s = await setupBusinessWithSub('email-unconfigured')

  const reportId = await s.owner.client.mutation(api.reports.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    data: {},
  })
  await s.owner.client.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId,
    data: { safeToStart: true, treatments: [] },
  })

  await expectRejected(
    () =>
      s.owner.client.action(api.email.sendReportPdf, {
        businessId: s.businessId,
        reportId,
        to: 'client@example.com',
      }),
    'EMAIL_NOT_CONFIGURED',
  )

  const logs = await s.owner.client.query(api.auditLog.forEntity, {
    businessId: s.businessId,
    entityType: 'reports',
    entityId: reportId,
  })
  // A configuration failure isn't an attempt worth recording against the
  // report's history — only real sends and real failures are.
  expect(logs.some((entry) => entry.action.startsWith('report.email'))).toBe(
    false,
  )
})

test('finalising a report is recorded in its action history', async () => {
  const email = uniqueEmail('auditlog-owner')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')

  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `Audit Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const reportId = await owner.client.mutation(api.reports.create, {
    businessId,
    propertyId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    data: {},
  })
  await owner.client.mutation(api.reports.finalise, {
    businessId,
    reportId,
    data: { safeToStart: true, treatments: [] },
  })

  const logs = await owner.client.query(api.auditLog.forEntity, {
    businessId,
    entityType: 'reports',
    entityId: reportId,
  })
  expect(logs).toHaveLength(1)
  expect(logs[0].action).toBe('report.finalise')
})

test('a non-member cannot read a report action history', async () => {
  const s = await setupBusinessWithSub('auditlog-lock')

  const reportId = await s.owner.client.mutation(api.reports.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    template: 'serviceReport',
    legalBasis: 'APVMA · AEPMA',
    data: {},
  })
  await s.owner.client.mutation(api.reports.finalise, {
    businessId: s.businessId,
    reportId,
    data: { safeToStart: true, treatments: [] },
  })

  const outsider = await signUpActor(
    uniqueEmail('auditlog-outsider'),
    FIXTURE_PASSWORD,
    'Nadia',
  )
  await expectRejected(
    () =>
      outsider.client.query(api.auditLog.forEntity, {
        businessId: s.businessId,
        entityType: 'reports',
        entityId: reportId,
      }),
    'NO_ACCESS',
  )
})
