/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { zonedDateTimeToUtc } from './lib/dates'
import type { Id } from './_generated/dataModel'

/**
 * `businessZones` and `zoneWeeks`: each business's zone, kept off its busy
 * row, and the Monday of the week each zone in use is in now, for
 * `jobs.openWork`, which answers for that week alone and never reads the
 * clock (the owner's answer to C5, 1 Nov 2026). Kept as a business is made
 * or its zone changes; each zone moved on by the cron at its own midnight,
 * not UTC's, reading only the zones in use.
 */

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type T = ReturnType<typeof testApp>

const perth = (dayKey: string, hh: number, mm = 0) =>
  zonedDateTimeToUtc(dayKey, hh, mm, 'Australia/Perth')

function zoneOf(t: T, businessId: Id<'businesses'>) {
  return t.run((ctx) =>
    ctx.db
      .query('businessZones')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect(),
  )
}

function weeks(t: T) {
  return t.run(async (ctx) =>
    (await ctx.db.query('zoneWeeks').collect()).map(({ timezone, monday }) => ({
      timezone,
      monday,
    })),
  )
}

function insertBusinesses(t: T, timezones: Array<string>) {
  return t.run(async (ctx) => {
    const made: Array<Id<'businesses'>> = []
    for (const [i, timezone] of timezones.entries()) {
      made.push(
        await ctx.db.insert('businesses', {
          name: `Pest ${i}`,
          slug: `pest-${i}`,
          state: 'WA',
          timezone,
          subscriptionStatus: 'trialing',
          createdAt: Date.now(),
        }),
      )
    }
    return made
  })
}

