/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { createActor, createBusiness, testApp } from '../../test/harness'
import { FIXES, applyPropertyFixes } from './propertyFixesV1'
import type { Fix } from './propertyFixesV1'
import type { Id } from '../_generated/dataModel'

/** The production fixes, pointed at rows of the test's own. */
async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'business',
      name: 'Mahal Mart',
      createdAt: now,
      updatedAt: now,
    })
    const insert = (i: number) =>
      ctx.db.insert('properties', {
        businessId,
        clientId,
        ...FIXES[i].was,
        createdAt: now,
      })
    return {
      clientId,
      rows: [await insert(0), await insert(1), await insert(2)],
    }
  })
  const fixes: Array<Fix> = FIXES.map((fix, i) => ({ ...fix, id: ids.rows[i] }))
  const apply = (dryRun: boolean) =>
    t.run((ctx) => applyPropertyFixes(ctx, fixes, dryRun))
  const get = (i: number) =>
    t.run((ctx) => ctx.db.get(ids.rows[i] as Id<'properties'>))
  return { t, businessId, ownerMembershipId, ids, apply, get }
}

describe('the three production property fixes', () => {
  test('a dry run says what it would do and writes nothing', async () => {
    const s = await setup()
    const outcomes = await s.apply(true)
    expect(outcomes.map((o) => o.result)).toEqual([
      'would set {"suburb":"Fannie Bay","state":"NT","postcode":"0820"}',
      'would set {"postcode":"0800"}',
      'would delete',
    ])
    expect(await s.get(0)).toMatchObject({ suburb: 'Fannybay' })
    expect(await s.get(2)).not.toBeNull()
  })

  test('the run corrects both addresses and removes the junk one, and a second run changes nothing', async () => {
    const s = await setup()
    await s.apply(false)
    expect(await s.get(0)).toMatchObject({
      suburb: 'Fannie Bay',
      state: 'NT',
      postcode: '0820',
      addressLine: '38 George Cre',
    })
    expect(await s.get(1)).toMatchObject({ suburb: 'Darwin', postcode: '0800' })
    expect(await s.get(2)).toBeNull()

    const again = await s.apply(false)
    expect(again.map((o) => o.result)).toEqual([
      'already done',
      'already done',
      'already done: no such property',
    ])
  })

  test('a draft at the corrected address is found by its new suburb', async () => {
    const s = await setup()
    const reportId = await s.t.run((ctx) =>
      ctx.db.insert('reports', {
        businessId: s.businessId,
        propertyId: s.ids.rows[0] as Id<'properties'>,
        authorMembershipId: s.ownerMembershipId,
        template: 'serviceReport',
        legalBasis: 'APVMA · AEPMA',
        status: 'draft',
        data: {},
        photoIds: [],
        templateVersion: 2,
        searchText: 'mahal mart 38 george cre fannybay',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    await s.apply(false)
    const report = await s.t.run((ctx) => ctx.db.get(reportId))
    expect(report?.searchText).toMatch(/fannie bay/i)
  })

  test('a record corrected by hand in the meantime is left as it is', async () => {
    const s = await setup()
    await s.t.run((ctx) =>
      ctx.db.patch(s.ids.rows[1] as Id<'properties'>, { postcode: '0810' }),
    )
    const [, darwin] = await s.apply(false)
    expect(darwin.result).toMatch(/^skipped: changed since/)
    expect(await s.get(1)).toMatchObject({ postcode: '0810' })
  })

  test('the junk property is kept if anything has come to refer to it', async () => {
    const s = await setup()
    await s.t.run((ctx) =>
      ctx.db.insert('jobs', {
        businessId: s.businessId,
        propertyId: s.ids.rows[2] as Id<'properties'>,
        assignedMembershipId: s.ownerMembershipId,
        jobType: 'Inspection',
        price: 0,
        scheduledAt: Date.now(),
        durationMinutes: 60,
        status: 'pending',
        createdAt: Date.now(),
      }),
    )
    const outcomes = await s.apply(false)
    expect(outcomes[2].result).toBe('skipped: still referred to by a job')
    expect(await s.get(2)).not.toBeNull()
  })
})
