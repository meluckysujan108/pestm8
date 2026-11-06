/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { getTemplate } from '../src/lib/reportTemplates'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * The Reports library's Form and Technician filters (`reports.list` and
 * `reports.search`, `form` and `staffId`): each narrows the segment it is
 * used in, and a value from a mistyped link matches nothing rather than
 * refusing.
 */

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const tech = await createActor(t, { email: 'kevin@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const techMembershipId = await ctx.db.insert('memberships', {
      userId: tech.userId,
      businessId,
      role: 'subcontractor',
      canViewAllJobs: false,
      colour: '#0A84FF',
      status: 'active',
      createdAt: now,
    })
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
    const customTemplateId = await ctx.db.insert('customReportTemplates', {
      businessId,
      name: 'Bird proofing',
      shortName: 'Birds',
      legalBasis: '',
      blurb: '',
      sections: [],
      boilerplate: '',
      createdByMembershipId: ownerMembershipId,
      createdAt: now,
      updatedAt: now,
    })
    return { techMembershipId, propertyId, customTemplateId }
  })
  return { t, owner, tech, businessId, ownerMembershipId, ...ids }
}

type Setup = Awaited<ReturnType<typeof setup>>

function report(
  s: Setup,
  extra: Partial<Doc<'reports'>> = {},
): Promise<Id<'reports'>> {
  return s.t.run((ctx) =>
    ctx.db.insert('reports', {
      businessId: s.businessId,
      propertyId: s.propertyId,
      authorMembershipId: s.ownerMembershipId,
      template: 'serviceReport',
      templateVersion: getTemplate('serviceReport').version,
      legalBasis: 'APVMA',
      status: 'draft',
      data: {},
      photoIds: [],
      searchText: 'j. nguyen 12 wattle street bayswater',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...extra,
    }),
  )
}

async function listed(
  s: Setup,
  who: TestActor,
  narrow: { form?: string; staffId?: string; filter?: 'all' | 'draft' },
) {
  const { form, staffId, filter = 'all' } = narrow
  const ids: Array<Id<'reports'>> = []
  let cursor: string | null = null
  for (let i = 0; i < 20; i++) {
    const page: {
      page: Array<{ _id: Id<'reports'> }>
      isDone: boolean
      continueCursor: string
    } = await who.as.query(api.reports.list, {
      businessId: s.businessId,
      filter,
      ...(form !== undefined && { form }),
      ...(staffId !== undefined && { staffId }),
      paginationOpts: { numItems: 25, cursor },
    })
    ids.push(...page.page.map((row) => row._id))
    if (page.isDone) return ids
    cursor = page.continueCursor
  }
  throw new Error('never finished')
}

describe('the library’s Form filter', () => {
  test('narrows to one built-in form', async () => {
    const s = await setup()
    const service = await report(s)
    await report(s, {
      template: 'treatmentRecord',
      templateVersion: getTemplate('treatmentRecord').version,
    })

    expect(await listed(s, s.owner, { form: 'serviceReport' })).toEqual([
      service,
    ])
  })

  test('narrows to one custom form by its id', async () => {
    const s = await setup()
    await report(s)
    const birds = await report(s, {
      template: 'custom',
      customTemplateId: s.customTemplateId,
    })

    expect(await listed(s, s.owner, { form: s.customTemplateId })).toEqual([
      birds,
    ])
  })

  test('keeps to the segment it is used in', async () => {
    const s = await setup()
    const draft = await report(s)
    await report(s, { status: 'finalised', finalisedAt: Date.now() })

    expect(
      await listed(s, s.owner, { form: 'serviceReport', filter: 'draft' }),
    ).toEqual([draft])
  })
})

describe('the library’s Technician filter', () => {
  test('narrows to whoever wrote each report', async () => {
    const s = await setup()
    await report(s)
    const his = await report(s, { authorMembershipId: s.techMembershipId })

    expect(await listed(s, s.owner, { staffId: s.techMembershipId })).toEqual([
      his,
    ])
  })

  test('never widens a list: a subcontractor asking for the owner’s gets none', async () => {
    const s = await setup()
    await report(s)
    const his = await report(s, { authorMembershipId: s.techMembershipId })

    expect(await listed(s, s.tech, { staffId: s.ownerMembershipId })).toEqual(
      [],
    )
    expect(await listed(s, s.tech, { staffId: s.techMembershipId })).toEqual([
      his,
    ])
  })
})

describe('both filters', () => {
  test('narrow together, in the list and in a search', async () => {
    const s = await setup()
    await report(s)
    await report(s, {
      template: 'treatmentRecord',
      templateVersion: getTemplate('treatmentRecord').version,
      authorMembershipId: s.techMembershipId,
    })
    const both = await report(s, { authorMembershipId: s.techMembershipId })

    const narrow = { form: 'serviceReport', staffId: s.techMembershipId }
    expect(await listed(s, s.owner, narrow)).toEqual([both])
    const found = await s.owner.as.query(api.reports.search, {
      businessId: s.businessId,
      term: 'wattle',
      filter: 'all',
      ...narrow,
    })
    expect(found.map((row) => row._id)).toEqual([both])
  })

  test('answer a mistyped or foreign value with nothing, not a refusal', async () => {
    const s = await setup()
    await report(s)

    for (const narrow of [
      { form: 'not-a-form' },
      { form: s.propertyId },
      { staffId: 'not-an-id' },
      { staffId: s.propertyId },
    ]) {
      expect(await listed(s, s.owner, narrow)).toEqual([])
      expect(
        await s.owner.as.query(api.reports.search, {
          businessId: s.businessId,
          term: 'wattle',
          filter: 'all',
          ...narrow,
        }),
      ).toEqual([])
    }
  })

  test('leave the unfiltered list as it was', async () => {
    const s = await setup()
    const older = await report(s)
    const newer = await report(s, { authorMembershipId: s.techMembershipId })

    expect(await listed(s, s.owner, {})).toEqual([newer, older])
  })
})
