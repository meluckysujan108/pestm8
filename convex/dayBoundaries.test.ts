/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { zonedDateTimeToUtc } from './lib/dates'

/**
 * A day is the tenant's calendar day, however long it is. Perth has no
 * daylight saving, so the rest of the suite never meets a 23- or 25-hour
 * Sunday; a Sydney business meets two a year. Day windows used to be
 * start + 24h, which dropped the last hour of the long Sunday from every list
 * and pulled Monday's first hour into the short one.
 *
 * 2026 in Sydney: clocks go back at 3am on Sunday 5 April (25 hours) and
 * forward at 2am on Sunday 4 October (23 hours).
 */

const SYDNEY = 'Australia/Sydney'

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'owner@harbour.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const propertyId = await t.run(async (ctx) => {
    await ctx.db.patch(businessId, { state: 'NSW', timezone: SYDNEY })
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'A. Harbour',
      createdAt: now,
      updatedAt: now,
    })
    return ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '1 Quay Street',
      suburb: 'Manly',
      state: 'NSW',
      postcode: '2095',
      createdAt: now,
    })
  })

  const book = (dayKey: string, hour: number, minute: number) =>
    owner.as.mutation(api.jobs.create, {
      businessId,
      propertyId,
      assignedMembershipId: ownerMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt: zonedDateTimeToUtc(dayKey, hour, minute, SYDNEY),
      durationMinutes: 30,
    })

  const day = (dayKey: string) =>
    owner.as.query(api.jobs.listDay, { businessId, dayKey })
  const week = (startKey: string) =>
    owner.as.query(api.jobs.listWeek, { businessId, startKey })

  return { book, day, week }
}

describe('the 25-hour Sunday (clocks back, 5 April 2026)', () => {
  test('a job at 23:30 is on that Sunday’s list', async () => {
    const s = await setup()
    const jobId = await s.book('2026-04-05', 23, 30)

    expect((await s.day('2026-04-05')).map((j) => j._id)).toEqual([jobId])
    expect(await s.day('2026-04-06')).toHaveLength(0)
  })

  test('and in that Sunday’s cell of the week, not missing from the week', async () => {
    const s = await setup()
    await s.book('2026-04-05', 23, 30)

    const cells = await s.week('2026-03-30')
    expect(cells.find((d) => d.dayKey === '2026-04-05')?.count).toBe(1)
    expect(cells.reduce((n, d) => n + d.count, 0)).toBe(1)
  })
})

describe('the 23-hour Sunday (clocks forward, 4 October 2026)', () => {
  test('Monday’s 00:30 job is not on Sunday’s list', async () => {
    const s = await setup()
    const jobId = await s.book('2026-10-05', 0, 30)

    expect(await s.day('2026-10-04')).toHaveLength(0)
    expect((await s.day('2026-10-05')).map((j) => j._id)).toEqual([jobId])
  })

  test('and the week puts it on Monday, once', async () => {
    const s = await setup()
    await s.book('2026-10-05', 0, 30)

    const before = await s.week('2026-09-28')
    const after = await s.week('2026-10-05')
    expect(before.reduce((n, d) => n + d.count, 0)).toBe(0)
    expect(after.find((d) => d.dayKey === '2026-10-05')?.count).toBe(1)
  })
})
