import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { hookHarness } from './offline/hooks.fixtures'
import {
  KEPT_NOTES,
  forgetConnectionLogForTests,
  logConnection,
  unsentConnectionLog,
} from './connectionLog'
import { usePickerList } from './usePickerList'
import { withSearchKeys } from './searchMatch'
import type * as React from 'react'

// React's hooks run here by the harness: there is no document to render into.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('./offline/hooks.fixtures')).hookHarness.hooks,
}))

/**
 * What a slow picker leaves in the phone's own notes (the matching plan's
 * §2.12), with the notes themselves, not a stand-in: they are the 300 kept
 * that are read when a phone "just hangs" (`diagnostics:recent`), and a
 * note a key would push the socket's and sign-in's out before they are
 * sent.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(1_000)
  const held = new Map<string, string>()
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  )
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  })
  forgetConnectionLogForTests()
})

afterEach(() => {
  hookHarness.mount(() => null)
  forgetConnectionLogForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const SITES = [
  withSearchKeys({
    value: 'p-jane',
    label: 'Jane Nguyen — 12 Wattle St, Bayswater',
  }),
  withSearchKeys({ value: 'p-bob', label: 'Bob Lee — 4 Hay St, Perth' }),
]

test('a slow picker typed into notes how slow once, not once a key', () => {
  // The list as it opens, and at each key, takes 40 to 49 ms: a big book
  // on an old phone.
  const took: Array<number> = []
  for (let key = 0; key < 10; key++) {
    took.push(1_000 * key, 1_000 * key + 40 + key)
  }
  vi.spyOn(performance, 'now').mockImplementation(() => took.shift() ?? 0)

  logConnection('ws-close', { code: 1006 })
  const typed = '12 Wattle'
  const now = { query: '' }
  const hook = hookHarness.mount(() =>
    usePickerList({
      open: true,
      rows: SITES,
      query: now.query,
      allowCustom: false,
    }),
  )
  for (let n = 1; n <= typed.length; n++) {
    now.query = typed.slice(0, n)
    hook.rerender()
  }

  expect(unsentConnectionLog(KEPT_NOTES)!.entries).toEqual([
    { t: 1_000, e: 'ws-close', d: { code: 1006 } },
    { t: 1_000, e: 'picker-filter', d: { rows: 2, ms: 32 } },
  ])
})
