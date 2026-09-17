import { expect, test } from '@playwright/test'
import { api, expectRejected, setupBusinessWithSub } from './fixtures'
import { createReport, finaliseReport } from './fixtures/reportPayloads'

/**
 * "A job is not finished until its report is."
 *
 * WA's Pesticides Regulations want the record made within two business days,
 * and a report written next week from memory is a worse record than one
 * written in the driveway. A business that issues one on every treatment can
 * say so and stop relying on anybody remembering.
 *
 * Off unless an owner turns it on, and even then only for job types that have
 * a form: a quote visit blocked at "Complete" is how a business learns to
 * switch a policy off.
 */

async function jobFor(label: string, jobType: string) {
  const s = await setupBusinessWithSub(label)
  const jobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: s.ownerMembershipId,
    jobType,
    price: 21000,
    scheduledAt: Date.now(),
    durationMinutes: 60,
  })
  return { ...s, jobId }
}

test('off by default, a job completes with no report at all', async () => {
  const s = await jobFor('policy-off', 'General Pest Control')

  await s.owner.client.mutation(api.jobs.complete, {
    businessId: s.businessId,
    jobId: s.jobId,
  })
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.jobId,
  })
  expect(job!.status).toBe('completed')
})

test('on, a treatment with no signed report is held at Complete', async () => {
  const s = await jobFor('policy-on', 'General Pest Control')
  await s.owner.client.mutation(api.businesses.update, {
    businessId: s.businessId,
    requireReportToComplete: true,
  })

  await expectRejected(
    () =>
      s.owner.client.mutation(api.jobs.complete, {
        businessId: s.businessId,
        jobId: s.jobId,
      }),
    'REPORT_REQUIRED',
  )

  // A draft is exactly the state this exists to catch: the point of
  // finalising is that the document stops changing.
  const reportId = await createReport(
    s.owner.client,
    { businessId: s.businessId, propertyId: s.propertyId, jobId: s.jobId },
    'serviceReport',
  )
  await expectRejected(
    () =>
      s.owner.client.mutation(api.jobs.complete, {
        businessId: s.businessId,
        jobId: s.jobId,
      }),
    'REPORT_REQUIRED',
  )

  // Started from a job, so the app suggested a start time and the weather;
  // finalise refuses until somebody has looked at them.
  const draft = await s.owner.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId,
  })
  const suggested = Object.keys(draft!.prefill ?? {})
  if (suggested.length > 0) {
    await s.owner.client.mutation(api.reports.confirmPrefill, {
      businessId: s.businessId,
      reportId,
      keys: suggested,
    })
  }
  await finaliseReport(
    s.owner.client,
    { businessId: s.businessId },
    reportId,
    'serviceReport',
    {
      ...(draft!.data as Record<string, unknown>),
      // The job type seeds a treatment row with only its Treatment ticked, and
      // a half-filled row is exactly what `finalise` refuses. This test is
      // about the policy, not the form.
      treatments: [],
    },
  )
  await s.owner.client.mutation(api.jobs.complete, {
    businessId: s.businessId,
    jobId: s.jobId,
  })
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.jobId,
  })
  expect(job!.status).toBe('completed')
})

test('a job type with no form is never held up by it', async () => {
  // `suggestTemplate` finds nothing for a quote, so there is no report the
  // policy could reasonably be asking for.
  const s = await jobFor('policy-noform', 'Quote')
  await s.owner.client.mutation(api.businesses.update, {
    businessId: s.businessId,
    requireReportToComplete: true,
  })

  await s.owner.client.mutation(api.jobs.complete, {
    businessId: s.businessId,
    jobId: s.jobId,
  })
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.jobId,
  })
  expect(job!.status).toBe('completed')
})

test('the policy is the owner’s, and only the owner can read it back', async () => {
  const s = await jobFor('policy-access', 'General Pest Control')

  await expectRejected(
    () =>
      s.sub.client.mutation(api.businesses.update, {
        businessId: s.businessId,
        requireReportToComplete: true,
      }),
    'NO_ACCESS',
  )
  await expectRejected(
    () => s.sub.client.query(api.businesses.reportSettings, { businessId: s.businessId }),
    'NO_ACCESS',
  )

  const settings = await s.owner.client.query(api.businesses.reportSettings, {
    businessId: s.businessId,
  })
  expect(settings!.requireReportToComplete).toBe(false)
})
