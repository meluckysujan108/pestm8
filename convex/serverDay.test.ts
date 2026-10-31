/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { internal } from './_generated/api'
import { testApp } from '../test/harness'

/**
 * `serverDay.advance`: the hourly cron's one row, today's date in UTC, for
 * `jobs.openWork`, which may answer only near today and never reads the
 * clock. Written only when the day changes, so what reads it runs again
 * once a day.
 */

afterEach(() => {
  vi.useRealTimers()
})

function rows(t: ReturnType<typeof testApp>) {
  return t.run((ctx) => ctx.db.query('serverDay').collect())
}

describe('the server’s day', () => {
  test('is written on the first run, and moves on at UTC midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = testApp()
    // 7:30am in Perth on Monday is still Sunday 23:30 in UTC.
    vi.setSystemTime(new Date('2026-11-08T23:30:00Z'))
    await t.mutation(internal.serverDay.advance, {})
    expect(await rows(t)).toMatchObject([{ utcDay: '2026-11-08' }])

    vi.setSystemTime(new Date('2026-11-09T00:02:00Z'))
    await t.mutation(internal.serverDay.advance, {})
    expect(await rows(t)).toMatchObject([{ utcDay: '2026-11-09' }])
  })

  test('is one row, the same all day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = testApp()
    vi.setSystemTime(new Date('2026-11-04T01:02:00Z'))
    await t.mutation(internal.serverDay.advance, {})
    const [first] = await rows(t)
    vi.setSystemTime(new Date('2026-11-04T23:02:00Z'))
    await t.mutation(internal.serverDay.advance, {})
    expect(await rows(t)).toEqual([first])
  })
})
