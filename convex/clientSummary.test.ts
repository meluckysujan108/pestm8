/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor, TestApp } from '../test/harness'

/**
 * The client sheet's Jobs tab (30 Sept 2026): a client's properties,
 * recurring services and visits in one read (`clients.summary`), and their
 * reports to sit under those visits (`clients.visitReports`). Both answer
 * as the client sheet does: null for a client the caller may not see, and
 * only the visits, services and reports they may.
 */

const DAY = 24 * 60 * 60 * 1000

async function join(
  t: TestApp,
  owner: TestActor,
  invitee: TestActor,
  businessId: Id<'businesses'>,
) {
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email: invitee.email,
    role: 'subcontractor',
  })
  await invitee.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
  const membership = await t.run(async (ctx) =>
    ctx.db
      .query('memberships')
      .withIndex('by_user_business', (q) =>
        q.eq('userId', invitee.userId).eq('businessId', businessId),
      )
      .unique(),
  )
  return membership!._id
}

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  const kevinMembershipId = await join(t, owner, kevin, businessId)
  const site = (clientName: string, addressLine: string) =>
    owner.as.mutation(api.properties.create, {
      businessId,
      clientName,
      addressLine,
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
    })
  const propertyId = await site('Jane Smith', '14 Rosewood Ave')
  const clientId = (await t.run((ctx) => ctx.db.get(propertyId)))!.clientId
  const otherPropertyId = await site('Bob Lee', '9 Hay St')
  return {
    t,
    owner,
    kevin,
    businessId,
    ownerMembershipId,
    kevinMembershipId,
    propertyId,
    clientId,
    otherPropertyId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

function book(
  s: Setup,
  {
    at,
    to,
    jobType = 'General Pest Control',
    propertyId = s.propertyId,
  }: {
    at: number
    to: Id<'memberships'>
    jobType?: string
    propertyId?: Id<'properties'>
  },
) {
  return s.owner.as.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId,
    assignedMembershipId: to,
    jobType,
    price: 20000,
    scheduledAt: at,
    durationMinutes: 60,
  })
}

describe('clients.summary', () => {
  test('gives the client’s properties, services and visits, cut to what a row shows', async () => {
    const s = await setup()
    const past = await book(s, {
      at: Date.now() - 7 * DAY,
      to: s.ownerMembershipId,
    })
    await s.owner.as.mutation(api.jobs.complete, {
      businessId: s.businessId,
      jobId: past,
    })
    const seriesId = await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.kevinMembershipId,
      intervalCount: 2,
      intervalUnit: 'week',
      jobType: 'Rodents',
      price: 12000,
      anchorDate: Date.now() + DAY,
      durationMinutes: 45,
    })

    const summary = await s.owner.as.query(api.clients.summary, {
      businessId: s.businessId,
      clientId: s.clientId,
    })
    expect(summary).not.toBeNull()
    expect(summary!.properties).toEqual([
      { _id: s.propertyId, addressLine: '14 Rosewood Ave', suburb: 'Morley' },
    ])
    expect(summary!.series).toEqual([
      expect.objectContaining({
        _id: seriesId,
        jobType: 'Rodents',
        interval: { count: 2, unit: 'week' },
        active: true,
        propertyId: s.propertyId,
        assignedMembershipId: s.kevinMembershipId,
      }),
    ])
    const done = summary!.visits.find((v) => v._id === past)
    expect(done).toMatchObject({
      status: 'completed',
      jobType: 'General Pest Control',
    })
    // Every visit of the series booked so far, and no price on any of them.
    expect(
      summary!.visits.filter((v) => v.recurrenceId === seriesId).length,
    ).toBeGreaterThan(5)
    for (const visit of summary!.visits)
      expect(visit).not.toHaveProperty('price')
    expect(summary!.capped).toBe(false)
  })

  test('a subcontractor sees their own visits and services, and nothing of the rest', async () => {
    const s = await setup()
    const mine = await book(s, {
      at: Date.now() + DAY,
      to: s.kevinMembershipId,
    })
    await book(s, { at: Date.now() + 2 * DAY, to: s.ownerMembershipId })
    await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 1,
      intervalUnit: 'month',
      jobType: 'General Pest Control',
      price: 18500,
      anchorDate: Date.now() + 3 * DAY,
      durationMinutes: 60,
    })

    const summary = await s.kevin.as.query(api.clients.summary, {
      businessId: s.businessId,
      clientId: s.clientId,
    })
    expect(summary!.visits.map((v) => v._id)).toEqual([mine])
    expect(summary!.series).toEqual([])
  })

  test('a visit moved to another client’s property is theirs, not this client’s', async () => {
    const s = await setup()
    const jobId = await book(s, {
      at: Date.now() + DAY,
      to: s.ownerMembershipId,
    })
    await s.owner.as.mutation(api.jobs.update, {
      businessId: s.businessId,
      jobId,
      propertyId: s.otherPropertyId,
    })
    const summary = await s.owner.as.query(api.clients.summary, {
      businessId: s.businessId,
      clientId: s.clientId,
    })
    expect(summary!.visits).toEqual([])
  })

  test('is null for a client in the Recycle bin, and for another business’s', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.bin.deleteClient, {
      businessId: s.businessId,
      clientId: s.clientId,
    })
    expect(
      await s.owner.as.query(api.clients.summary, {
        businessId: s.businessId,
        clientId: s.clientId,
      }),
    ).toBeNull()
    expect(
      await s.owner.as.query(api.clients.visitReports, {
        businessId: s.businessId,
        clientId: s.clientId,
      }),
    ).toBeNull()

    const other = await createActor(s.t, { email: 'someone@else.test' })
    const { businessId: elsewhere } = await createBusiness(s.t, other, 'Else')
    const theirs = await other.as.mutation(api.properties.create, {
      businessId: elsewhere,
      clientName: 'Theirs',
      addressLine: '1 Other Rd',
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
    })
    const theirClient = (await s.t.run((ctx) => ctx.db.get(theirs)))!.clientId
    expect(
      await s.owner.as.query(api.clients.summary, {
        businessId: s.businessId,
        clientId: theirClient,
      }),
    ).toBeNull()
  })
})

