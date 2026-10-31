import { afterEach, describe, expect, test, vi } from 'vitest'

/**
 * The switch for keeping new bookings on the phone: off unless the build
 * says `VITE_PESTM8_OUTBOX=on`, until the outbox is switched on for good.
 * So New Job, on Vercel and in Playwright's own build, sends straight as it
 * always has, with its request id.
 */

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('OUTBOX_ENABLED', () => {
  test('is off in a build with no flag', async () => {
    vi.stubEnv('VITE_PESTM8_OUTBOX', '')
    vi.resetModules()
    const { OUTBOX_ENABLED } = await import('./outboxSet')
    expect(OUTBOX_ENABLED).toBe(false)
  })

  test.each(['off', 'true', '1', 'ON'])('is off for %s', async (flag) => {
    vi.stubEnv('VITE_PESTM8_OUTBOX', flag)
    vi.resetModules()
    const { OUTBOX_ENABLED } = await import('./outboxSet')
    expect(OUTBOX_ENABLED).toBe(false)
  })

  test('is on in a build made with VITE_PESTM8_OUTBOX=on', async () => {
    vi.stubEnv('VITE_PESTM8_OUTBOX', 'on')
    vi.resetModules()
    const { OUTBOX_ENABLED } = await import('./outboxSet')
    expect(OUTBOX_ENABLED).toBe(true)
  })
})
