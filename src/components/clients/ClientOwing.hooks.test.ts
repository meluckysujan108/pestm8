import { describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { useOwedGate } from './ClientOwing'
import type * as React from 'react'

/**
 * What a client owes is first on their Jobs tab, and the tab waits for it
 * before drawing their jobs, so it never lands above them later. With the
 * line down and keeping on it doesn't wait, as what they owe isn't kept on
 * the phone (ClientJobsTab). Drawn without it, the tab stays drawn when the
 * line comes back before the answer does, and what they owe stays off until
 * the tab is next opened, rather than pushing their jobs down under a thumb.
 */

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))

type At = { jobsIn: boolean; owedIn: boolean; waitsOut: boolean }

function mounted(at: At) {
  return hookHarness.mount(() => useOwedGate({ ...at }))
}

describe('a client’s Jobs tab and what they owe', () => {
  test('waits for it with the line up, then draws with it, and keeps it drawn', () => {
    const at = { jobsIn: false, owedIn: false, waitsOut: false }
    const hook = mounted(at)
    at.jobsIn = true
    hook.rerender()
    expect(hook.current()).toEqual({ draws: false, owedShown: false })
    at.owedIn = true
    hook.rerender()
    expect(hook.current()).toEqual({ draws: true, owedShown: true })
    // The line going down changes nothing.
    at.waitsOut = true
    hook.rerender()
    expect(hook.current()).toEqual({ draws: true, owedShown: true })
  })

  test('with the line down, draws without it at once', () => {
    const hook = mounted({ jobsIn: true, owedIn: false, waitsOut: true })
    expect(hook.current()).toEqual({ draws: true, owedShown: false })
  })

  test('drawn without it, stays drawn when the line comes back before the answer, which then stays off', () => {
    const at = { jobsIn: true, owedIn: false, waitsOut: true }
    const hook = mounted(at)
    at.waitsOut = false
    hook.rerender()
    expect(hook.current()).toEqual({ draws: true, owedShown: false })
    at.owedIn = true
    hook.rerender()
    expect(hook.current()).toEqual({ draws: true, owedShown: false })
  })

  test('the line dropping before their jobs are in: drawn without it once they are', () => {
    const at = { jobsIn: false, owedIn: false, waitsOut: true }
    const hook = mounted(at)
    expect(hook.current().draws).toBe(false)
    at.jobsIn = true
    hook.rerender()
    expect(hook.current()).toEqual({ draws: true, owedShown: false })
  })

  test('opened again, with it in: drawn with it', () => {
    const at = { jobsIn: true, owedIn: false, waitsOut: true }
    mounted(at).unmount()
    at.owedIn = true
    at.waitsOut = false
    expect(mounted(at).current()).toEqual({ draws: true, owedShown: true })
  })

  test('keeping off (never waiting it out): waits for it whatever the line, as on main', () => {
    const at = { jobsIn: true, owedIn: false, waitsOut: false }
    const hook = mounted(at)
    expect(hook.current().draws).toBe(false)
    at.owedIn = true
    hook.rerender()
    expect(hook.current()).toEqual({ draws: true, owedShown: true })
  })
})
