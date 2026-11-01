/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { zonedDateTimeToUtc } from './lib/dates'
import type { Id } from './_generated/dataModel'

/**
 * `businessWeeks`: each business's zone and the Monday of the week it is in
 * now, for `jobs.openWork`, which answers for that week alone and never
 * reads the clock (the owner's answer to C5, 1 Nov 2026). Made with the
 * business, kept by its zone, and moved on by the cron at the business's
 * own midnight, not UTC's.
 */

afterEach(() => {
  vi.useRealTimers()
})

const perth = (dayKey: string, hh: number, mm = 0) =>
  zonedDateTimeToUtc(dayKey, hh, mm, 'Australia/Perth')

function weekOf(t: ReturnType<typeof testApp>, businessId: Id<'businesses'>) {
  return t.run((ctx) =>
    ctx.db
      .query('businessWeeks')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect(),
  )
}

describe('a business’s week', () => {
  test('is made with the business', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(perth('2026-11-04', 10))
    const t = testApp()
    const jo = await createActor(t, { email: 'jo@new.test' })
    await jo.as.mutation(api.businesses.create, {
      name: 'New Pest',
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    const [business] = await t.run((ctx) =>
      ctx.db.query('businesses').collect(),
    )
    expect(await weekOf(t, business._id)).toMatchObject([
      { timezone: 'Australia/Perth', monday: '2026-11-02' },
    ])
  })

  test('moves on at the business’s own midnight, not UTC’s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(perth('2026-11-08', 23, 58))
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@pestm8.test' })
    const { businessId } = await createBusiness(t, owner)
    expect(await weekOf(t, businessId)).toMatchObject([
      { monday: '2026-11-02' },
    ])

    // Two minutes past Monday midnight in Perth: still Sunday in UTC.
    vi.setSystemTime(perth('2026-11-09', 0, 2))
    await t.mutation(internal.businessWeeks.advance, {})
    expect(await weekOf(t, businessId)).toMatchObject([
      { monday: '2026-11-09' },
    ])
  })

  test('follows a new zone at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Monday 1am in Perth is still Sunday morning in Pago Pago (UTC−11).
    vi.setSystemTime(perth('2026-11-09', 1))
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@pestm8.test' })
    const { businessId } = await createBusiness(t, owner)
    await owner.as.mutation(api.businesses.update, {
      businessId,
      timezone: 'Pacific/Pago_Pago',
    })
    expect(await weekOf(t, businessId)).toMatchObject([
      { timezone: 'Pacific/Pago_Pago', monday: '2026-11-02' },
    ])
  })

  test('the cron reaches every business, a page at a time, and makes any week missing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(perth('2026-11-04', 10))
    const t = testApp()
    const ids = await t.run(async (ctx) => {
      const made: Array<Id<'businesses'>> = []
      for (let i = 0; i < 230; i++) {
        made.push(
          await ctx.db.insert('businesses', {
            name: `Pest ${i}`,
            slug: `pest-${i}`,
            state: 'WA',
            timezone: 'Australia/Perth',
            subscriptionStatus: 'trialing',
            createdAt: Date.now(),
          }),
        )
      }
      return made
    })
    await t.mutation(internal.businessWeeks.advance, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const weeks = await t.run((ctx) => ctx.db.query('businessWeeks').collect())
    expect(weeks.map((week) => week.businessId).sort()).toEqual([...ids].sort())
    expect(new Set(weeks.map((week) => week.monday))).toEqual(
      new Set(['2026-11-02']),
    )
  })
})
