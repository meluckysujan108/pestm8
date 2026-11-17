import { describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { useOwedHeld } from './ClientOwing'
import type * as React from 'react'

/**
 * What a client owes is first on their Jobs tab, and the tab waits for it
 * before drawing their jobs, so it never lands above them later. With the
 * line down and keeping on it doesn't wait, as what they owe isn't kept on
 * the phone (ClientJobsTab). What then comes stays off the tab until it is
 * next opened, rather than pushing their jobs down under a thumb.
 */

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))

function mounted(at: { draws: boolean; owedIn: boolean }) {
  return hookHarness.mount(() => useOwedHeld(at.draws, at.owedIn))
}

describe('what they owe on a client’s Jobs tab', () => {
  test('in as the tab first draws their jobs: drawn, and kept drawn', () => {
    const at = { draws: false, owedIn: false }
    const hook = mounted(at)
    at.owedIn = true
    hook.rerender()
    at.draws = true
    hook.rerender()
    expect(hook.current()).toBe(false)
    // A Try again whose answer is still coming doesn't take it away.
    at.owedIn = false
    hook.rerender()
    expect(hook.current()).toBe(false)
  })

  test('not in as the tab first draws their jobs: kept off, however soon it comes', () => {
    const at = { draws: true, owedIn: false }
    const hook = mounted(at)
    expect(hook.current()).toBe(true)
    at.owedIn = true
    hook.rerender()
    expect(hook.current()).toBe(true)
  })

  test('the tab opened again, with it in: drawn', () => {
    const at = { draws: true, owedIn: false }
    mounted(at).unmount()
    at.owedIn = true
    expect(mounted(at).current()).toBe(false)
  })
})