describe('clients.visitReports', () => {
  test('gives each report as a chip, with its visit and whether it was replaced', async () => {
    const s = await setup()
    const jobId = await book(s, {
      at: Date.now() - DAY,
      to: s.ownerMembershipId,
    })
    const forVisit = await s.owner.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      jobId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const loose = await s.owner.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      template: 'timberPestInspection',
      legalBasis: 'AS 4349.3-2010',
      data: {},
    })
    // Replaced by a later amendment (set as `amend` sets it on finalising).
    await s.t.run((ctx) =>
      ctx.db.patch(loose, { supersededByReportId: forVisit }),
    )

    const result = await s.owner.as.query(api.clients.visitReports, {
      businessId: s.businessId,
      clientId: s.clientId,
    })
    const byId = new Map(result!.reports.map((r) => [r._id, r]))
    expect(byId.get(forVisit)).toMatchObject({
      jobId,
      status: 'draft',
      templateName: 'Pest Service Report',
      superseded: false,
    })
    expect(byId.get(loose)).toMatchObject({
      templateName: 'Timber Pest Inspection',
      superseded: true,
    })
    expect(byId.get(loose)).not.toHaveProperty('jobId', expect.anything())
    expect(result!.capped).toBe(false)
  })

  test('only reports the caller may read', async () => {
    const s = await setup()
    await s.owner.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const kevins = await s.kevin.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const result = await s.kevin.as.query(api.clients.visitReports, {
      businessId: s.businessId,
      clientId: s.clientId,
    })
    expect(result!.reports.map((r) => r._id)).toEqual([kevins])
  })
})

describe('what the sheet is told it is missing', () => {
  test('a report replaced by an amendment the caller cannot read is still theirs to see', async () => {
    const s = await setup()
    const kevins = await s.kevin.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const owners = await s.owner.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    // The owner's amendment of Kevin's report, as `amend` marks it.
    await s.t.run((ctx) =>
      ctx.db.patch(kevins, { supersededByReportId: owners }),
    )
    const result = await s.kevin.as.query(api.clients.visitReports, {
      businessId: s.businessId,
      clientId: s.clientId,
    })
    expect(result!.reports).toEqual([
      expect.objectContaining({ _id: kevins, superseded: false }),
    ])
  })

  test('says when a client has more sites than it read, keeping the newest', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
        await ctx.db.insert('properties', {
          businessId: s.businessId,
          clientId: s.clientId,
          addressLine: `${i + 1} New Street`,
          suburb: 'Morley',
          state: 'WA',
          postcode: '6062',
          createdAt: Date.now(),
        })
      }
    })
    const summary = await s.owner.as.query(api.clients.summary, {
      businessId: s.businessId,
      clientId: s.clientId,
    })
    expect(summary!.sitesCapped).toBe(true)
    expect(summary!.properties).toHaveLength(50)
    // The first, oldest site is the one left out.
    expect(summary!.properties.map((p) => p._id)).not.toContain(s.propertyId)
  })
})

describe('reports.create for a visit', () => {
  test('refuses a visit that is not at the report’s property', async () => {
    const s = await setup()
    const elsewhere = await book(s, {
      at: Date.now(),
      to: s.ownerMembershipId,
      propertyId: s.otherPropertyId,
    })
    await expect(
      s.owner.as.mutation(api.reports.create, {
        businessId: s.businessId,
        propertyId: s.propertyId,
        jobId: elsewhere,
        template: 'serviceReport',
        legalBasis: 'APVMA',
        data: {},
      }),
    ).rejects.toThrow('NOT_FOUND')

    const here = await book(s, { at: Date.now(), to: s.ownerMembershipId })
    const reportId = await s.owner.as.mutation(api.reports.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
      jobId: here,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    expect((await s.t.run((ctx) => ctx.db.get(reportId)))?.jobId).toBe(here)
  })
})
