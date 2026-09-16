import { expect, test } from '@playwright/test'
import { api, setupBusinessWithSub } from './fixtures'
import { createReport } from './fixtures/reportPayloads'

/**
 * A report started from a job should arrive knowing what the business already
 * knows — and should say so about the parts it merely guessed.
 *
 * Driven through the real mutations rather than the UI, because that is where
 * the seeding lives: the browser used to fill these blanks in local state, so
 * a draft abandoned before the first keystroke held nothing at all.
 */

test.describe('a report started from a job', () => {
  test('arrives with the date, technician, treatment and delivery already answered', async () => {
    const s = await setupBusinessWithSub('report-seed')

    // A general pest job, in progress, for a client with an email on file.
    const jobId = await s.owner.client.mutation(api.jobs.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.subMembershipId,
      jobType: 'General Pest Control',
      price: 22000,
      scheduledAt: Date.now(),
      durationMinutes: 60,
    })
    await s.owner.client.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      status: 'inProgress',
    })
    const property = await s.owner.client.query(api.properties.get, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    await s.owner.client.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: property!.clientId,
      email: 'client@example.com',
    })

    const reportId = await createReport(
      s.owner.client,
      { businessId: s.businessId, propertyId: s.propertyId, jobId },
      'serviceReport',
    )
    const report = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })

    const data = report!.data as Record<string, unknown>
    // The day of the visit, not the day it is written up.
    expect(data.serviceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Work has started, so the time is a fact and needs no confirming.
    expect(data.startTime).toMatch(/^\d{2}:\d{2}$/)
    expect(report!.prefill?.startTime).toBeUndefined()
    // The client has an address on file, so the report offers to send it.
    expect(data.sendCopy).toBe(true)
    // The form asks who did the work: the job's assignee, not the author.
    expect(data.technician).toBe(s.subMembershipId)
    // And the treatment the booking was for, in the form's own words.
    expect(data.treatments).toMatchObject([{ treatment: ['General Pest Control'] }])
    // The one question the form makes mandatory stays unanswered.
    expect(data.safeToStart).toBeUndefined()
  })

  test('marks a booked start time as a guess, and a technician can confirm it', async () => {
    const s = await setupBusinessWithSub('report-seed-guess')

    // Booked, not started: the app only knows when work was MEANT to begin.
    const jobId = await s.owner.client.mutation(api.jobs.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      jobType: 'General Pest Control',
      price: 19000,
      scheduledAt: Date.now(),
      durationMinutes: 45,
    })

    const reportId = await createReport(
      s.owner.client,
      { businessId: s.businessId, propertyId: s.propertyId, jobId },
      'serviceReport',
    )
    const seeded = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(seeded!.prefill?.startTime).toEqual({ source: 'scheduled' })

    await s.owner.client.mutation(api.reports.confirmPrefill, {
      businessId: s.businessId,
      reportId,
      keys: ['startTime'],
    })
    const confirmed = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(confirmed!.prefill!.startTime.confirmedAt).toEqual(expect.any(Number))
  })

  test('seeds nothing from a job at a different address', async () => {
    const s = await setupBusinessWithSub('report-seed-mismatch')

    const elsewhere = await s.owner.client.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'Another Client',
      addressLine: '9 Other Street',
      suburb: 'Maylands',
      state: 'WA',
      postcode: '6051',
    })
    const jobId = await s.owner.client.mutation(api.jobs.create, {
      businessId: s.businessId,
      propertyId: elsewhere,
      assignedMembershipId: s.subMembershipId,
      jobType: 'General Pest Control',
      price: 15000,
      scheduledAt: Date.now(),
      durationMinutes: 30,
    })

    const reportId = await createReport(
      s.owner.client,
      { businessId: s.businessId, propertyId: s.propertyId, jobId },
      'serviceReport',
    )
    const report = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    const data = report!.data as Record<string, unknown>
    // The report still opens, and the date still defaults — but nothing is
    // taken from a job about somewhere else.
    expect(data.technician).toBeUndefined()
    expect(data.treatments).toBeUndefined()
  })
})