describe('a business’s zone and its week', () => {
  test('are kept as the business is made', async () => {
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
    expect(await zoneOf(t, business._id)).toMatchObject([
      { timezone: 'Australia/Perth' },
    ])
    expect(await weeks(t)).toEqual([
      { timezone: 'Australia/Perth', monday: '2026-11-02' },
    ])
  })

  test('two businesses in one zone share its week', async () => {
    const t = testApp()
    const one = await createActor(t, { email: 'one@pestm8.test' })
    const two = await createActor(t, { email: 'two@pestm8.test' })
    await createBusiness(t, one, 'One Pest')
    await createBusiness(t, two, 'Two Pest')
    expect(await weeks(t)).toHaveLength(1)
  })

  test('the week moves on at the zone’s own midnight, not UTC’s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(perth('2026-11-08', 23, 58))
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@pestm8.test' })
    await createBusiness(t, owner)
    expect(await weeks(t)).toEqual([
      { timezone: 'Australia/Perth', monday: '2026-11-02' },
    ])

    // Two minutes past Monday midnight in Perth: still Sunday in UTC.
    vi.setSystemTime(perth('2026-11-09', 0, 2))
    await t.mutation(internal.zoneWeeks.advance, {})
    expect(await weeks(t)).toEqual([
      { timezone: 'Australia/Perth', monday: '2026-11-09' },
    ])
  })

  test('a new zone is followed at once, and the zone left goes with its last business', async () => {
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
    expect(await zoneOf(t, businessId)).toMatchObject([
      { timezone: 'Pacific/Pago_Pago' },
    ])
    expect(await weeks(t)).toEqual([
      { timezone: 'Pacific/Pago_Pago', monday: '2026-11-02' },
    ])
  })

  test('a zone another business is still in keeps its week', async () => {
    const t = testApp()
    const one = await createActor(t, { email: 'one@pestm8.test' })
    const two = await createActor(t, { email: 'two@pestm8.test' })
    await createBusiness(t, one, 'One Pest')
    const { businessId } = await createBusiness(t, two, 'Two Pest')
    await two.as.mutation(api.businesses.update, {
      businessId,
      timezone: 'Australia/Sydney',
    })
    expect((await weeks(t)).map((week) => week.timezone).sort()).toEqual([
      'Australia/Perth',
      'Australia/Sydney',
    ])
  })

  test('is kept by the calendar’s own name for it, however it was typed, and openWork answers by it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(perth('2026-11-04', 10))
    const t = testApp()
    const one = await createActor(t, { email: 'one@pestm8.test' })
    const two = await createActor(t, { email: 'two@pestm8.test' })
    await createBusiness(t, one, 'One Pest')
    const { businessId } = await createBusiness(t, two, 'Two Pest')
    for (const timezone of [
      'australia/perth',
      'AUSTRALIA/PERTH',
      'Australia/West',
    ]) {
      await two.as.mutation(api.businesses.update, { businessId, timezone })
      expect(await zoneOf(t, businessId)).toMatchObject([
        { timezone: 'Australia/Perth' },
      ])
    }
    expect(await weeks(t)).toEqual([
      { timezone: 'Australia/Perth', monday: '2026-11-02' },
    ])
    await expect(
      two.as.query(api.jobs.openWork, { businessId, startKey: '2026-11-02' }),
    ).resolves.toMatchObject({ rows: [] })
  })

  test('no one business can hold more than one zone’s week, so a zone first used later still moves on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(perth('2026-11-04', 10))
    const t = testApp()
    const one = await createActor(t, { email: 'one@pestm8.test' })
    const two = await createActor(t, { email: 'two@pestm8.test' })
    await createBusiness(t, one, 'One Pest')
    const { businessId } = await createBusiness(t, two, 'Two Pest')
    // Every spelling of every zone the calendar knows, saved in turn.
    // ES2022's, which the project's TypeScript lib doesn't list yet.
    const intl = Intl as unknown as {
      supportedValuesOf: (key: 'timeZone') => Array<string>
    }
    const spellings = intl
      .supportedValuesOf('timeZone')
      .flatMap((zone) => [zone, zone.toLowerCase(), zone.toUpperCase()])
    for (const timezone of spellings) {
      await two.as.mutation(api.businesses.update, { businessId, timezone })
      expect((await weeks(t)).length).toBeLessThanOrEqual(2)
    }
    const three = await createActor(t, { email: 'three@pestm8.test' })
    const { businessId: third } = await createBusiness(t, three, 'Three Pest')
    await three.as.mutation(api.businesses.update, {
      businessId: third,
      timezone: 'Australia/Darwin',
    })
    vi.setSystemTime(perth('2026-11-09', 10))
    await t.mutation(internal.zoneWeeks.advance, {})
    expect(await weeks(t)).toEqual(
      expect.arrayContaining([
        { timezone: 'Australia/Perth', monday: '2026-11-09' },
        { timezone: 'Australia/Darwin', monday: '2026-11-09' },
      ]),
    )
  })

  test('a zone the calendar doesn’t know gets no week, and never stops the business being saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@pestm8.test' })
    const { businessId } = await createBusiness(t, owner)
    await owner.as.mutation(api.businesses.update, {
      businessId,
      timezone: 'Perth',
    })
    expect(await zoneOf(t, businessId)).toMatchObject([{ timezone: 'Perth' }])
    // Its last business has left Perth's.
    expect(await weeks(t)).toEqual([])
    expect(warn).toHaveBeenCalledWith('zoneWeeks: not a time zone', {
      businessId,
    })
  })

  test('the backfill keeps every business made before, a page at a time, past one with a zone it doesn’t know', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(perth('2026-11-04', 10))
    const t = testApp()
    const zones = Array.from({ length: 230 }, (_, i) =>
      i === 5 ? 'Perth' : i % 2 ? 'Australia/Sydney' : 'Australia/Perth',
    )
    const ids = await insertBusinesses(t, zones)
    await t.mutation(internal.zoneWeeks.backfill, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const kept = await t.run((ctx) => ctx.db.query('businessZones').collect())
    expect(kept.map((zone) => zone.businessId).sort()).toEqual([...ids].sort())
    expect(
      (await weeks(t)).sort((a, b) => a.timezone.localeCompare(b.timezone)),
    ).toEqual([
      { timezone: 'Australia/Perth', monday: '2026-11-02' },
      { timezone: 'Australia/Sydney', monday: '2026-11-02' },
    ])
  })

  test('the cron reads the zones in use, not the businesses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(perth('2026-11-04', 10))
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@pestm8.test' })
    await createBusiness(t, owner)
    // Businesses with no zone kept: the cron never makes one.
    await insertBusinesses(t, ['Australia/Sydney', 'Australia/Darwin'])
    vi.setSystemTime(perth('2026-11-09', 10))
    await t.mutation(internal.zoneWeeks.advance, {})
    expect(await weeks(t)).toEqual([
      { timezone: 'Australia/Perth', monday: '2026-11-09' },
    ])
  })
})
