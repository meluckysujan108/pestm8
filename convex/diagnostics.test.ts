/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, testApp } from '../test/harness'

/**
 * A phone's connection notes (src/lib/connectionLog.ts): sent in by the
 * person signed in on it, kept for thirty days, and readable only from the
 * command line.
 */

const report = (entries: Array<{ t: number; e: string; d?: object }>) => ({
  device: 'phone-1',
  app: 'abc1234',
  standalone: true,
  agent: 'Mozilla/5.0 (iPhone)',
  entries: entries as Array<{
    t: number
    e: string
    d?: Record<string, string | number | boolean>
  }>,
})

describe('diagnostics', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('keeps a report as the person who sent it, and nobody else can send one', async () => {
    const t = testApp()
    const terence = await createActor(t, {
      email: 'terence@coastalpest.test',
    })

    await terence.as.mutation(
      api.diagnostics.report,
      report([
        { t: 1, e: 'shown', d: { away: 30_000 } },
        { t: 2, e: 'ws-dead', d: { why: 'silent' } },
      ]),
    )
    const rows = await t.run((ctx) =>
      ctx.db.query('clientDiagnostics').collect(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: terence.userId,
      device: 'phone-1',
      standalone: true,
      entries: [
        { t: 1, e: 'shown', d: { away: 30_000 } },
        { t: 2, e: 'ws-dead', d: { why: 'silent' } },
      ],
    })

    await expect(
      t.mutation(api.diagnostics.report, report([{ t: 3, e: 'shown' }])),
    ).rejects.toThrow()
  })

  test('cuts an oversized report down rather than refusing it', async () => {
    const t = testApp()
    const kevin = await createActor(t, { email: 'kevin@kp.test' })
    const long = 'x'.repeat(500)
    const details = Object.fromEntries(
      Array.from({ length: 12 }, (_, n) => [`k${n}`, long]),
    )

    await kevin.as.mutation(api.diagnostics.report, {
      ...report(
        Array.from({ length: 150 }, (_, n) => ({ t: n, e: long, d: details })),
      ),
      agent: long,
    })

    const rows = await t.run((ctx) =>
      ctx.db.query('clientDiagnostics').collect(),
    )
    expect(rows).toHaveLength(1)
    const [{ entries, agent }] = rows
    expect(entries).toHaveLength(100)
    expect(entries[0].e).toHaveLength(40)
    expect(Object.keys(entries[0].d ?? {})).toHaveLength(8)
    expect(String(entries[0].d?.k0)).toHaveLength(120)
    expect(agent).toHaveLength(300)
  })

  test('refuses a second report within thirty seconds, so a page in a loop cannot fill the table', async () => {
    vi.useFakeTimers()
    const t = testApp()
    const jo = await createActor(t, { email: 'jo@jospest.test' })
    await jo.as.mutation(api.diagnostics.report, report([{ t: 1, e: 'a' }]))

    vi.advanceTimersByTime(29_000)
    await expect(
      jo.as.mutation(api.diagnostics.report, report([{ t: 2, e: 'b' }])),
    ).rejects.toThrow('TOO_SOON')

    vi.advanceTimersByTime(1_000)
    await jo.as.mutation(api.diagnostics.report, report([{ t: 2, e: 'b' }]))
    const rows = await t.run((ctx) =>
      ctx.db.query('clientDiagnostics').collect(),
    )
    expect(rows).toHaveLength(2)
  })

  test('drops a note with no real time, so the notes can always be read', async () => {
    const t = testApp()
    const kevin = await createActor(t, { email: 'kevin@kp.test' })
    await kevin.as.mutation(
      api.diagnostics.report,
      report([
        { t: Number.NaN, e: 'bad' },
        { t: 1e16, e: 'too-far' },
        { t: Date.UTC(2026, 9, 25), e: 'shown' },
      ]),
    )

    const [row] = await t.query(internal.diagnostics.recent, { hours: 1 })
    expect(row.entries).toEqual([
      { at: '2026-10-25T00:00:00.000Z', e: 'shown' },
    ])
  })

  test('forgets reports after thirty days', async () => {
    vi.useFakeTimers()
    const t = testApp()
    const terence = await createActor(t, {
      email: 'terence@coastalpest.test',
    })
    await terence.as.mutation(
      api.diagnostics.report,
      report([{ t: 1, e: 'old' }]),
    )
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000)
    // Signed in since: the test's sessions last an hour.
    const kevin = await createActor(t, { email: 'kevin@kp.test' })
    await kevin.as.mutation(
      api.diagnostics.report,
      report([{ t: 2, e: 'recent' }]),
    )

    await t.mutation(internal.diagnostics.prune, {})

    const left = await t.run((ctx) =>
      ctx.db.query('clientDiagnostics').collect(),
    )
    expect(left.map((row) => row.entries[0]?.e)).toEqual(['recent'])
  })

  test('reads the newest reports, or one person’s by email', async () => {
    const t = testApp()
    const terence = await createActor(t, {
      email: 'terence@coastalpest.test',
    })
    const kevin = await createActor(t, { email: 'kevin@kp.test' })
    await terence.as.mutation(
      api.diagnostics.report,
      report([{ t: Date.UTC(2026, 9, 25), e: 'shown' }]),
    )
    await kevin.as.mutation(
      api.diagnostics.report,
      report([{ t: Date.UTC(2026, 9, 25), e: 'ws-dead' }]),
    )

    const everyone = await t.query(internal.diagnostics.recent, { hours: 1 })
    expect(everyone).toHaveLength(2)

    const one = await t.query(internal.diagnostics.recent, {
      hours: 1,
      email: 'Terence@CoastalPest.test',
    })
    expect(one).toHaveLength(1)
    expect(one[0]?.entries).toEqual([
      { at: '2026-10-25T00:00:00.000Z', e: 'shown' },
    ])

    expect(
      await t.query(internal.diagnostics.recent, {
        hours: 1,
        email: 'nobody@example.test',
      }),
    ).toEqual([])
  })
})
